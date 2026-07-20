# vault-mcp

Authenticated remote MCP server (Cloudflare Workers) that exposes a private, GitHub-hosted
Obsidian vault to claude.ai and Claude Code. Reads (list/read/search) plus a single
create/overwrite write (`write_note`) — **no delete**. The target repo and access policy
are configured through secrets; path-scope overrides default in `src/config.ts`, so
`wrangler.jsonc` ships generic (no `vars`).

## Invariants — keep these intact when changing code

- **Notes-only, no delete.** The only mutation is `write_note` (create/overwrite a markdown
  note). Never add a delete/rename/move tool, and never let writes touch non-note files —
  `writeNote` in `vault.ts` must keep enforcing the `.md`/`.markdown` extension check.
- **Writes obey the same path policy as reads.** `write_note` must run every guard `read_note`
  does — `..`/absolute rejection and `VAULT_ALLOWED_PREFIXES` / `VAULT_DENIED_PREFIXES` — so a
  write can never reach `.git/`, `.obsidian/`, or agent dirs. Preserve this when touching write logic.
- **The login allowlist gates the whole toolset.** A GitHub login absent from
  `VAULT_ALLOWED_GITHUB_LOGINS` must get **zero** tools, not a reduced set — see `init` in `index.ts`.
- **`VAULT_GITHUB_TOKEN` stays single-repo scoped.** It now needs Contents: Read *and Write*,
  but only on the vault repo. Never widen it beyond that one repo or swap in a broader token.
- **Path safety.** `vault.ts` enforces `VAULT_ALLOWED_PREFIXES` / `VAULT_DENIED_PREFIXES`
  (defaults in `src/config.ts`; `DEFAULT_DENIED_PREFIXES` must keep hiding `.git/`, `.obsidian/`,
  and agent dirs) and rejects `..` traversal and absolute paths in both `read_note` and
  `write_note`. Preserve this when touching read/write logic.

## Conventions

- Code, comments, and docs in English. Comments explain **why**, not what.
- Immutability; small, focused modules.
- Secrets: `.dev.vars` locally, `wrangler secret put` in production. Their types live in
  `src/env.d.ts` (they are not emitted by `wrangler types`).
- After editing `wrangler.jsonc`, run `pnpm cf-typegen`, then verify with `pnpm typecheck`
  and `pnpm exec wrangler deploy --dry-run`.

See `README.md` for the full setup and deploy runbook.
