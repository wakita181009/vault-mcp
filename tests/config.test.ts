import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config";

// Minimal set of required secrets; optional overrides are intentionally omitted
// so tests can assert the in-code defaults kick in.
const REQUIRED = {
	GITHUB_CLIENT_ID: "client-id",
	GITHUB_CLIENT_SECRET: "client-secret",
	COOKIE_ENCRYPTION_KEY: "0".repeat(64),
	VAULT_GITHUB_TOKEN: "github_pat_example",
	VAULT_OWNER: "owner",
	VAULT_REPO: "repo",
	VAULT_ALLOWED_GITHUB_LOGINS: "owner",
};

function parse(overrides: Record<string, string> = {}) {
	return parseEnv({ ...REQUIRED, ...overrides } as unknown as Parameters<typeof parseEnv>[0]);
}

describe("parseEnv", () => {
	it("applies in-code defaults for omitted optional overrides", () => {
		const config = parse();
		expect(config.VAULT_BRANCH).toBe("main");
		expect(config.VAULT_ALLOWED_PREFIXES).toBe("");
		expect(config.VAULT_DENIED_PREFIXES).toBe(".git/,.obsidian/,.claude/,claude-projects/");
	});

	it("passes explicit optional overrides through unchanged", () => {
		const config = parse({
			VAULT_BRANCH: "develop",
			VAULT_ALLOWED_PREFIXES: "notes/",
			VAULT_DENIED_PREFIXES: "secret/",
		});
		expect(config.VAULT_BRANCH).toBe("develop");
		expect(config.VAULT_ALLOWED_PREFIXES).toBe("notes/");
		expect(config.VAULT_DENIED_PREFIXES).toBe("secret/");
	});

	it("throws naming the missing required secret", () => {
		const { VAULT_OWNER: _omit, ...withoutOwner } = REQUIRED;
		expect(() => parseEnv(withoutOwner as unknown as Parameters<typeof parseEnv>[0])).toThrow(
			/VAULT_OWNER/,
		);
	});

	it("rejects a classic (non-fine-grained) PAT", () => {
		expect(() => parse({ VAULT_GITHUB_TOKEN: "ghp_classic" })).toThrow(/VAULT_GITHUB_TOKEN/);
	});

	it("rejects a too-short cookie key", () => {
		expect(() => parse({ COOKIE_ENCRYPTION_KEY: "short" })).toThrow(/COOKIE_ENCRYPTION_KEY/);
	});
});
