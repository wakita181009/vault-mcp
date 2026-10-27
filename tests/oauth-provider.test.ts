import { beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({ fetch: vi.fn(async () => new Response("github", { status: 200 })) }));
vi.mock("../src/auth/github-handler", () => ({ GitHubHandler: github }));

import { createOAuthProvider } from "../src/oauth-provider";

// Metadata routes never touch KV, so an empty env is enough to exercise the
// provider wiring without a Workers runtime.
const env = {} as unknown as Env;
const ctx = {} as unknown as ExecutionContext;
const apiHandler = { fetch: () => new Response("unreachable", { status: 500 }) };

const worker = {
	fetch: (req: Request) => createOAuthProvider(apiHandler, new URL(req.url).origin).fetch(req, env, ctx),
};

const protectedResourceMetadata = async (origin: string) => {
	const res = await worker.fetch(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`));
	expect(res.status).toBe(200);
	return (await res.json()) as { resource: string; authorization_servers: string[] };
};

beforeEach(() => vi.clearAllMocks());

describe("OAuthProvider wiring", () => {
	it("hands non-OAuth routes to the GitHub login handler with the provider helpers in env", async () => {
		const req = new Request("https://mcp.example.com/authorize?client_id=c1");
		const res = await worker.fetch(req);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("github");
		const [passedReq, passedEnv] = github.fetch.mock.calls[0] as unknown as [Request, { OAUTH_PROVIDER?: unknown }];
		expect(passedReq.url).toBe(req.url);
		expect(passedEnv.OAUTH_PROVIDER).toBeDefined();
	});

	it("advertises the request origin plus /mcp as the canonical resource", async () => {
		const body = await protectedResourceMetadata("https://vault-mcp.example.workers.dev");
		expect(body.resource).toBe("https://vault-mcp.example.workers.dev/mcp");
		expect(body.authorization_servers).toEqual(["https://vault-mcp.example.workers.dev"]);
	});

	it("follows the origin so a custom domain and wrangler dev each get their own resource", async () => {
		const custom = await protectedResourceMetadata("https://mcp.example.com");
		expect(custom.resource).toBe("https://mcp.example.com/mcp");

		const local = await protectedResourceMetadata("http://localhost:8787");
		expect(local.resource).toBe("http://localhost:8787/mcp");
	});

	it("challenges an unauthenticated /mcp request with the matching resource metadata", async () => {
		const res = await worker.fetch(new Request("https://mcp.example.com/mcp", { method: "POST" }));
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain(
			'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
		);
	});
});
