import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverOidcEndpoints } from "../../../../src/auth/providers/oidc/discovery";

const document = (issuer: string, overrides: Record<string, unknown> = {}) => ({
	issuer,
	authorization_endpoint: `${issuer}/authorize`,
	token_endpoint: `${issuer}/token`,
	userinfo_endpoint: `${issuer}/userinfo`,
	...overrides,
});

const stubDiscovery = (body: unknown, status = 200) => {
	const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
		Response.json(body, { status }),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
};

describe("discoverOidcEndpoints", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("fetches the well-known document and maps its endpoints", async () => {
		const issuer = "https://idp.example/one";
		const fetchMock = stubDiscovery(document(issuer));
		const endpoints = await discoverOidcEndpoints(issuer);
		expect(fetchMock.mock.calls[0][0]).toBe(`${issuer}/.well-known/openid-configuration`);
		expect(endpoints).toEqual({
			authorizeUrl: `${issuer}/authorize`,
			tokenUrl: `${issuer}/token`,
			userinfoUrl: `${issuer}/userinfo`,
		});
	});

	it("refuses to follow redirects and bounds the request with a timeout", async () => {
		const issuer = "https://idp.example/init";
		const fetchMock = stubDiscovery(document(issuer));
		await discoverOidcEndpoints(issuer);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(init.redirect).toBe("error");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("tolerates a trailing slash on the configured issuer", async () => {
		const issuer = "https://idp.example/slash";
		const fetchMock = stubDiscovery(document(issuer));
		await discoverOidcEndpoints(`${issuer}/`);
		expect(fetchMock.mock.calls[0][0]).toBe(`${issuer}/.well-known/openid-configuration`);
	});

	it("caches the document per issuer", async () => {
		const issuer = "https://idp.example/cached";
		const fetchMock = stubDiscovery(document(issuer));
		await discoverOidcEndpoints(issuer);
		await discoverOidcEndpoints(issuer);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not cache a failed lookup", async () => {
		const issuer = "https://idp.example/retry";
		stubDiscovery({ error: "down" }, 503);
		await expect(discoverOidcEndpoints(issuer)).rejects.toThrow(/503/);
		const fetchMock = stubDiscovery(document(issuer));
		await expect(discoverOidcEndpoints(issuer)).resolves.toBeDefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects a document whose issuer differs from the configured one", async () => {
		const issuer = "https://idp.example/mismatch";
		stubDiscovery(document("https://evil.example"));
		await expect(discoverOidcEndpoints(issuer)).rejects.toThrow(/issuer/);
	});

	it("rejects a document with a non-https endpoint", async () => {
		const issuer = "https://idp.example/plain";
		stubDiscovery(document(issuer, { token_endpoint: "http://idp.example/plain/token" }));
		await expect(discoverOidcEndpoints(issuer)).rejects.toThrow(/https/);
	});

	it("rejects a document missing the userinfo endpoint", async () => {
		const issuer = "https://idp.example/nouserinfo";
		stubDiscovery(document(issuer, { userinfo_endpoint: undefined }));
		await expect(discoverOidcEndpoints(issuer)).rejects.toThrow(/userinfo_endpoint/);
	});

	it("rejects a non-https issuer without fetching", async () => {
		const fetchMock = stubDiscovery({});
		await expect(discoverOidcEndpoints("http://idp.example")).rejects.toThrow(/https/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
