// workers-oauth-utils.ts
// OAuth utility functions with CSRF and state validation security fixes

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

const CSRF_TOKEN_COOKIE = "__Host-CSRF_TOKEN";
const CONSENTED_STATE_COOKIE = "__Host-CONSENTED_STATE";
const APPROVED_CLIENTS_COOKIE = "__Host-APPROVED_CLIENTS";

/**
 * OAuth 2.1 compliant error class.
 * Represents errors that occur during OAuth operations with standardized error codes and descriptions.
 */
export class OAuthError extends Error {
	/**
	 * Creates a new OAuthError
	 * @param code - The OAuth error code (e.g., "invalid_request", "invalid_grant")
	 * @param description - Human-readable error description
	 * @param statusCode - HTTP status code to return (defaults to 400)
	 */
	constructor(
		public code: string,
		public description: string,
		public statusCode = 400,
	) {
		super(description);
		this.name = "OAuthError";
	}

	/**
	 * Converts the error to a standardized OAuth error response
	 * @returns HTTP Response with JSON error body
	 */
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

/**
 * Result from createOAuthState containing the state token
 */
export interface OAuthStateResult {
	/**
	 * The generated state token to be used in OAuth authorization requests
	 */
	stateToken: string;
}

/**
 * Result from validateOAuthState containing the original OAuth request info and cookie to clear
 */
export interface ValidateStateResult {
	/**
	 * The original OAuth request information that was stored with the state token
	 */
	oauthReqInfo: AuthRequest;

	/**
	 * Set-Cookie header value to clear the state cookie
	 */
	clearCookie: string;
}

/**
 * Result from bindStateToSession containing the cookie to set
 */
export interface BindStateResult {
	/**
	 * Set-Cookie header value to bind the state to the user's session
	 */
	setCookie: string;
}

/**
 * Result from generateCSRFProtection containing the CSRF token and cookie header
 */
export interface CSRFProtectionResult {
	/**
	 * The generated CSRF token to be embedded in forms
	 */
	token: string;

	/**
	 * Set-Cookie header value to send to the client
	 */
	setCookie: string;
}

/**
 * Generates a new CSRF token and corresponding cookie for form protection
 * @returns Object containing the token and Set-Cookie header value
 */
export function generateCSRFProtection(): CSRFProtectionResult {
	const token = crypto.randomUUID();
	const setCookie = `${CSRF_TOKEN_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
	return { token, setCookie };
}

/**
 * Validates that the CSRF token from the form matches the token in the cookie.
 * The cookie is scoped to a single OAuth flow (SameSite=Lax, Max-Age=600) and the
 * downstream state is one-time-use in KV, so the token is not explicitly cleared here.
 *
 * @param formData - The parsed form data containing the CSRF token
 * @param request - The HTTP request containing cookies
 * @throws {OAuthError} If CSRF token is missing or mismatched
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

/**
 * Creates and stores OAuth state information, returning a state token
 * @param oauthReqInfo - OAuth request information to store with the state
 * @param kv - Cloudflare KV namespace for storing OAuth state data
 * @param stateTTL - Time-to-live for OAuth state in seconds (defaults to 600)
 * @returns Object containing the state token (KV-only validation, no cookie needed)
 */
export async function createOAuthState(
	oauthReqInfo: AuthRequest,
	kv: KVNamespace,
	stateTTL = 600,
): Promise<OAuthStateResult> {
	const stateToken = crypto.randomUUID();

	// Store state in KV (secure, one-time use, with TTL)
	await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), {
		expirationTtl: stateTTL,
	});

	return { stateToken };
}

/**
 * Binds an OAuth state token to the user's browser session using a secure cookie.
 * This prevents CSRF attacks where an attacker's state token is used by a victim.
 *
 * SECURITY: This cookie proves that the browser completing the OAuth callback
 * is the same browser that consented to the authorization request.
 *
 * We hash the state token rather than storing it directly for defense-in-depth:
 * - Even if the state parameter leaks (URL logs, referrer headers), the cookie value cannot be derived
 * - The cookie serves as cryptographic proof of consent, not just a copy of the state
 * - Provides an additional layer of security beyond HttpOnly/Secure flags
 *
 * @param stateToken - The state token to bind to the session
 * @returns Object containing the Set-Cookie header to send to the client
 */
export async function bindStateToSession(stateToken: string): Promise<BindStateResult> {
	// Hash the state token to provide defense-in-depth
	const hashHex = await sha256Hex(stateToken);
	const setCookie = `${CONSENTED_STATE_COOKIE}=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;

	return { setCookie };
}

/**
 * Validates OAuth state from the request, ensuring:
 * 1. The state parameter exists in KV (proves it was created by our server)
 * 2. The state hash matches the session cookie (proves this browser consented to it)
 *
 * This prevents attacks where an attacker's valid state token is injected into
 * a victim's OAuth flow.
 *
 * @param request - The HTTP request containing state parameter and cookies
 * @param kv - Cloudflare KV namespace for storing OAuth state data
 * @returns Object containing the original OAuth request info and cookie to clear
 * @throws {OAuthError} If state is missing, mismatched, or expired
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

	// Validate state exists in KV (secure, one-time use, with TTL)
	const storedDataJson = await kv.get(`oauth:state:${stateFromQuery}`);
	if (!storedDataJson) {
		throw new OAuthError("invalid_request", "Invalid or expired state", 400);
	}

	// SECURITY FIX: Validate that this state token belongs to this browser session
	// by checking that the state hash matches the session cookie
	const consentedStateHash = getCookie(request, CONSENTED_STATE_COOKIE);
	if (!consentedStateHash) {
		throw new OAuthError(
			"invalid_request",
			"Missing session binding cookie - authorization flow must be restarted",
			400,
		);
	}

	// Hash the state from query and compare with cookie
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

	// Delete state from KV (one-time use)
	await kv.delete(`oauth:state:${stateFromQuery}`);

	// Clear the session binding cookie (one-time use per OAuth flow)
	const clearCookie = `${CONSENTED_STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;

	return { oauthReqInfo, clearCookie };
}

/**
 * Checks if a client has been previously approved by the user
 * @param request - The HTTP request containing cookies
 * @param clientId - The OAuth client ID to check
 * @param cookieSecret - Secret key used for signing and verifying cookie data
 * @returns True if the client is in the user's approved clients list
 */
export async function isClientApproved(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<boolean> {
	const approvedClients = await getApprovedClientsFromCookie(request, cookieSecret);
	return approvedClients?.includes(clientId) ?? false;
}

/**
 * Adds a client to the user's list of approved clients
 * @param request - The HTTP request containing existing cookies
 * @param clientId - The OAuth client ID to add
 * @param cookieSecret - Secret key used for signing and verifying cookie data
 * @returns Set-Cookie header value with the updated approved clients list
 */
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

// --- Helper Functions ---

/** Reads a single cookie value from the request's Cookie header, or null if absent. */
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
