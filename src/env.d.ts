/**
 * Secret bindings are set via `wrangler secret put` (prod) and `.dev.vars` (local),
 * so they are absent from the `wrangler types`-generated `Env`. Declare them here.
 *
 * Two surfaces need them: the global `Env` (used as `c.env` in Hono) and the
 * `Cloudflare.Env` namespace (the type of `env` imported from `cloudflare:workers`).
 */
interface VaultSecrets {
	/** GitHub OAuth App credentials — gate who may log in to the MCP. */
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	/** `openssl rand -hex 32` — encrypts the approval cookie. */
	COOKIE_ENCRYPTION_KEY: string;
	/** Read-only fine-grained PAT the server uses to read the vault repo. */
	VAULT_GITHUB_TOKEN: string;
	/**
	 * Vault target and access allowlist. Secrets, not `wrangler.jsonc` vars:
	 * this is a public template, so committing them would leak the private
	 * vault's identity and who may access it.
	 */
	VAULT_OWNER: string;
	VAULT_REPO: string;
	VAULT_ALLOWED_GITHUB_LOGINS: string;
}

interface Env extends VaultSecrets {}

declare namespace Cloudflare {
	interface Env extends VaultSecrets {}
}
