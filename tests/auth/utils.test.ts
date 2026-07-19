import { describe, expect, it } from "vitest";
import { getUpstreamAuthorizeUrl } from "../../src/auth/utils";

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

	it("omits state when not provided", () => {
		const url = getUpstreamAuthorizeUrl({
			upstream_url: "https://github.com/login/oauth/authorize",
			client_id: "cid",
			scope: "read:user",
			redirect_uri: "https://mcp.example/callback",
		});
		expect(new URL(url).searchParams.has("state")).toBe(false);
	});
});
