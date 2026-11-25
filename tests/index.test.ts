import { beforeEach, describe, expect, it, vi } from "vitest";

const mcpHandler = vi.hoisted(() => ({
	create: vi.fn(),
	fetch: vi.fn(async () => new Response("mcp")),
}));
vi.mock("agents/mcp/server", () => ({
	createMcpHandler: mcpHandler.create.mockImplementation(
		() => mcpHandler.fetch,
	),
}));

const vaultClient = vi.hoisted(() => ({
	listNotes: vi.fn(async () => ({
		notes: [{ path: "a.md", size: 1 }],
		truncated: false,
	})),
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
	createOAuthProvider: provider.create.mockImplementation(() => ({
		fetch: provider.fetch,
	})),
}));

import { McpServer } from "@modelcontextprotocol/server";
import worker, { createVaultServer } from "../src/index";
import { vaultClientFromEnv } from "../src/vault";

type ToolCallback = (args: Record<string, unknown>) => Promise<unknown>;
type ToolConfig = { title?: string; annotations?: Record<string, boolean> };

const env = { VAULT_OWNER: "o" } as unknown as Env;
const ctx = {} as unknown as ExecutionContext;

const registeredTools = async () => {
	const register = vi.spyOn(McpServer.prototype, "registerTool");
	const server = createVaultServer(env);
	const calls = register.mock.calls as unknown as [
		string,
		ToolConfig,
		ToolCallback,
	][];
	register.mockRestore();
	return {
		server,
		tools: new Map(calls.map(([name, , cb]) => [name, cb])),
		configs: new Map(calls.map(([name, config]) => [name, config])),
	};
};

beforeEach(() => {
	for (const fn of [
		provider.create,
		provider.fetch,
		mcpHandler.create,
		mcpHandler.fetch,
		...Object.values(vaultClient),
	])
		fn.mockClear();
	vi.mocked(vaultClientFromEnv).mockClear();
});

describe("createVaultServer", () => {
	it("builds the vault client from the request env and registers the five note tools", async () => {
		const { server, tools } = await registeredTools();
		expect(vaultClientFromEnv).toHaveBeenCalledWith(env);
		expect(server).toBeInstanceOf(McpServer);
		expect([...tools.keys()]).toEqual([
			"list_notes",
			"read_note",
			"write_note",
			"delete_note",
			"search_notes",
		]);
	});

	it("marks reads read-only, mutations idempotent (destructive by default), all closed-world", async () => {
		const { configs } = await registeredTools();
		for (const name of ["list_notes", "read_note", "search_notes"]) {
			expect(configs.get(name)?.annotations).toEqual({
				readOnlyHint: true,
				openWorldHint: false,
			});
		}
		for (const name of ["write_note", "delete_note"]) {
			expect(configs.get(name)?.annotations).toEqual({
				idempotentHint: true,
				openWorldHint: false,
			});
		}
		expect([...configs.values()].every((config) => config.title)).toBe(true);
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
	it("serves a stateless MCP handler on /mcp with a server built from the request env", async () => {
		const req = new Request("https://mcp.example.com/mcp", { method: "POST" });
		const reqEnv = {
			...env,
			VAULT_ALLOWED_GITHUB_LOGINS: "octocat",
		} as unknown as Env;
		const reqCtx = {
			props: { login: "octocat" },
		} as unknown as ExecutionContext;
		await worker.fetch(
			req as unknown as Parameters<typeof worker.fetch>[0],
			reqEnv,
			ctx,
		);
		const [apiHandler] = provider.create.mock.calls[0] as unknown as [
			{ fetch: (r: Request, e: Env, c: ExecutionContext) => Promise<Response> },
		];

		const res = await apiHandler.fetch(req, reqEnv, reqCtx);

		expect(await res.text()).toBe("mcp");
		expect(mcpHandler.create).toHaveBeenCalledWith(expect.any(Function), {
			route: "/mcp",
			allowedOriginHostnames: "*",
		});
		expect(mcpHandler.fetch).toHaveBeenCalledWith(req, reqEnv, reqCtx);
		const [factory] = mcpHandler.create.mock.calls[0] as unknown as [
			() => McpServer,
		];
		expect(factory()).toBeInstanceOf(McpServer);
		expect(vaultClientFromEnv).toHaveBeenCalledWith(reqEnv);
	});

	it("builds the OAuth provider for the request origin and delegates to it", async () => {
		const req = new Request("https://mcp.example.com/authorize?x=1");
		const res = await worker.fetch(
			req as unknown as Parameters<typeof worker.fetch>[0],
			env,
			ctx,
		);

		expect(provider.create).toHaveBeenCalledWith(
			expect.anything(),
			"https://mcp.example.com",
		);
		expect(provider.fetch).toHaveBeenCalledWith(req, env, ctx);
		expect(await res.text()).toBe("provider");
	});
});
