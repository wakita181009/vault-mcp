# vault-mcp

Authenticated **remote MCP server** on Cloudflare Workers that exposes a private, GitHub-hosted
Obsidian vault **read-only** to both **claude.ai** (Web / Desktop / iPhone) and **Claude Code** —
one free deployment serving every Claude surface.

It reads the vault through the GitHub API, so the source repo can stay private and there is no
always-on machine to maintain. Deploy your own instance with C3 (one command) or clone it manually
— both are covered below. Your vault target is set via secrets, so the committed config ships generic.

## What it does

- **Auth:** GitHub OAuth via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
  Users sign in with GitHub; only logins in `VAULT_ALLOWED_GITHUB_LOGINS` get any tools at all.
- **Reads the vault** through the GitHub API using a **separate read-only fine-grained PAT**
  (`VAULT_GITHUB_TOKEN`), independent of the read/write PAT Obsidian Git uses to push.
- **Transport:** Streamable HTTP at `/mcp`.

### Tools

| Tool | Description |
| --- | --- |
| `list_notes` | List note (`.md`) paths, optionally scoped to a subdirectory. |
| `read_note` | Read the raw markdown of one note by repo-relative path. |
| `search_notes` | Content search (GitHub code search, indexed) + filename search, merged. |

## Two GitHub tokens, two jobs

| Purpose | Token | Scope |
| --- | --- | --- |
| **Who may log in** | GitHub **OAuth App** (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`) | `read:user` only |
| **What the server reads** | read-only **fine-grained PAT** (`VAULT_GITHUB_TOKEN`) | Contents: Read, limited to your vault repo |

Keeping them separate means logging in never grants repo write, and the read token is
scoped to exactly one repo. **Never reuse a read/write PAT here** (e.g. the one Obsidian Git
uses to push) — this server only ever needs read access.

## Access scope

Path visibility is controlled by two settings that default in `src/config.ts`; override
either per deploy with a secret of the same name (`wrangler secret put`):

- `VAULT_ALLOWED_PREFIXES` — if non-empty, only paths under these prefixes are exposed (default: empty = whole repo).
- `VAULT_DENIED_PREFIXES` — always hidden (default: `.git/,.obsidian/,.claude/`).

`read_note` also rejects absolute paths and `..` traversal. To hide additional folders,
override `VAULT_DENIED_PREFIXES` with your extra prefixes.

## Quick start (C3)

Scaffold your own copy with Cloudflare's [C3](https://developers.cloudflare.com/pages/get-started/c3/):

```bash
npm create cloudflare@latest vault-mcp -- --template wakita181009/vault-mcp
cd vault-mcp
```

That clones the project and installs dependencies — but not the one-time setup:
you still create the KV namespace, GitHub OAuth app, and read-only PAT, and set
the secrets. Continue with [Setup](#setup) from **step 2** (step 1 is done for
you). Cloning the repo directly works too; then start from step 0.

## Setup

### 0. Prereqs

```bash
pnpm install
pnpm exec wrangler login    # Cloudflare auth
```

### 1. Point it at your vault

Your vault target (`VAULT_OWNER` / `VAULT_REPO`) and login allowlist
(`VAULT_ALLOWED_GITHUB_LOGINS`) are **secrets**, set in step 5 — you don't edit
`wrangler.jsonc` to point it at your repo. The committed `wrangler.jsonc` ships
generic; its only per-deploy value is the KV namespace id (step 2). Everything
else defaults in `src/config.ts` and is optional — override any of these per deploy
with `wrangler secret put <NAME>`:

- `VAULT_BRANCH` — branch of the vault repo to read (default `main`).
- `VAULT_ALLOWED_PREFIXES` / `VAULT_DENIED_PREFIXES` — see [Access scope](#access-scope) above.

### 2. Create the KV namespace (stores OAuth grants)

```bash
pnpm exec wrangler kv namespace create OAUTH_KV
```

Put the returned `id` into `wrangler.jsonc` under `kv_namespaces[0].id`.

### 3. Create the read-only PAT for reading the vault

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:

- Resource owner: your account, Repository access: **Only** your vault repo
- Permissions: **Contents → Read-only**

Save the token for `VAULT_GITHUB_TOKEN` below.

### 4. Create the GitHub OAuth App (login)

You need **two** apps (or reuse one with a second callback): local + production.

GitHub → Settings → Developer settings → **OAuth Apps** → New:

- **Local:** Homepage `http://localhost:8788`, Callback `http://localhost:8788/callback`
- **Prod:** Homepage `https://vault-mcp.<subdomain>.workers.dev`, Callback `https://vault-mcp.<subdomain>.workers.dev/callback`

Note each app's Client ID and generate a Client Secret.

### 5a. Run locally

```bash
cp .dev.vars.example .dev.vars    # LOCAL OAuth app, PAT, vault owner/repo/logins
openssl rand -hex 32              # value for COOKIE_ENCRYPTION_KEY
pnpm dev                          # http://localhost:8788/mcp
```

Test with the MCP inspector:

```bash
pnpm dlx @modelcontextprotocol/inspector@latest
# connect to http://localhost:8788/mcp, complete the GitHub login
```

### 5b. Deploy to production

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_ID            # PROD OAuth app
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put COOKIE_ENCRYPTION_KEY       # openssl rand -hex 32
pnpm exec wrangler secret put VAULT_GITHUB_TOKEN          # read-only fine-grained PAT
pnpm exec wrangler secret put VAULT_OWNER                 # GitHub owner of the vault repo
pnpm exec wrangler secret put VAULT_REPO                  # vault repo name
pnpm exec wrangler secret put VAULT_ALLOWED_GITHUB_LOGINS # comma-separated allowed logins
pnpm run deploy
```

Endpoint: `https://vault-mcp.<subdomain>.workers.dev/mcp`

### 6. Connect the clients

- **claude.ai (Web):** Settings → Connectors → add custom connector with the `/mcp` URL.
  Registration is Web-only; it then syncs to Desktop and the iPhone app.
- **Claude Code:** `claude mcp add --transport http vault https://vault-mcp.<subdomain>.workers.dev/mcp`
  (completes the OAuth flow in the browser). Works even on a Mac that has not cloned the vault.

## Development

```bash
pnpm typecheck     # verify generated Worker types, then run tsc --noEmit
pnpm lint          # biome lint ./src
pnpm cf-typegen    # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm dev           # local Worker at :8788
```

Secrets are typed in `src/env.d.ts` (they are not part of the `wrangler types` output).
After changing `wrangler.jsonc` bindings/vars, rerun `pnpm cf-typegen`.

## Layout

```
src/
├── index.ts               # OAuthProvider + VaultMCP (McpAgent); tools + login allowlist
├── vault.ts               # GitHub API read layer: list/read/search + path-visibility policy
├── github-handler.ts      # GitHub OAuth login flow (Hono)
├── workers-oauth-utils.ts # OAuth state / CSRF / approval dialog (from the CF template)
├── utils.ts               # upstream OAuth token exchange helpers
└── env.d.ts               # secret bindings type augmentation
```

Derived from Cloudflare's `remote-mcp-github-oauth` template.
