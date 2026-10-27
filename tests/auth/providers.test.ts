import { afterEach, describe, expect, it, vi } from "vitest";
import { authProviderFromEnv, UpstreamIdentityError } from "../../src/auth/providers";
import { githubProvider } from "../../src/auth/providers/github";
import { googleProvider } from "../../src/auth/providers/google";

describe("authProviderFromEnv", () => {
	it("defaults to GitHub", () => {
		expect(authProviderFromEnv({})).toBe(githubProvider);
	});

	it("selects Google", () => {
		expect(authProviderFromEnv({ AUTH_PROVIDER: "google" })).toBe(googleProvider);
	});

	it("throws on an unknown provider", () => {
		expect(() => authProviderFromEnv({ AUTH_PROVIDER: "okta" } as never)).toThrow(
			/AUTH_PROVIDER/,
		);
	});
});

describe("githubProvider", () => {
	it("reads the GitHub OAuth app credentials and allowlist from env", () => {
		const env = {
			GITHUB_CLIENT_ID: "cid",
			GITHUB_CLIENT_SECRET: "secret",
			VAULT_ALLOWED_GITHUB_LOGINS: "alice, bob",
		} as unknown as Env;
		expect(githubProvider.credentials(env)).toEqual({ clientId: "cid", clientSecret: "secret" });
		expect(githubProvider.allowedLogins(env)).toEqual(["alice", "bob"]);
	});
});

describe("googleProvider.fetchIdentity", () => {
	afterEach(() => vi.unstubAllGlobals());

	const stubUserinfo = (body: unknown, status = 200) =>
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(body, { status })),
		);

	it("sends the access token as a bearer and lowercases the email", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ email: "Alice@Example.com", email_verified: true, name: "Alice" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const identity = await googleProvider.fetchIdentity("tok");
		expect(identity).toEqual({ login: "alice@example.com", email: "alice@example.com", name: "Alice" });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
	});

	it("falls back to the email as the display name", async () => {
		stubUserinfo({ email: "alice@example.com", email_verified: true });
		expect((await googleProvider.fetchIdentity("tok")).name).toBe("alice@example.com");
	});

	it("rejects an unverified email", async () => {
		stubUserinfo({ email: "alice@example.com", email_verified: false });
		await expect(googleProvider.fetchIdentity("tok")).rejects.toBeInstanceOf(UpstreamIdentityError);
	});

	it("rejects a response without an email", async () => {
		stubUserinfo({ sub: "123" });
		await expect(googleProvider.fetchIdentity("tok")).rejects.toThrow(/missing an email/);
	});

	it("rejects a failed userinfo request", async () => {
		stubUserinfo({ error: "invalid_token" }, 401);
		await expect(googleProvider.fetchIdentity("tok")).rejects.toThrow(/401/);
	});

	it("lowercases the configured allowlist", () => {
		const env = { VAULT_ALLOWED_GOOGLE_EMAILS: "Alice@Example.com" } as unknown as Env;
		expect(googleProvider.allowedLogins(env)).toEqual(["alice@example.com"]);
	});
});
