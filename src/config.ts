import { z } from "zod";
import { type AuthEnvConfig, authEnvSchema } from "./auth/providers/schema";
import { invalidEnvError } from "./env-error";
import { type StorageEnvConfig, storageEnvSchema } from "./storage/schema";

/**
 * Runtime validation for the Worker environment.
 *
 * `env.d.ts` describes the *shape* of the env at compile time, but TypeScript
 * types are erased at runtime — a missing secret or a placeholder left in
 * `.dev.vars` only surfaces as a confusing 500 deep inside a request. This
 * schema checks the actual values once, up front, so a misconfigured deploy
 * fails loudly with a precise message.
 *
 * Only string secrets and vars are validated and returned. Bindings (KV, R2,
 * the injected OAuth provider) are stripped from the returned config — access
 * them via the raw `env` where needed.
 */

// The cookie signing key is documented as `openssl rand -hex 32` (64 chars) and
// used as a raw HMAC key, not hex-decoded (see auth/session.ts importKey).
// So any sufficiently long string is valid — we guard length, not hex format,
// to avoid rejecting legitimate non-hex keys while catching truncated/placeholder ones.
const MIN_COOKIE_KEY_LENGTH = 32;

// Generic tooling/dotfile dirs that should never be exposed as notes. Committed
// here rather than in `wrangler.jsonc` vars so the default is visible and
// code-reviewed; override per deploy with a `VAULT_DENIED_PREFIXES` secret.
const DEFAULT_DENIED_PREFIXES = ".git/,.obsidian/,.claude/";

// Keys every deploy needs regardless of which login provider or storage backend
// is used. Provider- and backend-specific keys live with their implementations
// (`auth/providers/schema.ts`, `storage/schema.ts`) and are composed in `parseEnv`.
export const commonEnvSchema = z.object({
	COOKIE_ENCRYPTION_KEY: z
		.string()
		.min(MIN_COOKIE_KEY_LENGTH, `too short — generate with \`openssl rand -hex 32\``),
	VAULT_ALLOWED_PREFIXES: z.string().default(""),
	VAULT_DENIED_PREFIXES: z.string().default(DEFAULT_DENIED_PREFIXES),
});

export type VaultEnvConfig = z.infer<typeof commonEnvSchema> & AuthEnvConfig & StorageEnvConfig;

/**
 * Throws one aggregated error listing every missing or malformed key. zod's
 * default messages never echo the offending value, so nothing sensitive
 * reaches the logs.
 */
export function parseEnv(env: Env): VaultEnvConfig {
	// Parse every layer before failing so one error lists every bad key at once.
	const results = [
		commonEnvSchema.safeParse(env),
		authEnvSchema.safeParse(env),
		storageEnvSchema.safeParse(env),
	] as const;
	const [common, auth, storage] = results;
	if (!common.success || !auth.success || !storage.success) {
		throw invalidEnvError(
			results
				.flatMap((result) => result.error?.issues ?? [])
				.map((issue) => ({ key: issue.path.join(".") || "(root)", message: issue.message })),
		);
	}
	return { ...common.data, ...auth.data, ...storage.data };
}
