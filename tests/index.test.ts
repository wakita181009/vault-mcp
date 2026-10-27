import { beforeEach, describe, expect, it, vi } from "vitest";

// McpAgent extends DurableObject, which only exists inside workerd. A plain
// base class with the same surface lets VaultMCP be constructed under Node.
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		static serve = vi.fn(() => ({ fetch: vi.fn() }));
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));

const vaultClient = vi.hoisted(() => ({
	listNotes: vi.fn(async () => ({ notes: [{ path: "a.md", size: 1 }], truncated: false })),
	readNote: vi.fn(async (path: string) => ({ path, content: "body" })),
	writeNote: vi.fn(async (path: string) => ({ path, created: true })),
	deleteNote: vi.fn(async (path: string) => ({ path })),
	searchNotes: vi.fn(async () => [{ path: "a.md", fragments: ["hit"] }]),
}));
vi.mock("../src/vault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/vault")>()),
	vaultClientFromEnv: vi.fn(() => vaultClient),
}));

const provider = vi.hoisted(() => ({
	fetch: vi.fn(async () => new Response("provider")),
	create: vi.fn(),
}));
vi.mock("../src/oauth-provider", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/oauth-provider")>()),
	createOAuthProvider: provider.create.mockImplementation(() => ({ fetch: provider.fetch })),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import worker, { VaultMCP } from "../src/index";
import { vaultClientFromEnv } from "../src/vault";

type ToolCallback = (args: Record<string, unknown>) => Promise<unknown>;

const env = { VAULT_OWNER: "o" } as unknown as Env;
const ctx = {} as unknown as ExecutionContext;

const registeredTools = async () => {
	const tool = vi.spyOn(McpServer.prototype, "tool");
	const agent = new VaultMCP(ctx as never, env);
	await agent.init();
	const entries = tool.mock.calls.map((call) => [call[0], call.at(-1) as ToolCallback] as const);
	tool.mockRestore();
	return { agent, tools: new Map(entries) };
};

// Clear per-test mocks only: `McpAgent.serve` is called once at module load
// and must keep that record for the entry-point assertion below.
beforeEach(() => {
	for (const fn of [provider.create, provider.fetch, ...Object.values(vaultClient)]) fn.mockClear();
	vi.mocked(vaultClientFromEnv).mockClear();
});

describe("VaultMCP", () => {
	it("builds the vault client from the DO env and registers the five note tools", async () => {
		const { agent, tools } = await registeredTools();
		expect(vaultClientFromEnv).toHaveBeenCalledWith(env);
		expect(agent.server).toBeInstanceOf(McpServer);
		expect([...tools.keys()]).toEqual([
			"list_notes",
			"read_note",
			"write_note",
			"delete_note",
			"search_notes",
		]);
	});

	it("routes each tool call to the vault client with its arguments", async () => {
		const { tools } = await registeredTools();

		await tools.get("list_notes")?.({ dir: "sub" });
		expect(vaultClient.listNotes).toHaveBeenCalledWith("sub");

		await tools.get("read_note")?.({ path: "a.md" });
		expect(vaultClient.readNote).toHaveBeenCalledWith("a.md");

		await tools.get("write_note")?.({ path: "a.md", content: "# x" });
		expect(vaultClient.writeNote).toHaveBeenCalledWith("a.md", "# x");

		await tools.get("delete_note")?.({ path: "a.md" });
		expect(vaultClient.deleteNote).toHaveBeenCalledWith("a.md");

		await tools.get("search_notes")?.({ query: "q", limit: 3 });
		expect(vaultClient.searchNotes).toHaveBeenCalledWith("q", 3);
	});

	it("returns MCP text content from a tool call", async () => {
		const { tools } = await registeredTools();
		const result = (await tools.get("read_note")?.({ path: "a.md" })) as {
			content: { type: string; text: string }[];
		};
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toContain("body");
	});
});

describe("worker entry", () => {
	it("serves the MCP agent on /mcp", () => {
		expect(McpAgent.serve).toHaveBeenCalledWith("/mcp");
	});

	it("builds the OAuth provider for the request origin and delegates to it", async () => {
		const req = new Request("https://mcp.example.com/authorize?x=1");
		const res = await worker.fetch(req as unknown as Parameters<typeof worker.fetch>[0], env, ctx);

		expect(provider.create).toHaveBeenCalledWith(expect.anything(), "https://mcp.example.com");
		expect(provider.fetch).toHaveBeenCalledWith(req, env, ctx);
		expect(await res.text()).toBe("provider");
	});
});
