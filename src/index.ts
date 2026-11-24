import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
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

/**
 * Builds a fresh MCP server for one request. Every tool is stateless, so no
 * session (and no Durable Object) is kept between requests.
 */
export function createVaultServer(env: Env): McpServer {
	const server = new McpServer({ name: "Vault MCP", version });
	const client = vaultClientFromEnv(env);

	server.registerTool(
		"list_notes",
		{
			title: "List notes",
			description: "List note (markdown) paths in the vault. Optionally scope to a subdirectory.",
			inputSchema: listNotesInput.shape,
			annotations: READ_ONLY,
		},
		({ dir }) => listNotesHandler(client, dir),
	);

	server.registerTool(
		"read_note",
		{
			title: "Read note",
			description: "Read the raw markdown of a single note by its vault-relative path.",
			inputSchema: readNoteInput.shape,
			annotations: READ_ONLY,
		},
		({ path }) => readNoteHandler(client, path),
	);

	server.registerTool(
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

	server.registerTool(
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

	server.registerTool(
		"search_notes",
		{
			title: "Search notes",
			description:
				"Search notes by content and filename. Returns matching paths with snippets. Content search may not cover every note (index lag on GitHub; a bounded scan of the most recently changed notes on R2/S3), so a miss is not proof of absence.",
			inputSchema: searchNotesInput.shape,
			annotations: READ_ONLY,
		},
		({ query, limit }) => searchNotesHandler(client, query, limit),
	);

	return server;
}

const apiHandler = createGuardedApiHandler({
	// The vault env is only known per request, so the handler is built per request too.
	fetch: (req, env, ctx) =>
		createMcpHandler(() => createVaultServer(env), {
			route: MCP_PATH,
			// Origin checks guard against DNS rebinding of unauthenticated local
			// servers. Here OAuthProvider has already required a bearer token, which a
			// browser never attaches on its own, and the McpAgent route this replaces
			// accepted any Origin; rejecting unknown ones could lock out hosted clients.
			allowedOriginHostnames: "*",
		})(req, env, ctx),
});

export default {
	fetch: (req, env, ctx) =>
		createOAuthProvider(apiHandler, new URL(req.url).origin).fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
