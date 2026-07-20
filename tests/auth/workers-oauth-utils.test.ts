import { describe, expect, it, vi } from "vitest";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	validateCSRFToken,
	validateOAuthState,
} from "../../src/auth/workers-oauth-utils";

/** In-memory KVNamespace stand-in covering the get/put/delete surface used here. */
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

const reqInfo = { clientId: "c1", scope: ["read"] } as unknown as Parameters<
	typeof createOAuthState
>[0];

const cookieValue = (setCookie: string): string => setCookie.split(";")[0].split("=").slice(1).join("=");

const callbackRequest = (state: string, consentedHash: string | null): Request =>
	new Request(`https://mcp.example/callback?state=${state}`, {
		headers: consentedHash ? { Cookie: `__Host-CONSENTED_STATE=${consentedHash}` } : {},
	});

const SECRET = "test-cookie-signing-secret";

/** Extracts the `name=value` pair (drops attributes) from a Set-Cookie string. */
const cookiePair = (setCookie: string): string => setCookie.split(";")[0];

const requestWithCookie = (cookie: string): Request =>
	new Request("https://mcp.example/", { headers: { Cookie: cookie } });

describe("approved-client cookie roundtrip", () => {
	it("recognizes a client it just signed into the cookie", async () => {
		const setCookie = await addApprovedClient(requestWithCookie(""), "client-1", SECRET);
		const req = requestWithCookie(cookiePair(setCookie));
		expect(await isClientApproved(req, "client-1", SECRET)).toBe(true);
		expect(await isClientApproved(req, "client-2", SECRET)).toBe(false);
	});

	it("accumulates clients across successive approvals", async () => {
		const first = await addApprovedClient(requestWithCookie(""), "client-1", SECRET);
		const second = await addApprovedClient(
			requestWithCookie(cookiePair(first)),
			"client-2",
			SECRET,
		);
		const req = requestWithCookie(cookiePair(second));
		expect(await isClientApproved(req, "client-1", SECRET)).toBe(true);
		expect(await isClientApproved(req, "client-2", SECRET)).toBe(true);
	});

	it("rejects a cookie verified with the wrong secret", async () => {
		const setCookie = await addApprovedClient(requestWithCookie(""), "client-1", SECRET);
		const req = requestWithCookie(cookiePair(setCookie));
		expect(await isClientApproved(req, "client-1", "a-different-secret")).toBe(false);
	});

	it("rejects a tampered signature", async () => {
		const setCookie = await addApprovedClient(requestWithCookie(""), "client-1", SECRET);
		const [name, value] = cookiePair(setCookie).split("=");
		const [sig, payload] = value.split(".");
		const badSig = `${sig[0] === "0" ? "1" : "0"}${sig.slice(1)}`;
		const req = requestWithCookie(`${name}=${badSig}.${payload}`);
		expect(await isClientApproved(req, "client-1", SECRET)).toBe(false);
	});

	it("rejects a payload that was swapped without re-signing", async () => {
		const setCookie = await addApprovedClient(requestWithCookie(""), "client-1", SECRET);
		const [name, value] = cookiePair(setCookie).split("=");
		const [sig] = value.split(".");
		const forgedPayload = btoa(JSON.stringify(["client-evil"]));
		const req = requestWithCookie(`${name}=${sig}.${forgedPayload}`);
		expect(await isClientApproved(req, "client-evil", SECRET)).toBe(false);
	});

	it("returns false when no cookie is present", async () => {
		expect(await isClientApproved(requestWithCookie(""), "client-1", SECRET)).toBe(false);
	});
});

