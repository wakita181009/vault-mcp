import { beforeEach, describe, expect, it, vi } from "vitest";

const octo = vi.hoisted(() => {
	const getAuthenticated = vi.fn();
	return {
		getAuthenticated,
		Octokit: vi.fn(function Octokit() {
			return { rest: { users: { getAuthenticated } } };
		}),
	};
});
vi.mock("octokit", () => ({ Octokit: octo.Octokit }));

import { createAuthHandler } from "../../src/auth/handler";
import { githubProvider } from "../../src/auth/providers/github";
import { googleProvider } from "../../src/auth/providers/google";
import { oidcProvider } from "../../src/auth/providers/oidc";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
} from "../../src/auth/workers-oauth-utils";

const SECRET = "test-cookie-signing-secret-0000000000";

const makeKV = () => {
	const store = new Map<string, string>();
	return {
		get: vi.fn(async (k: string) => store.get(k) ?? null),
		put: vi.fn(async (k: string, v: string) => {
			store.set(k, v);
		}),
		delete: vi.fn(async (k: string) => {
			store.delete(k);
		}),
		store,
	};
};

type Kv = ReturnType<typeof makeKV>;

let kv: Kv;
let oauthProvider: {
	parseAuthRequest: ReturnType<typeof vi.fn>;
	lookupClient: ReturnType<typeof vi.fn>;
	completeAuthorization: ReturnType<typeof vi.fn>;
};

const reqInfo = {
	clientId: "c1",
	scope: ["read"],
	redirectUri: "https://claude.ai/cb",
	responseType: "code",
	state: "abc",
};

function appEnv(): Record<string, unknown> {
	return {
		OAUTH_PROVIDER: oauthProvider,
		OAUTH_KV: kv,
		GITHUB_CLIENT_ID: "cid",
		GITHUB_CLIENT_SECRET: "secret",
		COOKIE_ENCRYPTION_KEY: SECRET,
	};
}

const GitHubHandler = createAuthHandler(githubProvider);
const request = (path: string, init?: RequestInit) =>
	GitHubHandler.request(path, init, appEnv() as never);

beforeEach(() => {
	vi.clearAllMocks();
	kv = makeKV();
	oauthProvider = {
		parseAuthRequest: vi.fn(async () => ({ ...reqInfo })),
		lookupClient: vi.fn(async () => ({
			clientId: "c1",
			clientName: "Claude",
			redirectUris: ["https://claude.ai/cb"],
		})),
		completeAuthorization: vi.fn(async () => ({ redirectTo: "https://claude.ai/cb?code=granted" })),
	};
});

