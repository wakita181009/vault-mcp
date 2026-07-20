import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./auth/github-handler";
import type { Props } from "./auth/utils";
import { createGuardedApiHandler } from "./guard";
import { listNotesHandler, readNoteHandler, searchNotesHandler, writeNoteHandler } from "./tools";
import { VaultClient, vaultConfigFromEnv } from "./vault";
import { version } from "../package.json";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 30;

export class VaultMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Vault MCP",
		version,
	});

	async init() {
		const client = new VaultClient(vaultConfigFromEnv(this.env));

		this.server.tool(
			"list_notes",
			"List note (markdown) paths in the vault. Optionally scope to a subdirectory.",
			{
				dir: z
					.string()
					.optional()
					.describe("Optional repo-relative directory to scope the listing to, e.g. 'user_profile'."),
			},
			({ dir }) => listNotesHandler(client, dir),
		);

		this.server.tool(
			"read_note",
			"Read the raw markdown of a single note by its repo-relative path.",
			{
				path: z.string().describe("Repo-relative path to the note, e.g. 'user_profile/identity.md'."),
			},
			({ path }) => readNoteHandler(client, path),
		);

		this.server.tool(
			"write_note",
			"Create a new note or overwrite an existing one at a repo-relative path. Markdown files only.",
			{
				path: z
					.string()
					.describe("Repo-relative path to the note, e.g. 'user_profile/identity.md'."),
				content: z
					.string()
					.describe("Full markdown content to write. Overwrites the note if it already exists."),
			},
			({ path, content }) => writeNoteHandler(client, path, content),
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
			({ query, limit }) => searchNotesHandler(client, query, limit),
		);
	}
}

const vaultMcpHandler = VaultMCP.serve("/mcp");

export default new OAuthProvider({
	apiHandler: createGuardedApiHandler(vaultMcpHandler),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: {
		fetch: (req, env, ctx) =>
			GitHubHandler.fetch(req, env as Env & { OAUTH_PROVIDER: OAuthHelpers }, ctx),
	} satisfies ExportedHandler<Env>,
	tokenEndpoint: "/token",
});
