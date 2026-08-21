import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GitHubHandler } from "./auth/github-handler";
import type { Props } from "./auth/utils";
import { createGuardedApiHandler } from "./guard";
import {
	deleteNoteInput,
	listNotesInput,
	readNoteInput,
	searchNotesInput,
	writeNoteInput,
} from "./schemas";
import {
	deleteNoteHandler,
	listNotesHandler,
	readNoteHandler,
	searchNotesHandler,
	writeNoteHandler,
} from "./tools";
import { VaultClient, vaultConfigFromEnv } from "./vault";
import { version } from "../package.json";

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
			listNotesInput.shape,
			({ dir }) => listNotesHandler(client, dir),
		);

		this.server.tool(
			"read_note",
			"Read the raw markdown of a single note by its repo-relative path.",
			readNoteInput.shape,
			({ path }) => readNoteHandler(client, path),
		);

		this.server.tool(
			"write_note",
			"Create a new note or overwrite an existing one at a repo-relative path. Markdown files only.",
			writeNoteInput.shape,
			({ path, content }) => writeNoteHandler(client, path, content),
		);

		this.server.tool(
			"delete_note",
			"Delete an existing note by its repo-relative path. Markdown files only. Recorded as a git commit (revertable); never touches non-note files.",
			deleteNoteInput.shape,
			({ path }) => deleteNoteHandler(client, path),
		);

		this.server.tool(
			"search_notes",
			"Search notes by content (indexed) and filename. Returns matching paths with snippets.",
			searchNotesInput.shape,
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
