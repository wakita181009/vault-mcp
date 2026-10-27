import { authProviderFromEnv } from "./auth/providers";
import type { Props } from "./auth/props";
import { isLoginAllowed } from "./tools";

/** A minimal fetch handler: the gate's own shape and the inner one it wraps. */
type ApiHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

/**
 * Wraps an API handler with the login allowlist gate. OAuthProvider sets
 * `ctx.props` before this runs, so an identity absent from the configured
 * provider's allowlist (`VAULT_ALLOWED_GITHUB_LOGINS`,
 * `VAULT_ALLOWED_GOOGLE_EMAILS`, or `VAULT_ALLOWED_OIDC_EMAILS`) is rejected before the wrapped handler (and
 * the VaultMCP Durable Object it creates) is ever reached. Only the allowlist
 * is read here; the rest of the env is validated a step later during DO init.
 */
export function createGuardedApiHandler(inner: ApiHandler): ApiHandler {
	return {
		fetch: (req, env, ctx) => {
			const login = (ctx as ExecutionContext & { props?: Props }).props?.login;
			if (!isLoginAllowed(login, authProviderFromEnv(env).allowedLogins(env))) {
				return Promise.resolve(new Response("Forbidden", { status: 403 }));
			}
			return inner.fetch(req, env, ctx);
		},
	};
}
