import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuardedApiHandler } from "../src/guard";

const env = { VAULT_ALLOWED_GITHUB_LOGINS: "alice,bob" } as unknown as Env;

const ctxWith = (login?: string) =>
	({ props: login ? { login } : undefined }) as unknown as ExecutionContext;

const inner = { fetch: vi.fn(async () => new Response("ok", { status: 200 })) };
const handler = createGuardedApiHandler(inner);
const request = new Request("https://mcp.example/mcp");

beforeEach(() => vi.clearAllMocks());

describe("createGuardedApiHandler", () => {
	it("delegates to the inner handler for an allowed login", async () => {
		const res = await handler.fetch?.(request, env, ctxWith("alice"));
		expect(res?.status).toBe(200);
		expect(inner.fetch).toHaveBeenCalledWith(request, env, expect.anything());
	});

	it("returns 403 without calling the inner handler when no login is present", async () => {
		const res = await handler.fetch?.(request, env, ctxWith());
		expect(res?.status).toBe(403);
		expect(inner.fetch).not.toHaveBeenCalled();
	});

	it("returns 403 for a login absent from the allowlist", async () => {
		const res = await handler.fetch?.(request, env, ctxWith("carol"));
		expect(res?.status).toBe(403);
		expect(inner.fetch).not.toHaveBeenCalled();
	});
});

describe("createGuardedApiHandler with the Google provider", () => {
	const googleEnv = {
		AUTH_PROVIDER: "google",
		VAULT_ALLOWED_GOOGLE_EMAILS: "Alice@Example.com",
		VAULT_ALLOWED_GITHUB_LOGINS: "carol",
	} as unknown as Env;

	it("matches emails case-insensitively against the Google allowlist", async () => {
		const res = await handler.fetch?.(request, googleEnv, ctxWith("alice@example.com"));
		expect(res?.status).toBe(200);
	});

	it("ignores the GitHub allowlist when Google is the provider", async () => {
		const res = await handler.fetch?.(request, googleEnv, ctxWith("carol"));
		expect(res?.status).toBe(403);
		expect(inner.fetch).not.toHaveBeenCalled();
	});

	it("matches the OIDC allowlist when oidc is the provider", async () => {
		const oidcEnv = {
			AUTH_PROVIDER: "oidc",
			VAULT_ALLOWED_OIDC_EMAILS: "Alice@Example.com",
			VAULT_ALLOWED_GITHUB_LOGINS: "carol",
		} as unknown as Env;
		expect((await handler.fetch?.(request, oidcEnv, ctxWith("alice@example.com")))?.status).toBe(200);
		expect((await handler.fetch?.(request, oidcEnv, ctxWith("carol")))?.status).toBe(403);
	});

	it("throws on an unknown provider instead of falling back to GitHub", () => {
		const badEnv = { AUTH_PROVIDER: "okta" } as unknown as Env;
		expect(() => handler.fetch?.(request, badEnv, ctxWith("alice"))).toThrow(/AUTH_PROVIDER/);
	});
});