describe("GET /authorize", () => {
	it("400s when the request carries no client id", async () => {
		oauthProvider.parseAuthRequest = vi.fn(async () => ({ clientId: undefined }));
		const res = await request("https://mcp.example/authorize");
		expect(res.status).toBe(400);
	});

	it("renders the approval dialog for a new client", async () => {
		const res = await request("https://mcp.example/authorize");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		expect(await res.text()).toContain("is requesting access");
	});

	it("skips the dialog and redirects when the client is already approved", async () => {
		const approvedCookie = await addApprovedClient(
			new Request("https://mcp.example/"),
			"c1",
			SECRET,
		);
		const res = await request("https://mcp.example/authorize", {
			headers: { Cookie: approvedCookie.split(";")[0] },
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("github.com/login/oauth/authorize");
		expect(kv.put).toHaveBeenCalled();
	});
});

describe("POST /authorize", () => {
	const postForm = (fields: Record<string, string>, cookie?: string) => {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		return request("https://mcp.example/authorize", {
			method: "POST",
			body,
			headers: cookie ? { Cookie: cookie } : {},
		});
	};

	const validState = () => btoa(JSON.stringify({ oauthReqInfo: reqInfo }));

	it("redirects to GitHub with approval + session cookies on success", async () => {
		const { token, setCookie } = generateCSRFProtection();
		const res = await postForm(
			{ csrf_token: token, state: validState() },
			setCookie.split(";")[0],
		);
		expect(res.status).toBe(302);
		expect(res.headers.getSetCookie().length).toBe(2);
	});

	it("400s when state is missing", async () => {
		const { token, setCookie } = generateCSRFProtection();
		const res = await postForm({ csrf_token: token }, setCookie.split(";")[0]);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Missing state");
	});

	it("400s on undecodable state", async () => {
		const { token, setCookie } = generateCSRFProtection();
		const res = await postForm(
			{ csrf_token: token, state: "!!!not-base64!!!" },
			setCookie.split(";")[0],
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Invalid state data");
	});

	it("400s when the decoded state has no client id", async () => {
		const { token, setCookie } = generateCSRFProtection();
		const res = await postForm(
			{ csrf_token: token, state: btoa(JSON.stringify({ oauthReqInfo: {} })) },
			setCookie.split(";")[0],
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Invalid request");
	});

	it("500s with the message when state storage fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		kv.put.mockRejectedValueOnce(new Error("kv down"));
		const { token, setCookie } = generateCSRFProtection();
		const res = await postForm({ csrf_token: token, state: validState() }, setCookie.split(";")[0]);
		expect(res.status).toBe(500);
		expect(await res.text()).toContain("kv down");
	});

	it("stringifies a non-Error throw in the 500 message", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		kv.put.mockRejectedValueOnce("plain string failure");
		const { token, setCookie } = generateCSRFProtection();
		const res = await postForm({ csrf_token: token, state: validState() }, setCookie.split(";")[0]);
		expect(res.status).toBe(500);
		expect(await res.text()).toContain("plain string failure");
	});

	it("returns the OAuthError response when CSRF validation fails", async () => {
		const res = await postForm({ csrf_token: "x", state: validState() });
		expect(res.status).toBe(400);
		expect(res.headers.get("Content-Type")).toContain("application/json");
	});
});

describe("GET /callback", () => {
	const seedState = async () => {
		const { stateToken } = await createOAuthState(reqInfo as never, kv as never);
		const { setCookie } = await bindStateToSession(stateToken);
		return { stateToken, consented: setCookie.split(";")[0].split("=").slice(1).join("=") };
	};

	const callback = async (params: string, consented: string | null) =>
		request(`https://mcp.example/callback?${params}`, {
			headers: consented ? { Cookie: `__Host-CONSENTED_STATE=${consented}` } : {},
		});

	it("completes authorization and redirects on a valid callback", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ access_token: "gho_token" }),
			),
		);
		octo.getAuthenticated.mockResolvedValue({
			data: { login: "alice", name: "Alice", email: "alice@example.com" },
		});
		const { stateToken, consented } = await seedState();
		const res = await callback(`state=${stateToken}&code=the-code`, consented);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("https://claude.ai/cb?code=granted");
		expect(oauthProvider.completeAuthorization).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("returns an OAuthError when state validation fails", async () => {
		const res = await callback("code=the-code", null);
		expect(res.status).toBe(400);
	});

	it("500s when state lookup fails for a non-OAuth reason", async () => {
		const { stateToken, consented } = await seedState();
		kv.get.mockRejectedValueOnce(new Error("kv down"));
		const res = await callback(`state=${stateToken}&code=the-code`, consented);
		expect(res.status).toBe(500);
		expect(await res.text()).toBe("Internal server error");
	});

	it("400s when the stored request has no client id", async () => {
		const { stateToken } = await createOAuthState({ ...reqInfo, clientId: undefined } as never, kv as never);
		const { setCookie } = await bindStateToSession(stateToken);
		const consented = setCookie.split(";")[0].split("=").slice(1).join("=");
		const res = await callback(`state=${stateToken}&code=the-code`, consented);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Invalid OAuth request data");
	});

	it("clears the consent cookie on the final redirect", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "gho_token" })));
		octo.getAuthenticated.mockResolvedValue({ data: { login: "alice", name: null, email: null } });
		const { stateToken, consented } = await seedState();
		const res = await callback(`state=${stateToken}&code=the-code`, consented);
		expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
		expect(oauthProvider.completeAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({ props: expect.objectContaining({ name: "alice", email: "" }) }),
		);
		vi.unstubAllGlobals();
	});

	it("propagates unexpected identity lookup failures as a 500", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "gho_token" })));
		octo.getAuthenticated.mockRejectedValue(new Error("github down"));
		const { stateToken, consented } = await seedState();
		const res = await callback(`state=${stateToken}&code=the-code`, consented);
		expect(res.status).toBe(500);
		expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("400s when the authorization code is missing", async () => {
		const { stateToken, consented } = await seedState();
		const res = await callback(`state=${stateToken}`, consented);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Missing authorization code");
	});

	it("500s when the upstream token exchange fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
		const { stateToken, consented } = await seedState();
		const res = await callback(`state=${stateToken}&code=the-code`, consented);
		expect(res.status).toBe(500);
		vi.unstubAllGlobals();
	});
});

