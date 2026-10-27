import { z } from "zod";
import { UPSTREAM_FETCH_INIT } from "./fetch-init";

export type OidcEndpoints = {
	authorizeUrl: string;
	tokenUrl: string;
	userinfoUrl: string;
};

const httpsUrl = z.string().url().startsWith("https://", "must be an https URL");

const discoverySchema = z.object({
	issuer: z.string().min(1),
	authorization_endpoint: httpsUrl,
	token_endpoint: httpsUrl,
	userinfo_endpoint: httpsUrl,
});

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

// The discovery document rarely changes, and every login would otherwise pay
// for an extra round trip (twice: authorize and callback). Cached per issuer
// for the lifetime of the isolate; a failed lookup is evicted so a transient
// IdP outage does not poison the cache.
const discoveryCache = new Map<string, Promise<OidcEndpoints>>();

async function fetchDiscovery(issuer: string): Promise<OidcEndpoints> {
	const res = await fetch(`${issuer}/.well-known/openid-configuration`, UPSTREAM_FETCH_INIT);
	if (!res.ok) {
		throw new Error(`OIDC discovery request failed (${res.status})`);
	}
	const parsed = discoverySchema.safeParse(await res.json());
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
		throw new Error(`Invalid OIDC discovery document: ${issues.join("; ")}`);
	}
	// OIDC Discovery §4.3: the document's issuer must match the one it was
	// fetched from, otherwise a misconfigured or hostile host could hand us
	// endpoints for a different identity provider.
	if (stripTrailingSlash(parsed.data.issuer) !== issuer) {
		throw new Error("OIDC discovery document issuer does not match OIDC_ISSUER_URL");
	}
	return {
		authorizeUrl: parsed.data.authorization_endpoint,
		tokenUrl: parsed.data.token_endpoint,
		userinfoUrl: parsed.data.userinfo_endpoint,
	};
}

export function discoverOidcEndpoints(issuerUrl: string): Promise<OidcEndpoints> {
	if (!httpsUrl.safeParse(issuerUrl).success) {
		return Promise.reject(new Error("OIDC_ISSUER_URL must be an https URL"));
	}
	const issuer = stripTrailingSlash(issuerUrl);
	const cached = discoveryCache.get(issuer);
	if (cached) return cached;
	const pending = fetchDiscovery(issuer).catch((error: unknown) => {
		discoveryCache.delete(issuer);
		throw error;
	});
	discoveryCache.set(issuer, pending);
	return pending;
}
