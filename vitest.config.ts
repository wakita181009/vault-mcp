import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const cloudflareWorkersStub = fileURLToPath(
	new URL("./tests/stubs/cloudflare-workers.ts", import.meta.url),
);

export default defineConfig({
	// `cloudflare:workers` is a runtime-only virtual module; point it at a stub so
	// modules that import the Worker `env` are testable under Node. A plugin
	// resolves the custom scheme, which vite's alias table does not intercept.
	plugins: [
		{
			name: "stub-cloudflare-workers",
			enforce: "pre",
			resolveId(id) {
				if (id === "cloudflare:workers") return cloudflareWorkersStub;
			},
		},
	],
	test: {
		server: {
			// Inline the deps that themselves import `cloudflare:workers` so the
			// stub plugin above resolves it instead of Node's ESM loader.
			deps: {
				inline: ["agents", "@cloudflare/workers-oauth-provider"],
			},
		},
		coverage: {
			provider: "v8",
			// lcov feeds Codecov; text/html are for local inspection.
			reporter: ["text", "html", "lcov"],
			include: ["src/**/*.ts"],
			// Type-only and generated files carry no executable coverage.
			exclude: ["src/env.d.ts"],
		},
	},
});
