import type { z } from "zod";
import type { envSchema } from "./config";

/**
 * The raw Worker env — exactly the keys `parseEnv` reads, derived from the one
 * zod schema in `src/config.ts` so there is no second hand-maintained key list.
 * `z.input` keeps the optional overrides (VAULT_BRANCH etc.) optional here; they
 * are absent until set, and `parseEnv` applies their defaults.
 *
 * Two surfaces need this: the global `Env` (used as `c.env` in Hono) and the
 * `Cloudflare.Env` namespace (the type of `env` imported from `cloudflare:workers`).
 * Both are absent from the `wrangler types` output, so we augment them here.
 */
type VaultEnv = z.input<typeof envSchema>;

declare global {
	interface Env extends VaultEnv {}

	namespace Cloudflare {
		interface Env extends VaultEnv {}
	}
}
