import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import zodAot from "zod-aot/vite";

export default defineConfig({
	plugins: [
		// autoDiscover executes matched files at build time, so keep the scope to
		// src/schemas.ts — it imports nothing but zod and has no side effects.
		zodAot({ autoDiscover: true, include: ["src/schemas"], verbose: true }),
		cloudflare(),
	],
	server: {
		// The local GitHub OAuth app registers http://localhost:8788/callback,
		// so vite dev must stay on the port `wrangler dev` used.
		port: 8788,
		strictPort: true,
	},
});
