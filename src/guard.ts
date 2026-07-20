import type { Props } from "./auth/utils";
import { isLoginAllowed } from "./tools";
import { parseList } from "./vault";

/** A minimal fetch handler: the gate's own shape and the inner one it wraps. */
type ApiHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

/**
 * Wraps an API handler with the login allowlist gate. OAuthProvider sets
 * `ctx.props` before this runs, so a login absent from
 * `VAULT_ALLOWED_GITHUB_LOGINS` is rejected before the wrapped handler (and the
 * VaultMCP Durable Object it creates) is ever reached. Only the allowlist is
 * read here; the rest of the env is validated a step later during DO init.
 */
export function createGuardedApiHandler(inner: ApiHandler): ApiHandler {
	return {
		fetch: (req, env, ctx) => {
			const login = (ctx as ExecutionContext & { props?: Props }).props?.login;
			if (!isLoginAllowed(login, parseList(env.VAULT_ALLOWED_GITHUB_LOGINS))) {
				return Promise.resolve(new Response("Forbidden", { status: 403 }));
			}
			return inner.fetch(req, env, ctx);
		},
	};
}
