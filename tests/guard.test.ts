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
