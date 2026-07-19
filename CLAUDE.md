# vault-mcp

Authenticated remote MCP (Cloudflare Workers) exposing the private `wakita181009/vault`
Obsidian vault **read-only** to claude.ai and Claude Code. Implements Layer 2 of the vault's
`claude-environment/` design notes.

## Architecture

- `@cloudflare/workers-oauth-provider` provides OAuth; GitHub is the login provider (`github-handler.ts`).
- `ALLOWED_GITHUB_LOGINS` (var) gates access — non-allowed logins get **zero** tools.
- The vault is read via the GitHub API using `VAULT_GITHUB_TOKEN` (a read-only fine-grained PAT),
  **separate** from the Obsidian Git read/write PAT.
- Transport: Streamable HTTP at `/mcp`. Durable Object class `VaultMCP`.

## Conventions

- Code/comments/docs: English. Comments explain **why**, not what.
- Immutability; small focused modules. All vault access is **read-only** — never add write tools
  (would defeat the point of a read-only PAT).
- Secrets live in `.dev.vars` (local) / `wrangler secret put` (prod); their types are in `src/env.d.ts`.
- After editing `wrangler.jsonc`, run `npm run cf-typegen`. Verify with `npm run type-check`
  and `npx wrangler deploy --dry-run`.

## Path safety

`vault.ts` enforces `VAULT_ALLOWED_PREFIXES` / `VAULT_DENIED_PREFIXES` and rejects `..` traversal
and absolute paths in `read_note`. Keep that policy intact when changing read logic.

See `README.md` for the full setup/deploy runbook.
