import { describe, expect, it } from "vitest";
import { authProviderFromEnv } from "../../../src/auth/providers";
import { githubProvider } from "../../../src/auth/providers/github";
import { googleProvider } from "../../../src/auth/providers/google";
import { oidcProvider } from "../../../src/auth/providers/oidc";

describe("authProviderFromEnv", () => {
	it("defaults to GitHub", () => {
		expect(authProviderFromEnv({})).toBe(githubProvider);
	});

	it("selects Google", () => {
		expect(authProviderFromEnv({ AUTH_PROVIDER: "google" })).toBe(googleProvider);
	});

	it("selects the generic OIDC provider", () => {
		expect(authProviderFromEnv({ AUTH_PROVIDER: "oidc" })).toBe(oidcProvider);
	});

	it("throws on an unknown provider", () => {
		expect(() => authProviderFromEnv({ AUTH_PROVIDER: "okta" } as never)).toThrow(
			/AUTH_PROVIDER/,
		);
	});
});
