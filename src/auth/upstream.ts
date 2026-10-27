import { z } from "zod";

export function getUpstreamAuthorizeUrl({
	upstream_url,
	client_id,
	scope,
	redirect_uri,
	state,
}: {
	upstream_url: string;
	client_id: string;
	scope: string;
	redirect_uri: string;
	state: string;
}) {
	const upstream = new URL(upstream_url);
	upstream.search = new URLSearchParams({
		client_id,
		redirect_uri,
		scope,
		state,
		response_type: "code",
	}).toString();
	return upstream.href;
}

/** Builds a redirect response without collapsing repeated headers such as Set-Cookie. */
export function redirectResponse(location: string, headers: HeadersInit = {}): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("Location", location);

	return new Response(null, {
		headers: responseHeaders,
		status: 302,
	});
}

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });

/**
 * Exchanges an authorization code for an access token. Returns `[token, null]`
 * on success, `[null, errorResponse]` on failure.
 *
 * The request is the standard OAuth 2.0 code grant; the `Accept` header makes
 * GitHub answer in JSON like every other provider (its default is
 * form-encoded), so one parser covers them all.
 */
export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: {
	code: string;
	upstream_url: string;
	client_secret: string;
	redirect_uri: string;
	client_id: string;
}): Promise<[string, null] | [null, Response]> {
	const resp = await fetch(upstream_url, {
		body: new URLSearchParams({
			client_id,
			client_secret,
			code,
			redirect_uri,
			grant_type: "authorization_code",
		}).toString(),
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	if (!resp.ok) {
		console.error("Upstream token exchange failed:", await resp.text());
		return [null, new Response("Failed to fetch access token", { status: 500 })];
	}
	const body = tokenResponseSchema.safeParse(await resp.json().catch(() => null));
	if (!body.success) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [body.data.access_token, null];
}
