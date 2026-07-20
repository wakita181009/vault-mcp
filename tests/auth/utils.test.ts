import { describe, expect, it } from "vitest";
import { getUpstreamAuthorizeUrl, redirectResponse } from "../../src/auth/utils";

describe("getUpstreamAuthorizeUrl", () => {
	it("builds the upstream URL with all OAuth params", () => {
		const url = getUpstreamAuthorizeUrl({
			upstream_url: "https://github.com/login/oauth/authorize",
			client_id: "cid",
			scope: "read:user",
			redirect_uri: "https://mcp.example/callback",
			state: "state-123",
		});
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(parsed.searchParams.get("client_id")).toBe("cid");
		expect(parsed.searchParams.get("redirect_uri")).toBe("https://mcp.example/callback");
		expect(parsed.searchParams.get("scope")).toBe("read:user");
		expect(parsed.searchParams.get("response_type")).toBe("code");
		expect(parsed.searchParams.get("state")).toBe("state-123");
	});

	it("url-encodes parameter values", () => {
		const url = getUpstreamAuthorizeUrl({
			upstream_url: "https://github.com/login/oauth/authorize",
			client_id: "cid",
			scope: "read:user",
			redirect_uri: "https://mcp.example/callback?foo=bar baz",
			state: "a/b+c=",
		});
		const parsed = new URL(url);
		expect(parsed.searchParams.get("redirect_uri")).toBe(
			"https://mcp.example/callback?foo=bar baz",
		);
		expect(parsed.searchParams.get("state")).toBe("a/b+c=");
	});
});

describe("redirectResponse", () => {
	it("preserves repeated Set-Cookie headers", () => {
		const headers = new Headers();
		headers.append("Set-Cookie", "approved-client=client-1; HttpOnly");
		headers.append("Set-Cookie", "session-binding=state-1; HttpOnly");

		const response = redirectResponse("https://github.com/login/oauth/authorize", headers);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://github.com/login/oauth/authorize");
		expect(response.headers.getSetCookie()).toEqual([
			"approved-client=client-1; HttpOnly",
			"session-binding=state-1; HttpOnly",
		]);
	});
});
