// OAuth helpers: CSRF protection, state creation/validation with session binding,
// and the signed approved-clients cookie.

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

const CSRF_TOKEN_COOKIE = "__Host-CSRF_TOKEN";
const CONSENTED_STATE_COOKIE = "__Host-CONSENTED_STATE";
const APPROVED_CLIENTS_COOKIE = "__Host-APPROVED_CLIENTS";

/** OAuth 2.1 error carrying a standard error code and a JSON error response. */
export class OAuthError extends Error {
	constructor(
		public code: string,
		public description: string,
		public statusCode = 400,
	) {
		super(description);
		this.name = "OAuthError";
	}

	toResponse(): Response {
		return new Response(
			JSON.stringify({
				error: this.code,
				error_description: this.description,
			}),
			{
				status: this.statusCode,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export interface OAuthStateResult {
	stateToken: string;
}

export interface ValidateStateResult {
	oauthReqInfo: AuthRequest;
	/** Set-Cookie value that clears the session-binding cookie. */
	clearCookie: string;
}

export interface BindStateResult {
	setCookie: string;
}

export interface CSRFProtectionResult {
	token: string;
	setCookie: string;
}

/** Generates a CSRF token and the matching short-lived cookie for the approval form. */
export function generateCSRFProtection(): CSRFProtectionResult {
	const token = crypto.randomUUID();
	const setCookie = `${CSRF_TOKEN_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
	return { token, setCookie };
}

/**
 * Throws unless the form's CSRF token matches the cookie's. Not cleared here:
 * the cookie is scoped to one OAuth flow (SameSite=Lax, Max-Age=600) and the
 * downstream state is one-time-use in KV.
 */
export function validateCSRFToken(formData: FormData, request: Request): void {
	const tokenFromForm = formData.get("csrf_token");
	if (!tokenFromForm || typeof tokenFromForm !== "string") {
		throw new OAuthError("invalid_request", "Missing CSRF token in form data", 400);
	}

	const tokenFromCookie = getCookie(request, CSRF_TOKEN_COOKIE);
	if (!tokenFromCookie) {
		throw new OAuthError("invalid_request", "Missing CSRF token cookie", 400);
	}

	if (tokenFromForm !== tokenFromCookie) {
		throw new OAuthError("invalid_request", "CSRF token mismatch", 400);
	}
}

/** Stores the OAuth request in KV (one-time use, TTL-bounded) under a fresh state token. */
export async function createOAuthState(
	oauthReqInfo: AuthRequest,
	kv: KVNamespace,
	stateTTL = 600,
): Promise<OAuthStateResult> {
	const stateToken = crypto.randomUUID();

	await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), {
		expirationTtl: stateTTL,
	});

	return { stateToken };
}

/**
 * Binds the OAuth state to the browser via a cookie, proving the browser that
 * completes the callback is the one that consented — this defeats CSRF where an
 * attacker's state token is injected into a victim's flow. The cookie stores a
 * hash, not the token itself, so a leaked state parameter (URL logs, referrer)
 * cannot be used to forge the cookie.
 */
export async function bindStateToSession(stateToken: string): Promise<BindStateResult> {
	const hashHex = await sha256Hex(stateToken);
	const setCookie = `${CONSENTED_STATE_COOKIE}=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;

	return { setCookie };
}

/**
 * Validates the callback's state against both KV (proves our server created it)
 * and the session-binding cookie (proves this browser consented), then consumes
 * both. Throws OAuthError if the state is missing, expired, or unmatched.
 */
export async function validateOAuthState(
	request: Request,
	kv: KVNamespace,
): Promise<ValidateStateResult> {
	const url = new URL(request.url);
	const stateFromQuery = url.searchParams.get("state");

	if (!stateFromQuery) {
		throw new OAuthError("invalid_request", "Missing state parameter", 400);
	}

	const storedDataJson = await kv.get(`oauth:state:${stateFromQuery}`);
	if (!storedDataJson) {
		throw new OAuthError("invalid_request", "Invalid or expired state", 400);
	}

	const consentedStateHash = getCookie(request, CONSENTED_STATE_COOKIE);
	if (!consentedStateHash) {
		throw new OAuthError(
			"invalid_request",
			"Missing session binding cookie - authorization flow must be restarted",
			400,
		);
	}

	const stateHash = await sha256Hex(stateFromQuery);
	if (stateHash !== consentedStateHash) {
		throw new OAuthError(
			"invalid_request",
			"State token does not match session - possible CSRF attack detected",
			400,
		);
	}

	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = JSON.parse(storedDataJson) as AuthRequest;
	} catch (_e) {
		throw new OAuthError("server_error", "Invalid state data", 500);
	}

	// State and its cookie are one-time use — consume both.
	await kv.delete(`oauth:state:${stateFromQuery}`);
	const clearCookie = `${CONSENTED_STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;

	return { oauthReqInfo, clearCookie };
}

/** Whether clientId is in the user's signed approved-clients cookie. */
export async function isClientApproved(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<boolean> {
	const approvedClients = await getApprovedClientsFromCookie(request, cookieSecret);
	return approvedClients?.includes(clientId) ?? false;
}

/** Adds clientId to the approved-clients list and returns the updated signed Set-Cookie. */
export async function addApprovedClient(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<string> {
	const THIRTY_DAYS_IN_SECONDS = 2592000;

	const existingApprovedClients =
		(await getApprovedClientsFromCookie(request, cookieSecret)) || [];
	const updatedApprovedClients = Array.from(new Set([...existingApprovedClients, clientId]));

	const payload = JSON.stringify(updatedApprovedClients);
	const signature = await signData(payload, cookieSecret);
	const cookieValue = `${signature}.${btoa(payload)}`;

	return `${APPROVED_CLIENTS_COOKIE}=${cookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${THIRTY_DAYS_IN_SECONDS}`;
}

function getCookie(request: Request, name: string): string | null {
	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) return null;
	const target = cookieHeader
		.split(";")
		.map((c) => c.trim())
		.find((c) => c.startsWith(`${name}=`));
	return target ? target.substring(name.length + 1) : null;
}

/** Computes the SHA-256 of the input and returns it as a lowercase hex string. */
async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function getApprovedClientsFromCookie(
	request: Request,
	cookieSecret: string,
): Promise<string[] | null> {
	const cookieValue = getCookie(request, APPROVED_CLIENTS_COOKIE);
	if (!cookieValue) return null;

	const parts = cookieValue.split(".");
	if (parts.length !== 2) return null;

	const [signatureHex, base64Payload] = parts;
	const payload = atob(base64Payload);

	const isValid = await verifySignature(signatureHex, payload, cookieSecret);

	if (!isValid) return null;

	try {
		const approvedClients = JSON.parse(payload);
		if (
			!Array.isArray(approvedClients) ||
			!approvedClients.every((item) => typeof item === "string")
		) {
			return null;
		}
		return approvedClients as string[];
	} catch (_e) {
		return null;
	}
}

async function signData(data: string, secret: string): Promise<string> {
	const key = await importKey(secret);
	const enc = new TextEncoder();
	const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(data));
	return Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function verifySignature(
	signatureHex: string,
	data: string,
	secret: string,
): Promise<boolean> {
	const key = await importKey(secret);
	const enc = new TextEncoder();
	try {
		const signatureBytes = new Uint8Array(
			(signatureHex.match(/.{1,2}/g) ?? []).map((byte) => Number.parseInt(byte, 16)),
		);
		return await crypto.subtle.verify("HMAC", key, signatureBytes.buffer, enc.encode(data));
	} catch (_e) {
		return false;
	}
}

async function importKey(secret: string): Promise<CryptoKey> {
	if (!secret) {
		throw new Error("cookieSecret is required for signing cookies");
	}
	const enc = new TextEncoder();
	return crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign", "verify"],
	);
}
