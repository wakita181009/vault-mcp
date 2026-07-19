# vault-mcp

Authenticated remote MCP server (Cloudflare Workers) that exposes a private, GitHub-hosted
Obsidian vault **read-only** to claude.ai and Claude Code. The target repo and access policy
are configured through `vars` in `wrangler.jsonc`.

## Invariants — keep these intact when changing code

- **Read-only, always.** Never add a write or mutate tool. The server authenticates with a
  read-only PAT; a write tool would fail and defeats the entire purpose of the project.
- **The login allowlist gates the whole toolset.** A GitHub login absent from
  `ALLOWED_GITHUB_LOGINS` must get **zero** tools, not a reduced set — see `init` in `index.ts`.
- **`VAULT_GITHUB_TOKEN` stays read-only and single-repo scoped.** Never widen it to write
  access or swap in a broader token; read access must never imply write access to the vault.
- **Path safety.** `vault.ts` enforces `VAULT_ALLOWED_PREFIXES` / `VAULT_DENIED_PREFIXES` and
  rejects `..` traversal and absolute paths in `read_note`. Preserve this when touching read logic.

## Conventions

- Code, comments, and docs in English. Comments explain **why**, not what.
- Immutability; small, focused modules.
- Secrets: `.dev.vars` locally, `wrangler secret put` in production. Their types live in
  `src/env.d.ts` (they are not emitted by `wrangler types`).
- After editing `wrangler.jsonc`, run `pnpm cf-typegen`, then verify with `pnpm typecheck`
  and `pnpm exec wrangler deploy --dry-run`.

See `README.md` for the full setup and deploy runbook.
