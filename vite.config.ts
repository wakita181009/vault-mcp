import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import zodAot from "zod-aot/vite";

export default defineConfig({
	plugins: [
		// autoDiscover executes matched files at build time, so keep the scope to
		// src/schemas.ts — it imports nothing but zod and has no side effects.
		// The extension matters: include matching is substring-based, so a bare
		// "src/schemas" would also pull in a future src/schemas-*.ts.
		zodAot({ autoDiscover: true, include: ["src/schemas.ts"], verbose: true }),
		cloudflare(),
	],
	server: {
		// The local GitHub OAuth app registers http://localhost:8788/callback,
		// so vite dev must stay on the port `wrangler dev` used.
		port: 8788,
		strictPort: true,
	},
});
