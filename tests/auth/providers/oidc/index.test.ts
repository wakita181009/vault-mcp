import { afterEach, describe, expect, it, vi } from "vitest";
import { oidcProvider } from "../../../../src/auth/providers/oidc";

const asEnv = (env: Record<string, unknown>) => env as unknown as Env;

describe("oidcProvider", () => {
	afterEach(() => vi.unstubAllGlobals());

	const ISSUER = "https://idp.example/provider-test";
	const discovery = {
		issuer: ISSUER,
		authorization_endpoint: `${ISSUER}/authorize`,
		token_endpoint: `${ISSUER}/token`,
		userinfo_endpoint: `${ISSUER}/userinfo`,
	};
	const baseEnv = {
		OIDC_ISSUER_URL: ISSUER,
		OIDC_CLIENT_ID: "ocid",
		OIDC_CLIENT_SECRET: "osecret",
		VAULT_ALLOWED_OIDC_EMAILS: "Alice@Example.com",
	};

	const stubIdp = (userinfo: unknown, status = 200) => {
		const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
			String(url).includes("well-known")
				? Response.json(discovery)
				: Response.json(userinfo, { status }),
		);
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	};

	it("reads the client credentials and lowercased allowlist from env", () => {
		expect(oidcProvider.credentials(asEnv(baseEnv))).toEqual({
			clientId: "ocid",
			clientSecret: "osecret",
		});
		expect(oidcProvider.allowedLogins(asEnv(baseEnv))).toEqual(["alice@example.com"]);
	});

	it("yields empty credentials when the OIDC keys are unset", () => {
		expect(oidcProvider.credentials(asEnv({}))).toEqual({ clientId: "", clientSecret: "" });
	});

	it("defaults the display name and lets env override it", () => {
		expect(oidcProvider.displayName(asEnv({}))).toBe("OpenID");
		expect(oidcProvider.displayName(asEnv({ OIDC_DISPLAY_NAME: "Acme SSO" }))).toBe("Acme SSO");
	});

	it("requests the openid scope", () => {
		expect(oidcProvider.scope).toBe("openid email profile");
	});

	it("rejects endpoint resolution when no issuer is configured", async () => {
		await expect(oidcProvider.endpoints(asEnv({}))).rejects.toThrow(/OIDC_ISSUER_URL/);
	});

	it("resolves the OAuth endpoints through discovery", async () => {
		stubIdp({});
		await expect(oidcProvider.endpoints(asEnv(baseEnv))).resolves.toEqual({
			authorizeUrl: `${ISSUER}/authorize`,
			tokenUrl: `${ISSUER}/token`,
		});
	});

	it("fetches the identity from the discovered userinfo endpoint", async () => {
		const fetchMock = stubIdp({ email: "Alice@Example.com", email_verified: true, name: "Alice" });
		const identity = await oidcProvider.fetchIdentity("tok", asEnv(baseEnv));
		expect(identity).toEqual({ login: "alice@example.com", email: "alice@example.com", name: "Alice" });
		const userinfoCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/userinfo"));
		expect(userinfoCall).toBeDefined();
		const init = userinfoCall?.[1] as RequestInit;
		expect(init.redirect).toBe("error");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("rejects an email with no verified flag by default", async () => {
		stubIdp({ email: "alice@example.com" });
		await expect(oidcProvider.fetchIdentity("tok", asEnv(baseEnv))).rejects.toThrow(
			/not verified/,
		);
	});

	it("accepts an email with no verified flag when the opt-in is set", async () => {
		stubIdp({ email: "alice@example.com" });
		const env = asEnv({ ...baseEnv, OIDC_ALLOW_UNVERIFIED_EMAIL: "true" });
		await expect(oidcProvider.fetchIdentity("tok", env)).resolves.toMatchObject({
			login: "alice@example.com",
		});
	});

	it("still rejects an explicitly unverified email when the opt-in is set", async () => {
		stubIdp({ email: "alice@example.com", email_verified: false });
		const env = asEnv({ ...baseEnv, OIDC_ALLOW_UNVERIFIED_EMAIL: "true" });
		await expect(oidcProvider.fetchIdentity("tok", env)).rejects.toThrow(/not verified/);
	});

	it("names the provider in userinfo errors", async () => {
		stubIdp({ error: "invalid_token" }, 401);
		const env = asEnv({ ...baseEnv, OIDC_DISPLAY_NAME: "Acme SSO" });
		await expect(oidcProvider.fetchIdentity("tok", env)).rejects.toThrow(/Acme SSO.*401/);
	});
});
