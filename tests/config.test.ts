import { describe, expect, it } from "vitest";
import { parseEnv, type VaultEnvConfig } from "../src/config";

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

function branchOf(config: VaultEnvConfig): string | undefined {
	return config.VAULT_STORAGE === "github" ? config.VAULT_BRANCH : undefined;
}

describe("parseEnv", () => {
	it("applies in-code defaults for omitted optional overrides", () => {
		const config = parse();
		expect(branchOf(config)).toBe("main");
		expect(config.VAULT_ALLOWED_PREFIXES).toBe("");
		expect(config.VAULT_DENIED_PREFIXES).toBe(".git/,.obsidian/,.claude/");
	});

	it("passes explicit optional overrides through unchanged", () => {
		const config = parse({
			VAULT_BRANCH: "develop",
			VAULT_ALLOWED_PREFIXES: "notes/",
			VAULT_DENIED_PREFIXES: "secret/",
		});
		expect(branchOf(config)).toBe("develop");
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

	it("labels a top-level (non-object) env as (root)", () => {
		expect(() => parseEnv("nope" as unknown as Parameters<typeof parseEnv>[0])).toThrow(
			/\(root\)/,
		);
	});
});

describe("parseEnv AUTH_PROVIDER", () => {
	const GOOGLE = {
		AUTH_PROVIDER: "google",
		GOOGLE_CLIENT_ID: "gcid",
		GOOGLE_CLIENT_SECRET: "gsecret",
		COOKIE_ENCRYPTION_KEY: "0".repeat(64),
		VAULT_GITHUB_TOKEN: "github_pat_example",
		VAULT_OWNER: "owner",
		VAULT_REPO: "repo",
		VAULT_ALLOWED_GOOGLE_EMAILS: "owner@example.com",
	};

	it("defaults to github when unset", () => {
		expect(parse().AUTH_PROVIDER).toBe("github");
	});

	it("accepts a google deploy without any GitHub OAuth app keys", () => {
		const config = parseEnv(GOOGLE as unknown as Parameters<typeof parseEnv>[0]);
		expect(config.AUTH_PROVIDER).toBe("google");
		expect(branchOf(config)).toBe("main");
	});

	it("requires the Google OAuth app keys when google is selected", () => {
		const { GOOGLE_CLIENT_SECRET: _omit, ...without } = GOOGLE;
		expect(() => parseEnv(without as unknown as Parameters<typeof parseEnv>[0])).toThrow(
			/GOOGLE_CLIENT_SECRET/,
		);
	});

	it("requires the Google allowlist when google is selected", () => {
		const { VAULT_ALLOWED_GOOGLE_EMAILS: _omit, ...without } = GOOGLE;
		expect(() => parseEnv(without as unknown as Parameters<typeof parseEnv>[0])).toThrow(
			/VAULT_ALLOWED_GOOGLE_EMAILS/,
		);
	});

	it("rejects an unknown provider", () => {
		expect(() => parse({ AUTH_PROVIDER: "okta" })).toThrow(/AUTH_PROVIDER/);
	});

	const OIDC = {
		AUTH_PROVIDER: "oidc",
		OIDC_ISSUER_URL: "https://login.example/tenant/v2.0",
		OIDC_CLIENT_ID: "ocid",
		OIDC_CLIENT_SECRET: "osecret",
		COOKIE_ENCRYPTION_KEY: "0".repeat(64),
		VAULT_GITHUB_TOKEN: "github_pat_example",
		VAULT_OWNER: "owner",
		VAULT_REPO: "repo",
		VAULT_ALLOWED_OIDC_EMAILS: "owner@example.com",
	};
	const parseOidc = (overrides: Record<string, unknown> = {}) =>
		parseEnv({ ...OIDC, ...overrides } as unknown as Parameters<typeof parseEnv>[0]);

	it("accepts an oidc deploy with only the OIDC keys", () => {
		const config = parseOidc();
		expect(config.AUTH_PROVIDER).toBe("oidc");
		expect(branchOf(config)).toBe("main");
	});

	it("requires an https issuer URL", () => {
		expect(() => parseOidc({ OIDC_ISSUER_URL: "http://login.example" })).toThrow(
			/OIDC_ISSUER_URL/,
		);
		expect(() => parseOidc({ OIDC_ISSUER_URL: "not a url" })).toThrow(/OIDC_ISSUER_URL/);
		expect(() => parseOidc({ OIDC_ISSUER_URL: "https://login.example/?x=1" })).toThrow(
			/query string/,
		);
	});

	it("requires the OIDC client keys and allowlist", () => {
		expect(() => parseOidc({ OIDC_CLIENT_SECRET: undefined })).toThrow(/OIDC_CLIENT_SECRET/);
		expect(() => parseOidc({ VAULT_ALLOWED_OIDC_EMAILS: undefined })).toThrow(
			/VAULT_ALLOWED_OIDC_EMAILS/,
		);
	});

	it("only accepts true/false for the unverified-email opt-in", () => {
		expect(parseOidc({ OIDC_ALLOW_UNVERIFIED_EMAIL: "true" }).AUTH_PROVIDER).toBe("oidc");
		expect(() => parseOidc({ OIDC_ALLOW_UNVERIFIED_EMAIL: "yes" })).toThrow(
			/OIDC_ALLOW_UNVERIFIED_EMAIL/,
		);
	});
});

describe("parseEnv VAULT_STORAGE", () => {
	const { VAULT_GITHUB_TOKEN: _t, VAULT_OWNER: _o, VAULT_REPO: _r, ...AUTH_ONLY } = REQUIRED;
	const parseR2 = (overrides: Record<string, string> = {}) =>
		parseEnv({ ...AUTH_ONLY, VAULT_STORAGE: "r2", ...overrides } as unknown as Parameters<
			typeof parseEnv
		>[0]);

	it("defaults to github when unset", () => {
		expect(parse().VAULT_STORAGE).toBe("github");
	});

	it("accepts an r2 deploy without any GitHub vault keys", () => {
		const config = parseR2();
		expect(config.VAULT_STORAGE).toBe("r2");
		expect(config.AUTH_PROVIDER).toBe("github");
	});

	it("still requires the GitHub vault keys when github storage is selected", () => {
		expect(() =>
			parseEnv(AUTH_ONLY as unknown as Parameters<typeof parseEnv>[0]),
		).toThrow(/VAULT_GITHUB_TOKEN/);
	});

	it("rejects an unknown backend", () => {
		expect(() => parseR2({ VAULT_STORAGE: "dropbox" })).toThrow(/VAULT_STORAGE/);
	});

	describe("s3", () => {
		const S3_KEYS = {
			VAULT_STORAGE: "s3",
			VAULT_S3_BUCKET: "vault",
			VAULT_S3_REGION: "us-east-1",
			VAULT_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
			VAULT_S3_SECRET_ACCESS_KEY: "secret",
		};
		const parseS3 = (overrides: Record<string, string> = {}) => parseR2({ ...S3_KEYS, ...overrides });
		const scanOf = (config: VaultEnvConfig) =>
			config.VAULT_STORAGE === "s3" ? config.VAULT_S3_SEARCH_SCAN : undefined;

		it("accepts an s3 deploy without an endpoint and defaults the scan budget", () => {
			const config = parseS3();
			expect(config.VAULT_STORAGE).toBe("s3");
			expect(scanOf(config)).toBe(40);
		});

		it("parses a raised scan budget and rejects out-of-range or non-numeric ones", () => {
			expect(scanOf(parseS3({ VAULT_S3_SEARCH_SCAN: "500" }))).toBe(500);
			for (const bad of ["0", "-1", "abc", "1.5", "1001"]) {
				expect(() => parseS3({ VAULT_S3_SEARCH_SCAN: bad })).toThrow(/VAULT_S3_SEARCH_SCAN/);
			}
		});

		it("requires https for the endpoint except on localhost", () => {
			expect(() => parseS3({ VAULT_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com" })).not.toThrow();
			expect(() => parseS3({ VAULT_S3_ENDPOINT: "http://localhost:9000" })).not.toThrow();
			expect(() => parseS3({ VAULT_S3_ENDPOINT: "http://minio.example.com" })).toThrow(/VAULT_S3_ENDPOINT/);
			expect(() => parseS3({ VAULT_S3_ENDPOINT: "https://s3.example.com/?x=1" })).toThrow(
				/VAULT_S3_ENDPOINT/,
			);
			// Scheme-less: reported as an issue on the key, not a bare TypeError.
			expect(() => parseS3({ VAULT_S3_ENDPOINT: "s3.example.com" })).toThrow(/VAULT_S3_ENDPOINT/);
		});

		it("requires the bucket, region, and keys", () => {
			expect(() =>
				parseR2({ VAULT_STORAGE: "s3" }),
			).toThrow(/VAULT_S3_BUCKET[\s\S]*VAULT_S3_REGION[\s\S]*VAULT_S3_ACCESS_KEY_ID[\s\S]*VAULT_S3_SECRET_ACCESS_KEY/);
		});
	});

	it("reports auth and storage errors together", () => {
		const { GITHUB_CLIENT_ID: _c, ...noClient } = AUTH_ONLY;
		expect(() => parseEnv(noClient as unknown as Parameters<typeof parseEnv>[0])).toThrow(
			/GITHUB_CLIENT_ID[\s\S]*VAULT_GITHUB_TOKEN/,
		);
	});
});
