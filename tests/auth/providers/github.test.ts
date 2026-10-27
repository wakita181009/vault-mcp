import { describe, expect, it } from "vitest";
import { githubProvider } from "../../../src/auth/providers/github";

const asEnv = (env: Record<string, unknown>) => env as unknown as Env;

describe("githubProvider", () => {
	it("reads the GitHub OAuth app credentials and allowlist from env", () => {
		const env = asEnv({
			GITHUB_CLIENT_ID: "cid",
			GITHUB_CLIENT_SECRET: "secret",
			VAULT_ALLOWED_GITHUB_LOGINS: "alice, bob",
		});
		expect(githubProvider.credentials(env)).toEqual({ clientId: "cid", clientSecret: "secret" });
		expect(githubProvider.allowedLogins(env)).toEqual(["alice", "bob"]);
	});

	it("yields empty credentials when the GitHub OAuth app keys are unset", () => {
		expect(githubProvider.credentials(asEnv({}))).toEqual({ clientId: "", clientSecret: "" });
	});

	it("exposes its static endpoints", async () => {
		await expect(githubProvider.endpoints(asEnv({}))).resolves.toEqual({
			authorizeUrl: "https://github.com/login/oauth/authorize",
			tokenUrl: "https://github.com/login/oauth/access_token",
		});
	});
});