describe("GET /callback with the Google provider", () => {
	const GoogleHandler = createAuthHandler(googleProvider);
	const googleEnv = () => ({
		OAUTH_PROVIDER: oauthProvider,
		OAUTH_KV: kv,
		AUTH_PROVIDER: "google",
		GOOGLE_CLIENT_ID: "gcid",
		GOOGLE_CLIENT_SECRET: "gsecret",
		COOKIE_ENCRYPTION_KEY: SECRET,
	});

	const seedState = async () => {
		const { stateToken } = await createOAuthState(reqInfo as never, kv as never);
		const { setCookie } = await bindStateToSession(stateToken);
		return { stateToken, consented: setCookie.split(";")[0].split("=").slice(1).join("=") };
	};

	const callback = async (userinfo: Record<string, unknown>) => {
		const fetchMock = vi.fn(async (url: string | URL | Request) =>
			String(url).includes("userinfo")
				? Response.json(userinfo)
				: Response.json({ access_token: "ya29.token" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { stateToken, consented } = await seedState();
		const res = await GoogleHandler.request(
			`https://mcp.example/callback?state=${stateToken}&code=the-code`,
			{ headers: { Cookie: `__Host-CONSENTED_STATE=${consented}` } },
			googleEnv() as never,
		);
		vi.unstubAllGlobals();
		return { res, fetchMock };
	};

	it("redirects to Google with the openid scope when the client is already approved", async () => {
		const approvedCookie = await addApprovedClient(
			new Request("https://mcp.example/"),
			"c1",
			SECRET,
		);
		const res = await GoogleHandler.request(
			"https://mcp.example/authorize",
			{ headers: { Cookie: approvedCookie.split(";")[0] } },
			googleEnv() as never,
		);
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("Location") ?? "");
		expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(location.searchParams.get("client_id")).toBe("gcid");
		expect(location.searchParams.get("scope")).toBe("openid email profile");
	});

	it("uses the lowercased verified email as the login identity", async () => {
		const { res, fetchMock } = await callback({
			email: "Alice@Example.com",
			email_verified: true,
			name: "Alice",
		});
		expect(res.status).toBe(302);
		expect(fetchMock.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
		expect(oauthProvider.completeAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "alice@example.com",
				props: expect.objectContaining({ login: "alice@example.com", email: "alice@example.com" }),
			}),
		);
	});

	it("403s when the Google email is not verified", async () => {
		const { res } = await callback({ email: "alice@example.com", email_verified: false });
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("not verified");
		expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled();
	});
});

describe("the generic OIDC provider", () => {
	const OidcHandler = createAuthHandler(oidcProvider);
	const ISSUER = "https://idp.example/handler-test";
	const discovery = {
		issuer: ISSUER,
		authorization_endpoint: `${ISSUER}/authorize`,
		token_endpoint: `${ISSUER}/token`,
		userinfo_endpoint: `${ISSUER}/userinfo`,
	};
	const oidcEnv = (issuer = ISSUER) => ({
		OAUTH_PROVIDER: oauthProvider,
		OAUTH_KV: kv,
		AUTH_PROVIDER: "oidc",
		OIDC_ISSUER_URL: issuer,
		OIDC_CLIENT_ID: "ocid",
		OIDC_CLIENT_SECRET: "osecret",
		OIDC_DISPLAY_NAME: "Acme SSO",
		COOKIE_ENCRYPTION_KEY: SECRET,
	});

	const stubIdp = (userinfo: Record<string, unknown>) => {
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes("well-known")) return Response.json(discovery);
			if (href.endsWith("/userinfo")) return Response.json(userinfo);
			return Response.json({ access_token: "oidc.token" });
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	};

	const approvedRequest = async (env: Record<string, unknown>) => {
		const approvedCookie = await addApprovedClient(new Request("https://mcp.example/"), "c1", SECRET);
		return OidcHandler.request(
			"https://mcp.example/authorize",
			{ headers: { Cookie: approvedCookie.split(";")[0] } },
			env as never,
		);
	};

	it("names the configured provider on the approval dialog", async () => {
		const res = await OidcHandler.request("https://mcp.example/authorize", undefined, oidcEnv() as never);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Sign in with Acme SSO");
	});

	it("redirects to the discovered authorization endpoint", async () => {
		stubIdp({});
		const res = await approvedRequest(oidcEnv());
		vi.unstubAllGlobals();
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("Location") ?? "");
		expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
		expect(location.searchParams.get("client_id")).toBe("ocid");
		expect(location.searchParams.get("scope")).toBe("openid email profile");
	});

	const stubIdpDown = () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: "down" }, { status: 503 })),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
	};

	it("502s on the authorize redirect when discovery fails, without creating state", async () => {
		stubIdpDown();
		const res = await approvedRequest(oidcEnv("https://idp.example/handler-down"));
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		expect(res.status).toBe(502);
		expect(kv.put).not.toHaveBeenCalled();
	});

	it("502s on the consent form when discovery fails, before approving the client", async () => {
		stubIdpDown();
		const { token, setCookie } = generateCSRFProtection();
		const body = new FormData();
		body.set("csrf_token", token);
		body.set("state", btoa(JSON.stringify({ oauthReqInfo: reqInfo })));
		const res = await OidcHandler.request(
			"https://mcp.example/authorize",
			{ method: "POST", body, headers: { Cookie: setCookie.split(";")[0] } },
			oidcEnv("https://idp.example/handler-down-post") as never,
		);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		expect(res.status).toBe(502);
		expect(res.headers.getSetCookie()).toEqual([]);
		expect(kv.put).not.toHaveBeenCalled();
	});

	it("502s on the callback when discovery fails, leaving the state unconsumed", async () => {
		stubIdpDown();
		const { stateToken } = await createOAuthState(reqInfo as never, kv as never);
		const { setCookie } = await bindStateToSession(stateToken);
		const consented = setCookie.split(";")[0].split("=").slice(1).join("=");
		const res = await OidcHandler.request(
			`https://mcp.example/callback?state=${stateToken}&code=the-code`,
			{ headers: { Cookie: `__Host-CONSENTED_STATE=${consented}` } },
			oidcEnv("https://idp.example/handler-down-cb") as never,
		);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		expect(res.status).toBe(502);
		expect(kv.delete).not.toHaveBeenCalled();
		expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled();
	});

	it("completes the callback through the discovered token and userinfo endpoints", async () => {
		const fetchMock = stubIdp({ email: "Alice@Example.com", email_verified: true, name: "Alice" });
		const { stateToken } = await createOAuthState(reqInfo as never, kv as never);
		const { setCookie } = await bindStateToSession(stateToken);
		const consented = setCookie.split(";")[0].split("=").slice(1).join("=");
		const res = await OidcHandler.request(
			`https://mcp.example/callback?state=${stateToken}&code=the-code`,
			{ headers: { Cookie: `__Host-CONSENTED_STATE=${consented}` } },
			oidcEnv() as never,
		);
		vi.unstubAllGlobals();
		expect(res.status).toBe(302);
		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls).toContain(`${ISSUER}/token`);
		expect(urls).toContain(`${ISSUER}/userinfo`);
		expect(oauthProvider.completeAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "alice@example.com" }),
		);
	});
});
