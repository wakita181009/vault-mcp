const UPSTREAM_TIMEOUT_MS = 5_000;

/**
 * Shared options for every request an OIDC provider makes to the IdP. A hung
 * IdP would otherwise stall the login until the Workers wall-clock limit, and
 * a redirect could silently hop from the https issuer to another host, so
 * redirects are treated as errors rather than followed.
 */
export const UPSTREAM_FETCH_INIT = {
	redirect: "error",
	get signal() {
		return AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
	},
} as const satisfies RequestInit;
