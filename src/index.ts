import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./auth/github-handler";
import type { Props } from "./auth/utils";
import { isLoginAllowed, listNotesHandler, readNoteHandler, searchNotesHandler } from "./tools";
import { parseList, VaultClient, vaultConfigFromEnv } from "./vault";
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

// OAuthProvider sets `ctx.props` before this runs, so gate the login allowlist
// here — before the `VaultMCP` Durable Object is even created.
const guardedApiHandler = {
	fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
		const login = (ctx as ExecutionContext & { props?: Props }).props?.login;
		// Only the allowlist is needed here; the rest of the env is validated a
		// step later when the Durable Object runs init() (see vaultConfigFromEnv).
		if (!isLoginAllowed(login, parseList(env.VAULT_ALLOWED_GITHUB_LOGINS))) {
			return Promise.resolve(new Response("Forbidden", { status: 403 }));
		}
		return vaultMcpHandler.fetch(req, env, ctx);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider({
	apiHandler: guardedApiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	// `OAUTH_PROVIDER` is injected at runtime but absent from the generated `Env`
	// type; cast just this binding so the fetch signature stays type-checked.
	defaultHandler: {
		fetch: (req, env, ctx) =>
			GitHubHandler.fetch(req, env as Env & { OAUTH_PROVIDER: OAuthHelpers }, ctx),
	} satisfies ExportedHandler<Env>,
	tokenEndpoint: "/token",
});
