# Changelog

## [0.6.2](https://github.com/wakita181009/vault-mcp/compare/v0.6.1...v0.6.2) (2026-11-25)


### Bug Fixes

* refuse non-allowlisted identities at the login callback ([#104](https://github.com/wakita181009/vault-mcp/issues/104)) ([c6691cb](https://github.com/wakita181009/vault-mcp/commit/c6691cbc5ee2b7fd0d9dcec39f4ccabc67576001))

## [0.6.1](https://github.com/wakita181009/vault-mcp/compare/v0.6.0...v0.6.1) (2026-11-24)


### Bug Fixes

* serve MCP statelessly instead of one Durable Object per session ([#102](https://github.com/wakita181009/vault-mcp/issues/102)) ([f59944e](https://github.com/wakita181009/vault-mcp/commit/f59944e80d11ead1e96125f778b46741bd8fb59c))

## [0.6.0](https://github.com/wakita181009/vault-mcp/compare/v0.5.2...v0.6.0) (2026-11-23)


### Features

* add S3-compatible storage backend ([#100](https://github.com/wakita181009/vault-mcp/issues/100)) ([eff94d6](https://github.com/wakita181009/vault-mcp/commit/eff94d64034df87827f07891d50a28dfc5a7daad))

## [0.5.2](https://github.com/wakita181009/vault-mcp/compare/v0.5.1...v0.5.2) (2026-11-23)


### Bug Fixes

* harden search against foreign-repo hits and empty queries ([#91](https://github.com/wakita181009/vault-mcp/issues/91)) ([ca5ba3c](https://github.com/wakita181009/vault-mcp/commit/ca5ba3cf84c975377f5a8a98d774ed816f63dad1))
* stop storing the upstream token and leaking 500 details ([#92](https://github.com/wakita181009/vault-mcp/issues/92)) ([d27a808](https://github.com/wakita181009/vault-mcp/commit/d27a8081857dfaf8cf081db6eecce6bf04ede07f))

## [0.5.1](https://github.com/wakita181009/vault-mcp/compare/v0.5.0...v0.5.1) (2026-11-22)


### Bug Fixes

* a malformed approved-clients cookie whose payload is not valid base64 ([86821d4](https://github.com/wakita181009/vault-mcp/commit/86821d460eef57f23142eab01cfab0dd42a753fd))

## [0.5.0](https://github.com/wakita181009/vault-mcp/compare/v0.4.0...v0.5.0) (2026-11-22)


### Features

* add Cloudflare R2 storage backend ([#83](https://github.com/wakita181009/vault-mcp/issues/83)) ([c9ba9c1](https://github.com/wakita181009/vault-mcp/commit/c9ba9c128e709eb6c73008b0cc5bf7a0afa702ba))

## [0.4.0](https://github.com/wakita181009/vault-mcp/compare/v0.3.0...v0.4.0) (2026-10-27)


### Features

* add a generic OIDC login provider and rebuild Google on it ([#65](https://github.com/wakita181009/vault-mcp/issues/65)) ([f7b8eaf](https://github.com/wakita181009/vault-mcp/commit/f7b8eafe4a2f88877398335806957cbff1851e3c))
* make the login provider selectable (GitHub or Google) ([#63](https://github.com/wakita181009/vault-mcp/issues/63)) ([fa1c551](https://github.com/wakita181009/vault-mcp/commit/fa1c5512aeeafe7aee4cdd223ee1ce54a3169b74))

## [0.3.0](https://github.com/wakita181009/vault-mcp/compare/v0.2.0...v0.3.0) (2026-10-27)


### Features

* build with Vite and compile MCP tool schemas with zod-aot ([2bc99d9](https://github.com/wakita181009/vault-mcp/commit/2bc99d9991f2db14c1bee7e62c143bdd8d156feb))


### Bug Fixes

* keep worker-configuration.d.ts independent of local .dev.vars ([#61](https://github.com/wakita181009/vault-mcp/issues/61)) ([f3f7c2a](https://github.com/wakita181009/vault-mcp/commit/f3f7c2a9fd468603afa49714fb23f8a04fa744d6))
* pin zod-aot include to src/schemas.ts (include matching is substring-based) ([8b54d0a](https://github.com/wakita181009/vault-mcp/commit/8b54d0a9e660f96bb964fab59be8b70dad2c76bd))

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
