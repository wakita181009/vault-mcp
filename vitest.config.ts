import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
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
