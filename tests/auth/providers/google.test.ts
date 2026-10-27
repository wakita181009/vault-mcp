import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamIdentityError } from "../../../src/auth/providers";
import { googleProvider } from "../../../src/auth/providers/google";

const asEnv = (env: Record<string, unknown>) => env as unknown as Env;

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
