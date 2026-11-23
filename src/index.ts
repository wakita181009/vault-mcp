import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Props } from "./auth/props";
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

// Every tool touches only the one configured vault, never the open world.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
// Only hints that differ from the spec defaults: absent readOnlyHint and
// destructiveHint already mean "may destroy", so clients still confirm. Repeating
// the same write or delete changes nothing further.
const MUTATING = { idempotentHint: true, openWorldHint: false } as const;

export class VaultMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Vault MCP",
		version,
	});

	async init() {
		const client = vaultClientFromEnv(this.env);

		this.server.registerTool(
			"list_notes",
			{
				title: "List notes",
				description: "List note (markdown) paths in the vault. Optionally scope to a subdirectory.",
				inputSchema: listNotesInput.shape,
				annotations: READ_ONLY,
			},
			({ dir }) => listNotesHandler(client, dir),
		);

		this.server.registerTool(
			"read_note",
			{
				title: "Read note",
				description: "Read the raw markdown of a single note by its vault-relative path.",
				inputSchema: readNoteInput.shape,
				annotations: READ_ONLY,
			},
			({ path }) => readNoteHandler(client, path),
		);

		this.server.registerTool(
			"write_note",
			{
				title: "Write note",
				description:
					"Create a new note or overwrite an existing one at a vault-relative path. Markdown files only.",
				inputSchema: writeNoteInput.shape,
				annotations: MUTATING,
			},
			({ path, content }) => writeNoteHandler(client, path, content),
		);

		this.server.registerTool(
			"delete_note",
			{
				title: "Delete note",
				description:
					"Delete an existing note by its vault-relative path. Markdown files only; never touches non-note files.",
				inputSchema: deleteNoteInput.shape,
				annotations: MUTATING,
			},
			({ path }) => deleteNoteHandler(client, path),
		);

		this.server.registerTool(
			"search_notes",
			{
				title: "Search notes",
				description:
					"Search notes by content and filename. Returns matching paths with snippets. Content search may not cover every note (index lag on GitHub; a bounded scan of the most recently changed notes on R2), so a miss is not proof of absence.",
				inputSchema: searchNotesInput.shape,
				annotations: READ_ONLY,
			},
			({ query, limit }) => searchNotesHandler(client, query, limit),
		);
	}
}

const apiHandler = createGuardedApiHandler(VaultMCP.serve(MCP_PATH));

export default {
	fetch: (req, env, ctx) =>
		createOAuthProvider(apiHandler, new URL(req.url).origin).fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
