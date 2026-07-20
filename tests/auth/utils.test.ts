import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchUpstreamAuthToken,
	getUpstreamAuthorizeUrl,
	redirectResponse,
} from "../../src/auth/utils";

const formResponse = (fields: Record<string, string>, status = 200): Response =>
	new Response(new URLSearchParams(fields), {
		status,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
	});

const tokenArgs = {
	client_id: "cid",
	client_secret: "secret",
	code: "the-code",
	redirect_uri: "https://mcp.example/callback",
	upstream_url: "https://github.com/login/oauth/access_token",
};

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

describe("fetchUpstreamAuthToken", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("returns the access token on a successful exchange", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => formResponse({ access_token: "gho_token" })));
		const [token, err] = await fetchUpstreamAuthToken(tokenArgs);
		expect(token).toBe("gho_token");
		expect(err).toBeNull();
	});

	it("returns a 500 response when the upstream call is not ok", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 401 })));
		const [token, err] = await fetchUpstreamAuthToken(tokenArgs);
		expect(token).toBeNull();
		expect(err?.status).toBe(500);
	});

	it("returns a 400 response when the access token is missing", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => formResponse({ scope: "read:user" })));
		const [token, err] = await fetchUpstreamAuthToken(tokenArgs);
		expect(token).toBeNull();
		expect(err?.status).toBe(400);
	});
});
