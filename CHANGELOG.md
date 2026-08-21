# Changelog

## [0.2.0](https://github.com/wakita181009/vault-mcp/compare/v0.1.0...v0.2.0) (2026-08-21)


### Features

* add delete_note tool ([#4](https://github.com/wakita181009/vault-mcp/issues/4)) ([403a76b](https://github.com/wakita181009/vault-mcp/commit/403a76b214d86ddab470edd4d4685e5945226a3c))

## [0.1.0](https://github.com/wakita181009/vault-mcp/compare/v0.0.1...v0.1.0) (2026-07-21)


### Features

* add write_note tool for creating and overwriting notes ([00cc157](https://github.com/wakita181009/vault-mcp/commit/00cc157f89092386a3b1e81356601d805ff72988))
* scaffold authenticated read-only vault MCP on Cloudflare Workers ([5cc8cf6](https://github.com/wakita181009/vault-mcp/commit/5cc8cf6f76f1f37e5b4f18eee7207131d0968029))
* validate Worker env at startup with zod ([95280c4](https://github.com/wakita181009/vault-mcp/commit/95280c4d269cc367b3508d5b4c266edff5d8971d))


### Bug Fixes

* drop dead default("main") on VAULT_BRANCH schema ([0f1828c](https://github.com/wakita181009/vault-mcp/commit/0f1828c11762ca4a8028080b352d0a49b538294f))
* preserve OAuth cookies and type generation ([acbf560](https://github.com/wakita181009/vault-mcp/commit/acbf560f4383138dae1ac89efc34994b372656c0))
* validate authorization code at /callback boundary ([d796875](https://github.com/wakita181009/vault-mcp/commit/d7968754700e5cbb358eff434a2cef1b89109f52))
