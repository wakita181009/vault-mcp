import type { z } from "zod";
import type { githubAuthSchema, googleAuthSchema } from "./config";

/**
 * The raw Worker env — exactly the keys `parseEnv` reads, derived from the zod
 * schemas in `src/config.ts` so there is no second hand-maintained key list.
 * `z.input` keeps the optional overrides (VAULT_BRANCH etc.) optional here; they
 * are absent until set, and `parseEnv` applies their defaults.
 *
 * The provider schemas form a discriminated union at runtime, but an
 * `interface` cannot extend a union, so the raw env is typed as the common keys
 * plus every provider's keys as optional. `parseEnv` is what narrows it.
 *
 * Two surfaces need this: the global `Env` (used as `c.env` in Hono) and the
 * `Cloudflare.Env` namespace (the type of `env` imported from `cloudflare:workers`).
 * Both are absent from the `wrangler types` output, so we augment them here.
 */
type GitHubAuthEnv = z.input<typeof githubAuthSchema>;
type GoogleAuthEnv = z.input<typeof googleAuthSchema>;
type CommonEnv = Omit<GitHubAuthEnv, keyof Omit<GitHubAuthEnv, keyof GoogleAuthEnv>>;
type VaultEnv = Omit<CommonEnv, "AUTH_PROVIDER"> & {
	AUTH_PROVIDER?: GitHubAuthEnv["AUTH_PROVIDER"] | GoogleAuthEnv["AUTH_PROVIDER"];
} & Partial<Omit<GitHubAuthEnv, keyof CommonEnv>> &
	Partial<Omit<GoogleAuthEnv, keyof CommonEnv>>;

declare global {
	interface Env extends VaultEnv {}

	namespace Cloudflare {
		interface Env extends VaultEnv {}
	}
}
