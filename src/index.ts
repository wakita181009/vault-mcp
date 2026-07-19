import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { parseEnv } from "./config";
import { GitHubHandler } from "./github-handler";
import type { Props } from "./utils";
import { parseList, VaultClient, VaultError, vaultConfigFromEnv } from "./vault";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 30;

export class VaultMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "wakita181009/vault MCP",
		version: "0.1.0",
	});

	async init() {
		// Fail fast on a misconfigured deploy: validate secrets/vars before wiring
		// any tools, so problems surface as a clear boot error, not a mid-request 500.
		const env = parseEnv(this.env);

		// Gate the entire toolset on the login allowlist. This is a private vault,
		// so anyone who is not explicitly allowed gets no tools at all.
		const allowed = new Set(parseList(env.ALLOWED_GITHUB_LOGINS));
		if (!allowed.has(this.props!.login)) {
			return;
		}

		const client = new VaultClient(vaultConfigFromEnv(env));

		this.server.tool(
			"list_notes",
			"List note (markdown) paths in the vault. Optionally scope to a subdirectory.",
			{
				dir: z
					.string()
					.optional()
					.describe("Optional repo-relative directory to scope the listing to, e.g. 'user_profile'."),
			},
			async ({ dir }) => {
				try {
					const { notes, truncated } = await client.listNotes(dir);
					const lines = notes.map((n) => n.path);
					const header = `${notes.length} note(s)${truncated ? " (tree truncated by GitHub)" : ""}:`;
					return textResult([header, ...lines].join("\n"));
				} catch (error) {
					return errorResult(error);
				}
			},
		);

		this.server.tool(
			"read_note",
			"Read the raw markdown of a single note by its repo-relative path.",
			{
				path: z.string().describe("Repo-relative path to the note, e.g. 'user_profile/identity.md'."),
			},
			async ({ path }) => {
				try {
					const note = await client.readNote(path);
					return textResult(note.content);
				} catch (error) {
					return errorResult(error);
				}
			},
		);

		this.server.tool(
			"search_notes",
			"Search notes by content (indexed) and filename. Returns matching paths with snippets.",
			{
				query: z.string().describe("Text to search for across note contents and filenames."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_SEARCH_LIMIT)
					.default(DEFAULT_SEARCH_LIMIT)
					.describe("Maximum number of notes to return."),
			},
			async ({ query, limit }) => {
				try {
					const hits = await client.searchNotes(query, limit);
					if (hits.length === 0) {
						return textResult(`No notes matched: ${query}`);
					}
					const blocks = hits.map((hit) => {
						const snippet = hit.fragments.length > 0 ? `\n${hit.fragments.join("\n---\n")}` : "";
						return `## ${hit.path}${snippet}`;
					});
					return textResult(blocks.join("\n\n"));
				} catch (error) {
					return errorResult(error);
				}
			},
		);
	}
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function errorResult(error: unknown) {
	const message = error instanceof VaultError ? error.message : `Vault read failed: ${String(error)}`;
	return { content: [{ type: "text" as const, text: message }], isError: true };
}

export default new OAuthProvider({
	apiHandler: VaultMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
