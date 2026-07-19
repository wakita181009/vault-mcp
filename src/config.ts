import { z } from "zod";

/**
 * Runtime validation for the Worker environment.
 *
 * `env.d.ts` describes the *shape* of the env at compile time, but TypeScript
 * types are erased at runtime — a missing secret or a placeholder left in
 * `.dev.vars` only surfaces as a confusing 500 deep inside a request. This
 * schema checks the actual values once, up front, so a misconfigured deploy
 * fails loudly with a precise message.
 *
 * Only string secrets and vars are validated. Bindings (KV, the Durable Object
 * namespace, the injected OAuth provider) are objects the runtime supplies and
 * are passed through untouched.
 */

// The cookie signing key is documented as `openssl rand -hex 32` (64 chars) and
// used as a raw HMAC key, not hex-decoded (see workers-oauth-utils importKey).
// So any sufficiently long string is valid — we guard length, not hex format,
// to avoid rejecting legitimate non-hex keys while catching truncated/placeholder ones.
const MIN_COOKIE_KEY_LENGTH = 32;

const envSchema = z.object({
	// Secrets — `wrangler secret put` (prod) / `.dev.vars` (local).
	GITHUB_CLIENT_ID: z.string().min(1),
	GITHUB_CLIENT_SECRET: z.string().min(1),
	COOKIE_ENCRYPTION_KEY: z
		.string()
		.min(MIN_COOKIE_KEY_LENGTH, `too short — generate with \`openssl rand -hex 32\``),
	VAULT_GITHUB_TOKEN: z.string().min(1),
	// Vars — `wrangler.jsonc` (may be overridden per environment).
	VAULT_OWNER: z.string().min(1),
	VAULT_REPO: z.string().min(1),
	VAULT_BRANCH: z.string().min(1).default("main"),
	// List-shaped vars are allowed to be empty (empty = "no filter" / "nobody").
	ALLOWED_GITHUB_LOGINS: z.string(),
	VAULT_ALLOWED_PREFIXES: z.string(),
	VAULT_DENIED_PREFIXES: z.string(),
});

/**
 * Validate the Worker env, throwing an aggregated, secret-safe error if any
 * required key is missing or malformed. Returns the same `env` (narrowed to a
 * validated type) so callers can chain: `const env = parseEnv(rawEnv)`.
 *
 * zod's default messages never echo the offending value, so nothing sensitive
 * reaches the logs.
 */
export function parseEnv(env: Env): Env {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid Worker environment:\n${issues}`);
	}
	return env;
}