describe("validateCSRFToken", () => {
	const formWith = (token: string | null): FormData => {
		const fd = new FormData();
		if (token !== null) fd.set("csrf_token", token);
		return fd;
	};

	it("passes when the form token matches the cookie token", () => {
		const { token, setCookie } = generateCSRFProtection();
		const req = requestWithCookie(cookiePair(setCookie));
		expect(() => validateCSRFToken(formWith(token), req)).not.toThrow();
	});

	it("throws when the form token is missing", () => {
		const { setCookie } = generateCSRFProtection();
		const req = requestWithCookie(cookiePair(setCookie));
		expect(() => validateCSRFToken(formWith(null), req)).toThrow(OAuthError);
	});

	it("throws when the cookie token is missing", () => {
		const { token } = generateCSRFProtection();
		expect(() => validateCSRFToken(formWith(token), requestWithCookie(""))).toThrow(OAuthError);
	});

	it("throws when the tokens do not match", () => {
		const { setCookie } = generateCSRFProtection();
		const req = requestWithCookie(cookiePair(setCookie));
		expect(() => validateCSRFToken(formWith("not-the-token"), req)).toThrow(/mismatch/);
	});
});

describe("OAuth state lifecycle", () => {
	it("stores the request under a TTL-bounded key and returns a token", async () => {
		const kv = makeKV();
		const { stateToken } = await createOAuthState(reqInfo, kv as unknown as KVNamespace);
		expect(stateToken).toMatch(/[0-9a-f-]{36}/);
		expect(kv.put).toHaveBeenCalledWith(
			`oauth:state:${stateToken}`,
			JSON.stringify(reqInfo),
			expect.objectContaining({ expirationTtl: 600 }),
		);
	});

	it("binds the state to a session via a sha-256 hash cookie", async () => {
		const { setCookie } = await bindStateToSession("tok");
		expect(setCookie).toMatch(/^__Host-CONSENTED_STATE=[0-9a-f]{64};/);
	});

	it("round-trips create → bind → validate and consumes both", async () => {
		const kv = makeKV();
		const { stateToken } = await createOAuthState(reqInfo, kv as unknown as KVNamespace);
		const { setCookie } = await bindStateToSession(stateToken);
		const req = callbackRequest(stateToken, cookieValue(setCookie));

		const result = await validateOAuthState(req, kv as unknown as KVNamespace);
		expect(result.oauthReqInfo).toEqual(reqInfo);
		expect(result.clearCookie).toContain("Max-Age=0");
		expect(await kv.get(`oauth:state:${stateToken}`)).toBeNull();
	});

	it("rejects a missing state parameter", async () => {
		const kv = makeKV();
		const req = new Request("https://mcp.example/callback");
		await expect(validateOAuthState(req, kv as unknown as KVNamespace)).rejects.toThrow(
			/Missing state/,
		);
	});

	it("rejects a state that is not in KV", async () => {
		const kv = makeKV();
		const req = callbackRequest("unknown", "deadbeef");
		await expect(validateOAuthState(req, kv as unknown as KVNamespace)).rejects.toThrow(
			/Invalid or expired/,
		);
	});

	it("rejects when the session binding cookie is absent", async () => {
		const kv = makeKV();
		const { stateToken } = await createOAuthState(reqInfo, kv as unknown as KVNamespace);
		const req = callbackRequest(stateToken, null);
		await expect(validateOAuthState(req, kv as unknown as KVNamespace)).rejects.toThrow(
			/Missing session binding/,
		);
	});

	it("rejects when the cookie hash does not match the state", async () => {
		const kv = makeKV();
		const { stateToken } = await createOAuthState(reqInfo, kv as unknown as KVNamespace);
		const req = callbackRequest(stateToken, "0".repeat(64));
		await expect(validateOAuthState(req, kv as unknown as KVNamespace)).rejects.toThrow(
			/does not match session/,
		);
	});

	it("raises a server error when the stored state is not valid JSON", async () => {
		const kv = makeKV();
		const { setCookie } = await bindStateToSession("corrupt");
		kv.store.set("oauth:state:corrupt", "not-json{");
		const req = callbackRequest("corrupt", cookieValue(setCookie));
		await expect(validateOAuthState(req, kv as unknown as KVNamespace)).rejects.toMatchObject({
			code: "server_error",
		});
	});
});

describe("approved-client cookie edge cases", () => {
	it("ignores a malformed cookie value with no signature separator", async () => {
		const req = requestWithCookie("__Host-APPROVED_CLIENTS=nodothere");
		expect(await isClientApproved(req, "client-1", SECRET)).toBe(false);
	});
});
