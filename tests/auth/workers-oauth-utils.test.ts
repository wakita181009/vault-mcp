import { describe, expect, it } from "vitest";
import {
	addApprovedClient,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	validateCSRFToken,
} from "../../src/auth/workers-oauth-utils";

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
