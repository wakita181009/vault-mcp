# vault-mcp

Authenticated remote MCP server (Cloudflare Workers) that exposes a private Obsidian vault —
hosted in a GitHub repo (default), a Cloudflare R2 bucket (`VAULT_STORAGE=r2`), or any
S3-compatible bucket (`VAULT_STORAGE=s3`) — to claude.ai
and Claude Code. Reads (list/read/search) plus two note mutations:
`write_note` (create/overwrite) and `delete_note` — **no rename/move**. The target repo and
access policy are configured through secrets; path-scope overrides default in `src/config.ts`,
so `wrangler.jsonc` ships generic (no `vars`).

## Invariants — keep these intact when changing code

- **Notes-only, no rename/move.** The mutations are `write_note` (create/overwrite a markdown
  note) and `delete_note` (remove one). Never add a rename/move tool — the GitHub API has no
  atomic move and it would silently break Obsidian wikilinks. Never let a mutation touch
  non-note files — `writeNote` and `deleteNote` in `vault.ts` must keep enforcing the
  `.md`/`.markdown` extension check.
- **Policy lives in `vault.ts`, never in a backend.** Storage backends (`src/storage/`) implement
  `VaultStorage` and only move bytes. All guards run in `VaultClient` before a path reaches a
  backend, so a new backend cannot weaken them. Add backends by implementing the interface, giving it a zod-only
  `src/storage/<name>/schema.ts` added to `storageEnvSchema` (`src/storage/schema.ts`), and wiring it in
  `storageFromEnv` (`src/storage/index.ts`). Backend- and provider-specific env keys live under
  `src/storage/` and `src/auth/providers/`; `src/config.ts` keeps only the common keys and composes
  the layers in `parseEnv`. Keep each `schema.ts` importing only `zod` — `config.ts` imports them, and
  a runtime import there (e.g. `vault.ts`) would form an import cycle.
  The `candidates` argument to `searchContent` is only a pruning hint; `VaultClient` must keep
  re-filtering every hit.
- **Writes and deletes obey the same path policy as reads.** `write_note` and `delete_note`
  must run every guard `read_note` does — `..`/absolute rejection and `VAULT_ALLOWED_PREFIXES` /
  `VAULT_DENIED_PREFIXES` — so a mutation can never reach `.git/`, `.obsidian/`, or agent dirs.
  Preserve this when touching write/delete logic.
- **The login allowlist gates the whole toolset.** An identity absent from the configured
  provider's allowlist (`VAULT_ALLOWED_GITHUB_LOGINS` for `AUTH_PROVIDER=github`,
  `VAULT_ALLOWED_GOOGLE_EMAILS` for `google`, `VAULT_ALLOWED_OIDC_EMAILS` for `oidc`) must get
  **zero** tools, not a reduced set — see `guard.ts`. Login providers live in
  `src/auth/providers/`; the flow in `auth/handler.ts` is provider-agnostic. Google and the
  generic `oidc` provider share `createOidcProvider`; an email identity must be verified
  (`email_verified: true`) before it can match. The only exception is the explicit
  `OIDC_ALLOW_UNVERIFIED_EMAIL=true` opt-in for IdPs that never send the claim — an explicit
  `email_verified: false` is rejected regardless. Keep the OIDC discovery document's `issuer`
  check in `providers/oidc/discovery.ts`: without it a hostile host could supply foreign endpoints.
- **Storage credentials stay single-vault scoped.** For R2 that is the `VAULT_BUCKET` binding to
  one bucket — never bind a broader bucket or swap the R2 backend onto S3 API keys. For S3,
  `VAULT_S3_ACCESS_KEY_ID` / `VAULT_S3_SECRET_ACCESS_KEY` must come from an IAM policy limited
  to the one vault bucket (the README's policy); never document or default to account-wide keys.
  Keep `aws4fetch` at `retries: 0` and the list/scan caps within the Free plan's 50 subrequests.
  For GitHub:
  **`VAULT_GITHUB_TOKEN` stays single-repo scoped.** It needs Contents: Read *and Write* (Write
  covers both `write_note` and `delete_note`), but only on the vault repo. Never widen it beyond
  that one repo or swap in a broader token.
- **Path safety.** `vault.ts` enforces `VAULT_ALLOWED_PREFIXES` / `VAULT_DENIED_PREFIXES`
  (defaults in `src/config.ts`; `DEFAULT_DENIED_PREFIXES` must keep hiding `.git/`, `.obsidian/`,
  and agent dirs) and rejects `..` traversal and absolute paths in `read_note`, `write_note`,
  and `delete_note`. Preserve this when touching read/write/delete logic.

## Conventions

- Code, comments, and docs in English. Comments explain **why**, not what.
- Immutability; small, focused modules.
- Secrets: `.dev.vars` locally, `wrangler secret put` in production. Their types live in
  `src/env.d.ts` (they are not emitted by `wrangler types`). `cf-typegen`/`typecheck` pass
  `--env-file /dev/null` so a local `.dev.vars` does not leak its keys into
  `worker-configuration.d.ts` and make the committed file differ from CI.
- After editing `wrangler.jsonc`, run `pnpm cf-typegen`, then verify with `pnpm typecheck`
  and `pnpm build && pnpm exec wrangler deploy --dry-run` (the build refreshes the
  `.wrangler/deploy/config.json` redirect that points wrangler at `dist/vault_mcp/`).
- The Worker builds with Vite (`@cloudflare/vite-plugin`), not wrangler's bundler.
  MCP tool input schemas live in `src/schemas.ts` and are compiled by `zod-aot`
  (autoDiscover scoped to that file). Keep `src/schemas.ts` importing only `zod` and
  side-effect free — the plugin executes it at build time.

See `README.md` for the full setup and deploy runbook.
