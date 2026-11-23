import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config";
import { storageFromEnv } from "../../src/storage";
import { GitHubStorage } from "../../src/storage/github";
import { R2Storage } from "../../src/storage/r2";
import { S3Storage } from "../../src/storage/s3";

const AUTH = {
	GITHUB_CLIENT_ID: "client-id",
	GITHUB_CLIENT_SECRET: "client-secret",
	COOKIE_ENCRYPTION_KEY: "0".repeat(64),
	VAULT_ALLOWED_GITHUB_LOGINS: "owner",
};

const build = (env: Record<string, unknown>) => {
	const raw = env as unknown as Env;
	return storageFromEnv(parseEnv(raw), raw);
};

describe("storageFromEnv", () => {
	it("builds the GitHub backend by default", () => {
		const storage = build({
			...AUTH,
			VAULT_GITHUB_TOKEN: "github_pat_example",
			VAULT_OWNER: "owner",
			VAULT_REPO: "repo",
		});
		expect(storage).toBeInstanceOf(GitHubStorage);
	});

	it("builds the R2 backend from the VAULT_BUCKET binding", () => {
		const storage = build({ ...AUTH, VAULT_STORAGE: "r2", VAULT_BUCKET: {} });
		expect(storage).toBeInstanceOf(R2Storage);
	});

	it("fails fast when r2 is selected but the binding is missing", () => {
		expect(() => build({ ...AUTH, VAULT_STORAGE: "r2" })).toThrow(/VAULT_BUCKET/);
	});

	it("builds the S3 backend from its secrets", () => {
		const storage = build({
			...AUTH,
			VAULT_STORAGE: "s3",
			VAULT_S3_BUCKET: "vault",
			VAULT_S3_REGION: "us-east-1",
			VAULT_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
			VAULT_S3_SECRET_ACCESS_KEY: "secret",
		});
		expect(storage).toBeInstanceOf(S3Storage);
	});
});
