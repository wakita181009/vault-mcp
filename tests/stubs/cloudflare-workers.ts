// Test stub for the `cloudflare:workers` runtime module. In production the
// runtime injects the Worker `env`; the `agents` and oauth-provider packages
// import it at module load, so it must resolve under Node even though our own
// code reads env per request via Hono.
export const env: Record<string, string> = {};
