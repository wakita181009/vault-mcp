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

/** Exchanges an authorization code for an access token. Returns `[token, null]` on success, `[null, errorResponse]` on failure. */
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
		body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	if (!resp.ok) {
		console.error("Upstream token exchange failed:", await resp.text());
		return [null, new Response("Failed to fetch access token", { status: 500 })];
	}
	const body = await resp.formData();
	const accessToken = body.get("access_token");
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [accessToken, null];
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
export type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};
