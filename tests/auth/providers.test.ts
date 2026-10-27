import { afterEach, describe, expect, it, vi } from "vitest";
import { authProviderFromEnv, UpstreamIdentityError } from "../../src/auth/providers";
import { githubProvider } from "../../src/auth/providers/github";
import { googleProvider } from "../../src/auth/providers/google";
import { oidcProvider } from "../../src/auth/providers/oidc";

const asEnv = (env: Record<string, unknown>) => env as unknown as Env;

describe("authProviderFromEnv", () => {
	it("defaults to GitHub", () => {
		expect(authProviderFromEnv({})).toBe(githubProvider);
	});

	it("selects Google", () => {
		expect(authProviderFromEnv({ AUTH_PROVIDER: "google" })).toBe(googleProvider);
	});

	it("selects the generic OIDC provider", () => {
		expect(authProviderFromEnv({ AUTH_PROVIDER: "oidc" })).toBe(oidcProvider);
	});

	it("throws on an unknown provider", () => {
		expect(() => authProviderFromEnv({ AUTH_PROVIDER: "okta" } as never)).toThrow(
			/AUTH_PROVIDER/,
		);
	});
});

describe("githubProvider", () => {
	it("reads the GitHub OAuth app credentials and allowlist from env", () => {
		const env = asEnv({
			GITHUB_CLIENT_ID: "cid",
			GITHUB_CLIENT_SECRET: "secret",
			VAULT_ALLOWED_GITHUB_LOGINS: "alice, bob",
		});
		expect(githubProvider.credentials(env)).toEqual({ clientId: "cid", clientSecret: "secret" });
		expect(githubProvider.allowedLogins(env)).toEqual(["alice", "bob"]);
	});

	it("yields empty credentials when the GitHub OAuth app keys are unset", () => {
		expect(githubProvider.credentials(asEnv({}))).toEqual({ clientId: "", clientSecret: "" });
	});

	it("exposes its static endpoints", async () => {
		await expect(githubProvider.endpoints(asEnv({}))).resolves.toEqual({
			authorizeUrl: "https://github.com/login/oauth/authorize",
			tokenUrl: "https://github.com/login/oauth/access_token",
		});
	});
});

describe("googleProvider", () => {
	afterEach(() => vi.unstubAllGlobals());

	const env = asEnv({});

	const stubUserinfo = (body: unknown, status = 200) => {
		const fetchMock = vi.fn(async () => Response.json(body, { status }));
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	};

	it("sends the access token as a bearer and lowercases the email", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ email: "Alice@Example.com", email_verified: true, name: "Alice" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const identity = await googleProvider.fetchIdentity("tok", env);
		expect(identity).toEqual({ login: "alice@example.com", email: "alice@example.com", name: "Alice" });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
	});

	it("falls back to the email as the display name", async () => {
		stubUserinfo({ email: "alice@example.com", email_verified: true });
		expect((await googleProvider.fetchIdentity("tok", env)).name).toBe("alice@example.com");
	});

	it("rejects an unverified email", async () => {
		stubUserinfo({ email: "alice@example.com", email_verified: false });
		await expect(googleProvider.fetchIdentity("tok", env)).rejects.toBeInstanceOf(
			UpstreamIdentityError,
		);
	});

	it("rejects an email without a verified flag even if the OIDC opt-in is set", async () => {
		stubUserinfo({ email: "alice@example.com" });
		await expect(
			googleProvider.fetchIdentity("tok", asEnv({ OIDC_ALLOW_UNVERIFIED_EMAIL: "true" })),
		).rejects.toThrow(/not verified/);
	});

	it("rejects a response without an email", async () => {
		stubUserinfo({ sub: "123" });
		await expect(googleProvider.fetchIdentity("tok", env)).rejects.toThrow(/missing an email/);
	});

	it("rejects a failed userinfo request", async () => {
		stubUserinfo({ error: "invalid_token" }, 401);
		await expect(googleProvider.fetchIdentity("tok", env)).rejects.toThrow(/401/);
	});

	it("yields empty credentials when the Google OAuth client keys are unset", () => {
		expect(googleProvider.credentials(env)).toEqual({ clientId: "", clientSecret: "" });
	});

	it("lowercases the configured allowlist", () => {
		expect(
			googleProvider.allowedLogins(asEnv({ VAULT_ALLOWED_GOOGLE_EMAILS: "Alice@Example.com" })),
		).toEqual(["alice@example.com"]);
	});

	it("uses its static endpoints without a discovery fetch", async () => {
		const fetchMock = stubUserinfo({});
		await expect(googleProvider.endpoints(env)).resolves.toEqual({
			authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

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
