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
 * Only string secrets and vars are validated and returned. Bindings (KV, the
 * Durable Object namespace, the injected OAuth provider) are stripped from the
 * returned config — access them via the raw `env` / `this.env` where needed.
 */

// The cookie signing key is documented as `openssl rand -hex 32` (64 chars) and
// used as a raw HMAC key, not hex-decoded (see workers-oauth-utils importKey).
// So any sufficiently long string is valid — we guard length, not hex format,
// to avoid rejecting legitimate non-hex keys while catching truncated/placeholder ones.
const MIN_COOKIE_KEY_LENGTH = 32;

// Generic tooling/dotfile dirs that should never be exposed as notes. Committed
// here rather than in `wrangler.jsonc` vars so the default is visible and
// code-reviewed; override per deploy with a `VAULT_DENIED_PREFIXES` secret.
const DEFAULT_DENIED_PREFIXES = ".git/,.obsidian/,.claude/";

export const envSchema = z.object({
	// Secrets — `wrangler secret put` (prod) / `.dev.vars` (local).
	GITHUB_CLIENT_ID: z.string().min(1),
	GITHUB_CLIENT_SECRET: z.string().min(1),
	COOKIE_ENCRYPTION_KEY: z
		.string()
		.min(MIN_COOKIE_KEY_LENGTH, `too short — generate with \`openssl rand -hex 32\``),
	// Fine-grained PATs start with `github_pat_`; reject a classic `ghp_` token or
	// placeholder early rather than on the first GitHub API 401.
	VAULT_GITHUB_TOKEN: z
		.string()
		.startsWith("github_pat_", "must be a fine-grained PAT (starts with `github_pat_`)"),
	// Vault target + access allowlist. Also secrets, not committed vars: this is a
	// public template, so committing them would leak the private vault and who may use it.
	VAULT_OWNER: z.string().min(1),
	VAULT_REPO: z.string().min(1),
	VAULT_BRANCH: z.string().min(1).default("main"),
	VAULT_ALLOWED_GITHUB_LOGINS: z.string(),
	VAULT_ALLOWED_PREFIXES: z.string().default(""),
	VAULT_DENIED_PREFIXES: z.string().default(DEFAULT_DENIED_PREFIXES),
});

/** Validated env config with defaults applied — the return type of `parseEnv`. */
export type VaultEnvConfig = z.infer<typeof envSchema>;

/**
 * Validate the Worker env, throwing an aggregated, secret-safe error if any
 * required key is missing or malformed. Returns the parsed config with defaults
 * applied (so optional overrides resolve to their defaults), which callers use
 * directly: `const config = parseEnv(rawEnv)`.
 *
 * zod's default messages never echo the offending value, so nothing sensitive
 * reaches the logs.
 */
export function parseEnv(env: Env): VaultEnvConfig {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid Worker environment:\n${issues}`);
	}
	return result.data;
}
