import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { z } from "zod";
import { isLoginAllowed } from "../guard";
import { renderApprovalDialog } from "./approval-dialog";
import {
	type OAuthEndpoints,
	type UpstreamIdentity,
	type UpstreamProvider,
	UpstreamIdentityError,
} from "./providers";
import type { Props } from "./props";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	validateCSRFToken,
	validateOAuthState,
} from "./session";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, redirectResponse } from "./upstream";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const CALLBACK_PATH = "/callback";

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
	): Promise<[OAuthEndpoints, null] | [null, Response]> => {
		try {
			return [await provider.endpoints(env), null];
		} catch (error) {
			console.error("Upstream endpoint resolution failed:", error);
			return [null, new Response("Login provider unavailable", { status: 502 })];
		}
	};

	/** `cookies` are extra Set-Cookie values to send alongside the session binding. */
	const startUpstreamFlow = async (
		env: AuthEnv,
		request: Request,
		oauthReqInfo: AuthRequest,
		cookies: string[] = [],
	): Promise<Response> => {
		const [endpoints, unavailable] = await resolveEndpoints(env);
		if (unavailable) return unavailable;

		const stateToken = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
		const headers = new Headers();
		for (const cookie of [...cookies, await bindStateToSession(stateToken)]) {
			headers.append("Set-Cookie", cookie);
		}
		return redirectResponse(
			getUpstreamAuthorizeUrl({
				client_id: provider.credentials(env).clientId,
				redirect_uri: new URL(CALLBACK_PATH, request.url).href,
				scope: provider.scope,
				state: stateToken,
				upstream_url: endpoints.authorizeUrl,
			}),
			headers,
		);
	};

	app.get("/authorize", async (c) => {
		const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
		const { clientId } = oauthReqInfo;
		if (!clientId) {
			return c.text("Invalid request", 400);
		}

		// Already approved: skip the dialog, but still bind state to the session.
		if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
			return startUpstreamFlow(c.env, c.req.raw, oauthReqInfo);
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

			const approvedClientCookie = await addApprovedClient(
				c.req.raw,
				state.oauthReqInfo.clientId,
				c.env.COOKIE_ENCRYPTION_KEY,
			);
			// `await` keeps a KV failure inside this try so it maps to the 500 below.
			return await startUpstreamFlow(c.env, c.req.raw, state.oauthReqInfo, [approvedClientCookie]);
		} catch (error) {
			console.error("POST /authorize error:", error);
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			// The details are in the log above; the browser gets nothing internal.
			return c.text("Internal server error", 500);
		}
	});

	app.get(CALLBACK_PATH, async (c) => {
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

		const codeResult = z.string().min(1).safeParse(c.req.query("code"));
		if (!codeResult.success) {
			return c.text("Missing authorization code", 400);
		}

		const { clientId, clientSecret } = provider.credentials(c.env);
		const [accessToken, errResponse] = await fetchUpstreamAuthToken({
			client_id: clientId,
			client_secret: clientSecret,
			code: codeResult.data,
			redirect_uri: new URL(CALLBACK_PATH, c.req.url).href,
			upstream_url: endpoints.tokenUrl,
		});
		if (errResponse) return errResponse;

		let identity: UpstreamIdentity;
		try {
			identity = await provider.fetchIdentity(accessToken, c.env);
		} catch (error) {
			if (error instanceof UpstreamIdentityError) {
				return c.text(error.message, 403);
			}
			throw error;
		}
		const { login, name, email } = identity;

		// Any upstream account can finish the upstream login, so refuse the grant
		// here rather than storing one the MCP guard would only reject later. The
		// guard still re-checks every request, so removing a login takes effect at
		// once for grants already issued.
		if (!isLoginAllowed(login, provider.allowedLogins(c.env))) {
			return c.text("This account is not allowed to access this vault", 403);
		}

		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			metadata: {
				label: name,
			},
			// Surfaced as `ctx.props` to the guarded MCP handler.
			props: {
				email,
				login,
				name,
			} satisfies Props,
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId: login,
		});

		return redirectResponse(redirectTo, { "Set-Cookie": clearSessionCookie });
	});

	return app;
}
