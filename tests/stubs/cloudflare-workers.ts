// Test stub for the `cloudflare:workers` runtime module. In production the
// runtime injects the Worker `env`; github-handler.ts reads secrets from it at
// request time. Tests populate `env` before exercising those routes.
export const env: Record<string, string> = {};
