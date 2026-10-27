import type { AuthProviderName } from "../../config";
import { githubProvider } from "./github";
import { googleProvider } from "./google";
import { oidcProvider } from "./oidc";
import type { UpstreamProvider } from "./types";

export type { UpstreamIdentity, UpstreamProvider } from "./types";
export { UpstreamIdentityError } from "./types";

const PROVIDERS: Record<AuthProviderName, UpstreamProvider> = {
	github: githubProvider,
	google: googleProvider,
	oidc: oidcProvider,
};

const DEFAULT_PROVIDER: AuthProviderName = "github";

/**
 * Resolve the configured login provider from the raw env. Reads only
 * `AUTH_PROVIDER` so it can run on the hot path (the allowlist guard) before
 * the full env is validated; an unknown value throws because every later step
 * would otherwise silently fall back to GitHub.
 */
export function authProviderFromEnv(env: Pick<Env, "AUTH_PROVIDER">): UpstreamProvider {
	const name = env.AUTH_PROVIDER ?? DEFAULT_PROVIDER;
	// `hasOwn` rather than an index lookup so "constructor" and friends are
	// rejected with the same message as any other unknown value.
	if (!Object.hasOwn(PROVIDERS, name)) {
		throw new Error(
			`Invalid Worker environment:\n  - AUTH_PROVIDER: expected one of ${Object.keys(PROVIDERS).join(", ")}`,
		);
	}
	return PROVIDERS[name as AuthProviderName];
}
