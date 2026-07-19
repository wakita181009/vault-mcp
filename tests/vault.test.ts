import { describe, expect, it } from "vitest";
import { isPathVisible, normalizePath, parseList, type VaultConfig } from "../src/vault";

const baseConfig: VaultConfig = {
	owner: "o",
	repo: "r",
	branch: "b",
	token: "t",
	allowedPrefixes: [],
	deniedPrefixes: [],
};

const withPolicy = (allowed: string[], denied: string[]): VaultConfig => ({
	...baseConfig,
	allowedPrefixes: allowed,
	deniedPrefixes: denied,
});

describe("normalizePath", () => {
	it("strips leading slashes and surrounding whitespace", () => {
		expect(normalizePath("  /notes/a.md  ")).toBe("notes/a.md");
		expect(normalizePath("///a/b.md")).toBe("a/b.md");
	});

	it("returns null for empty or whitespace-only input", () => {
		expect(normalizePath("")).toBeNull();
		expect(normalizePath("   ")).toBeNull();
		expect(normalizePath("/")).toBeNull();
	});

	it("rejects backslashes and null bytes", () => {
		expect(normalizePath("a\\b")).toBeNull();
		expect(normalizePath("a\0b")).toBeNull();
	});

	it("rejects any `..` path segment (traversal)", () => {
		expect(normalizePath("../a.md")).toBeNull();
		expect(normalizePath("a/../b.md")).toBeNull();
		expect(normalizePath("a/..")).toBeNull();
	});

	it("allows `..` when it is part of a name, not a whole segment", () => {
		expect(normalizePath("a..b/c.md")).toBe("a..b/c.md");
		expect(normalizePath("..hidden.md")).toBe("..hidden.md");
	});

	it("passes through a normal nested path", () => {
		expect(normalizePath("user_profile/identity.md")).toBe("user_profile/identity.md");
	});
});

describe("isPathVisible", () => {
	it("returns true for everything when no allow/deny policy is set", () => {
		expect(isPathVisible("anything/x.md", baseConfig)).toBe(true);
	});

	it("hides paths under a denied prefix (deny wins)", () => {
		const config = withPolicy([], ["secret"]);
		expect(isPathVisible("secret/x.md", config)).toBe(false);
		expect(isPathVisible("secret", config)).toBe(false);
		expect(isPathVisible("public/x.md", config)).toBe(true);
	});

	it("only exposes paths under an allowed prefix when allowlist is non-empty", () => {
		const config = withPolicy(["notes"], []);
		expect(isPathVisible("notes/a.md", config)).toBe(true);
		expect(isPathVisible("other/a.md", config)).toBe(false);
	});

	it("lets deny take precedence over allow", () => {
		const config = withPolicy(["notes"], ["notes/private"]);
		expect(isPathVisible("notes/pub.md", config)).toBe(true);
		expect(isPathVisible("notes/private/secret.md", config)).toBe(false);
	});

	it("matches prefixes on segment boundaries, not raw substrings", () => {
		const config = withPolicy(["note"], []);
		// "notes/..." must NOT be considered under the "note" prefix.
		expect(isPathVisible("notes/a.md", config)).toBe(false);
		expect(isPathVisible("note/a.md", config)).toBe(true);
	});

	it("normalizes trailing slashes in configured prefixes", () => {
		const config = withPolicy([], ["secret/"]);
		expect(isPathVisible("secret/a.md", config)).toBe(false);
	});

	it("returns false for paths that fail normalization", () => {
		expect(isPathVisible("../escape.md", baseConfig)).toBe(false);
		expect(isPathVisible("a\\b.md", baseConfig)).toBe(false);
	});
});

describe("parseList", () => {
	it("returns an empty array for undefined or empty input", () => {
		expect(parseList(undefined)).toEqual([]);
		expect(parseList("")).toEqual([]);
	});

	it("splits on commas, trimming and dropping empty entries", () => {
		expect(parseList("a, b ,c")).toEqual(["a", "b", "c"]);
		expect(parseList("a,,b, ,c")).toEqual(["a", "b", "c"]);
	});
});
