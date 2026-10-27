import type { AuthProviderName } from "../../config";

/**
 * An upstream identity provider the login flow delegates to. The flow itself
 * (approval dialog, CSRF, state, token exchange, `completeAuthorization`) is
 * provider-agnostic and lives in `auth/handler.ts`; a provider only supplies
 * its OAuth endpoints, its credentials/allowlist keys, and how to turn an
 * access token into an identity.
 *
 * Endpoints and the display name are functions of the env (rather than
 * constants) because the generic OIDC provider resolves them from the
 * configured issuer at runtime; GitHub and Google simply return constants.
 */

export type UpstreamIdentity = {
	/** The stable id the allowlist is matched against (GitHub login, verified email). */
	login: string;
	name: string;
	email: string;
};

export type OAuthEndpoints = {
	authorizeUrl: string;
	tokenUrl: string;
};

export type UpstreamProvider = {
	readonly name: AuthProviderName;
	/** Shown on the approval dialog ("Sign in with …"). */
	displayName(env: Env): string;
	readonly logo?: string;
	readonly scope: string;
	endpoints(env: Env): Promise<OAuthEndpoints>;
	credentials(env: Env): { clientId: string; clientSecret: string };
	allowedLogins(env: Env): string[];
	/** Throws `UpstreamIdentityError` if the account cannot be trusted (e.g. unverified email). */
	fetchIdentity(accessToken: string, env: Env): Promise<UpstreamIdentity>;
};

export class UpstreamIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UpstreamIdentityError";
	}
}
