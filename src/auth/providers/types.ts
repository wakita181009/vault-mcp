import type { AuthProviderName } from "../../config";

/**
 * An upstream identity provider the login flow delegates to. The flow itself
 * (approval dialog, CSRF, state, token exchange, `completeAuthorization`) is
 * provider-agnostic and lives in `auth/handler.ts`; a provider only supplies
 * its OAuth endpoints, its credentials/allowlist keys, and how to turn an
 * access token into an identity.
 */

export type UpstreamIdentity = {
	/** The stable id the allowlist is matched against (GitHub login, Google email). */
	login: string;
	name: string;
	email: string;
};

export type UpstreamProvider = {
	readonly name: AuthProviderName;
	/** Shown on the approval dialog ("Sign in with …"). */
	readonly displayName: string;
	readonly logo: string;
	readonly authorizeUrl: string;
	readonly tokenUrl: string;
	readonly scope: string;
	credentials(env: Env): { clientId: string; clientSecret: string };
	allowedLogins(env: Env): string[];
	/** Throws `UpstreamIdentityError` if the account cannot be trusted (e.g. unverified email). */
	fetchIdentity(accessToken: string): Promise<UpstreamIdentity>;
};

export class UpstreamIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UpstreamIdentityError";
	}
}
