import type { z } from "zod";
import type {
	AuthProviderName,
	commonEnvSchema,
	githubAuthSchema,
	googleAuthSchema,
	oidcAuthSchema,
} from "./config";

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
type CommonEnv = z.input<typeof commonEnvSchema>;
type ProviderKeys<Schema extends z.ZodTypeAny> = Partial<
	Omit<z.input<Schema>, keyof CommonEnv | "AUTH_PROVIDER">
>;
type VaultEnv = CommonEnv & { AUTH_PROVIDER?: AuthProviderName } & ProviderKeys<
		typeof githubAuthSchema
	> &
	ProviderKeys<typeof googleAuthSchema> &
	ProviderKeys<typeof oidcAuthSchema>;

declare global {
	interface Env extends VaultEnv {}

	namespace Cloudflare {
		interface Env extends VaultEnv {}
	}
}
