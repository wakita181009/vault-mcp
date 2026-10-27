import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Props } from "./auth/utils";
import { createGuardedApiHandler } from "./guard";
import { MCP_PATH, createOAuthProvider } from "./oauth-provider";
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
import { vaultClientFromEnv } from "./vault";
import { version } from "../package.json";

export class VaultMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Vault MCP",
		version,
	});

	async init() {
		const client = vaultClientFromEnv(this.env);

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
			"Delete an existing note by its vault-relative path. Markdown files only; never touches non-note files.",
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

const apiHandler = createGuardedApiHandler(VaultMCP.serve(MCP_PATH));

export default {
	fetch: (req, env, ctx) =>
		createOAuthProvider(apiHandler, new URL(req.url).origin).fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
