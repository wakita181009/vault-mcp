import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { z } from "zod";
import { renderApprovalDialog } from "./approval-dialog";
import { type UpstreamProvider, UpstreamIdentityError } from "./providers";
import {
	fetchUpstreamAuthToken,
	getUpstreamAuthorizeUrl,
	redirectResponse,
	type Props,
} from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/**
 * The login flow between the MCP client and the upstream identity provider.
 * Everything here is provider-agnostic; `provider` supplies the endpoints,
 * credentials, and identity lookup (see `providers/`).
 */
export function createAuthHandler(provider: UpstreamProvider): Hono<{ Bindings: AuthEnv }> {
	const app = new Hono<{ Bindings: AuthEnv }>();

	// Endpoint resolution can hit the network (OIDC discovery), so it runs
	// *before* any OAuth state is created or consumed: a failure then costs the
	// user nothing but a retry, instead of orphaning KV state or burning the
	// one-shot state on the callback.
	const resolveEndpoints = async (
		env: Env,
	): Promise<[Awaited<ReturnType<UpstreamProvider["endpoints"]>>, null] | [null, Response]> => {
		try {
			return [await provider.endpoints(env), null];
		} catch (error) {
			console.error("Upstream endpoint resolution failed:", error);
			return [null, new Response("Login provider unavailable", { status: 502 })];
		}
	};

	const redirectToUpstream = (
		env: Env,
		request: Request,
		authorizeUrl: string,
		stateToken: string,
		headers: HeadersInit,
	) =>
		redirectResponse(
			getUpstreamAuthorizeUrl({
				client_id: provider.credentials(env).clientId,
				redirect_uri: new URL("/callback", request.url).href,
				scope: provider.scope,
				state: stateToken,
				upstream_url: authorizeUrl,
			}),
			headers,
		);

	app.get("/authorize", async (c) => {
		const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
		const { clientId } = oauthReqInfo;
		if (!clientId) {
			return c.text("Invalid request", 400);
		}

		// Already approved: skip the dialog, but still bind state to the session.
		if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
			const [endpoints, unavailable] = await resolveEndpoints(c.env);
			if (unavailable) return unavailable;
			const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
			const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
			return redirectToUpstream(c.env, c.req.raw, endpoints.authorizeUrl, stateToken, {
				"Set-Cookie": sessionBindingCookie,
			});
		}

		const { token: csrfToken, setCookie } = generateCSRFProtection();

		return renderApprovalDialog(c.req.raw, {
			client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
			csrfToken,
			server: {
				description: `Remote MCP for a private Obsidian vault (read, create, update, and delete notes). Sign in with ${provider.displayName(c.env)} to connect.`,
				logo: provider.logo,
				name: "Vault MCP",
			},
			setCookie,
			state: { oauthReqInfo },
		});
	});

	app.post("/authorize", async (c) => {
		try {
			const formData = await c.req.raw.formData();
			validateCSRFToken(formData, c.req.raw);

			const encodedState = formData.get("state");
			if (!encodedState || typeof encodedState !== "string") {
				return c.text("Missing state in form data", 400);
			}

			let state: { oauthReqInfo?: AuthRequest };
			try {
				state = JSON.parse(atob(encodedState));
			} catch (_e) {
				return c.text("Invalid state data", 400);
			}

			if (!state.oauthReqInfo?.clientId) {
				return c.text("Invalid request", 400);
			}

			const [endpoints, unavailable] = await resolveEndpoints(c.env);
			if (unavailable) return unavailable;

			const approvedClientCookie = await addApprovedClient(
				c.req.raw,
				state.oauthReqInfo.clientId,
				c.env.COOKIE_ENCRYPTION_KEY,
			);

			const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
			const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

			const headers = new Headers();
			headers.append("Set-Cookie", approvedClientCookie);
			headers.append("Set-Cookie", sessionBindingCookie);

			return redirectToUpstream(c.env, c.req.raw, endpoints.authorizeUrl, stateToken, headers);
		} catch (error) {
			console.error("POST /authorize error:", error);
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			const message = error instanceof Error ? error.message : String(error);
			return c.text(`Internal server error: ${message}`, 500);
		}
	});

	/**
	 * Upstream OAuth callback: exchanges the code for an access token, resolves
	 * the user's identity, stores it on the client's `props`, and redirects to
	 * the client's own callback. validateOAuthState guards against CSRF (see
	 * workers-oauth-utils).
	 */
	app.get("/callback", async (c) => {
		const [endpoints, unavailable] = await resolveEndpoints(c.env);
		if (unavailable) return unavailable;

		let oauthReqInfo: AuthRequest;
		let clearSessionCookie: string;

		try {
			const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
			oauthReqInfo = result.oauthReqInfo;
			clearSessionCookie = result.clearCookie;
		} catch (error) {
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			return c.text("Internal server error", 500);
		}

		if (!oauthReqInfo.clientId) {
			return c.text("Invalid OAuth request data", 400);
		}

		// The provider sends ?code=... on a successful authorization; reject early
		// at the boundary if it is missing or empty instead of passing undefined downstream.
		const codeResult = z.string().min(1).safeParse(c.req.query("code"));
		if (!codeResult.success) {
			return c.text("Missing authorization code", 400);
		}

		const { clientId, clientSecret } = provider.credentials(c.env);
		const [accessToken, errResponse] = await fetchUpstreamAuthToken({
			client_id: clientId,
			client_secret: clientSecret,
			code: codeResult.data,
			redirect_uri: new URL("/callback", c.req.url).href,
			upstream_url: endpoints.tokenUrl,
		});
		if (errResponse) return errResponse;

		let identity: Awaited<ReturnType<UpstreamProvider["fetchIdentity"]>>;
		try {
			identity = await provider.fetchIdentity(accessToken, c.env);
		} catch (error) {
			if (error instanceof UpstreamIdentityError) {
				return c.text(error.message, 403);
			}
			throw error;
		}
		const { login, name, email } = identity;

		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			metadata: {
				label: name,
			},
			// Surfaced as `this.props` on VaultMCP.
			props: {
				accessToken,
				email,
				login,
				name,
			} as Props,
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId: login,
		});

		return new Response(null, {
			status: 302,
			headers: { Location: redirectTo, "Set-Cookie": clearSessionCookie },
		});
	});

	return app;
}
