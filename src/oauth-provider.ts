import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./auth/github-handler";

export const MCP_PATH = "/mcp";

type ApiHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

// Since workers-oauth-provider 1.0 the canonical resource URL is mandatory: it
// becomes every token's audience and must equal the value existing grants were
// bound to, which 0.x derived from the request origin plus the API path. The
// host is not configured anywhere (workers.dev, custom domain, `wrangler dev`),
// so the provider is built per request from the origin to keep that contract.
export const createOAuthProvider = (apiHandler: ApiHandler, origin: string) =>
	new OAuthProvider({
		apiHandler,
		apiRoute: MCP_PATH,
		authorizeEndpoint: "/authorize",
		clientRegistrationEndpoint: "/register",
		defaultHandler: {
			fetch: (req, env, ctx) =>
				GitHubHandler.fetch(req, env as Env & { OAUTH_PROVIDER: OAuthHelpers }, ctx),
		} satisfies ExportedHandler<Env>,
		resourceMetadata: { resource: `${origin}${MCP_PATH}` },
		tokenEndpoint: "/token",
	});
