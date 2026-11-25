import { describe, expect, it, vi } from "vitest";

vi.mock("../src/vault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/vault")>()),
	vaultClientFromEnv: () => ({
		readNote: async (path: string) => ({ path, content: "BODY" }),
	}),
}));

import { createMcpHandler } from "agents/mcp/server";
import { createVaultServer } from "../src/index";

const HOST = "vault-mcp.example.workers.dev";
const PROTOCOL = "2025-06-18";
const handler = createMcpHandler(() => createVaultServer({} as Env), {
	route: "/mcp",
});

// The handler validates the Host header, which Node's Request does not add itself.
const send = (init: RequestInit & { headers?: Record<string, string> }) =>
	handler(
		new Request(`https://${HOST}/mcp`, {
			...init,
			headers: { host: HOST, ...init.headers },
		}),
		{},
		{} as ExecutionContext,
	);

const rpc = async (method: string, params?: unknown) => {
	const res = await send({
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": PROTOCOL,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const data = (await res.text())
		.split("\n")
		.find((line) => line.startsWith("data: "));
	return { res, body: JSON.parse(data?.slice("data: ".length) ?? "null") };
};

describe("stateless MCP handler", () => {
	it("answers a 2025-era initialize without opening a session", async () => {
		const { res, body } = await rpc("initialize", {
			protocolVersion: PROTOCOL,
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("mcp-session-id")).toBeNull();
		expect(body.result.serverInfo.name).toBe("Vault MCP");
	});

	it("lists the five note tools with JSON input schemas", async () => {
		const { body } = await rpc("tools/list");
		const tools = body.result.tools as {
			name: string;
			inputSchema: { type: string };
		}[];
		expect(tools.map((t) => t.name)).toEqual([
			"list_notes",
			"read_note",
			"write_note",
			"delete_note",
			"search_notes",
		]);
		expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
	});

	it("runs a tool call without any prior request in the same session", async () => {
		const { body } = await rpc("tools/call", {
			name: "read_note",
			arguments: { path: "a.md" },
		});
		expect(body.result.content[0].text).toBe("BODY");
	});

	it("rejects invalid tool arguments as a tool error", async () => {
		const { body } = await rpc("tools/call", {
			name: "read_note",
			arguments: {},
		});
		expect(body.result.isError).toBe(true);
	});

	it("refuses the 2025 session stream (GET) since no session exists", async () => {
		const res = await send({
			method: "GET",
			headers: {
				accept: "text/event-stream",
				"mcp-protocol-version": PROTOCOL,
			},
		});
		expect(res.status).toBe(405);
	});
});
