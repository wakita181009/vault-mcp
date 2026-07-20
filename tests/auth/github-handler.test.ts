import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as cfEnv } from "../stubs/cloudflare-workers";

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

import { GitHubHandler } from "../../src/auth/github-handler";
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

// The Hono handler reads these two secrets from the `cloudflare:workers` env.
const request = (path: string, init?: RequestInit) =>
	GitHubHandler.request(path, init, appEnv() as never);

beforeEach(() => {
	vi.clearAllMocks();
	kv = makeKV();
	Object.assign(cfEnv, { GITHUB_CLIENT_ID: "cid", COOKIE_ENCRYPTION_KEY: SECRET });
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
				new Response(new URLSearchParams({ access_token: "gho_token" }), {
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
				}),
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
