import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchUpstreamAuthToken,
	getUpstreamAuthorizeUrl,
	redirectResponse,
} from "../../src/auth/upstream";

const jsonResponse = (fields: Record<string, string>, status = 200): Response =>
	Response.json(fields, { status });

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
		const fetchMock = vi.fn(async () => jsonResponse({ access_token: "gho_token" }));
		vi.stubGlobal("fetch", fetchMock);
		const [token, err] = await fetchUpstreamAuthToken(tokenArgs);
		expect(token).toBe("gho_token");
		expect(err).toBeNull();
	});

	it("posts a standard code grant and asks for a JSON response", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ access_token: "gho_token" }));
		vi.stubGlobal("fetch", fetchMock);
		await fetchUpstreamAuthToken(tokenArgs);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(tokenArgs.upstream_url);
		expect(new Headers(init.headers).get("Accept")).toBe("application/json");
		const body = new URLSearchParams(String(init.body));
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("the-code");
		expect(body.get("redirect_uri")).toBe(tokenArgs.redirect_uri);
	});

	it("returns a 400 response when the body is not JSON", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("access_token=x")));
		const [token, err] = await fetchUpstreamAuthToken(tokenArgs);
		expect(token).toBeNull();
		expect(err?.status).toBe(400);
	});

	it("returns a 500 response when the upstream call is not ok", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 401 })));
		const [token, err] = await fetchUpstreamAuthToken(tokenArgs);
		expect(token).toBeNull();
		expect(err?.status).toBe(500);
	});

	it("returns a 400 response when the access token is missing", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ scope: "read:user" })));
		const [token, err] = await fetchUpstreamAuthToken(tokenArgs);
		expect(token).toBeNull();
		expect(err?.status).toBe(400);
	});
});
