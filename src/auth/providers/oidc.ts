import { z } from "zod";
import type { AuthProviderName } from "../../config";
import { parseList } from "../../vault";
import { UPSTREAM_FETCH_INIT } from "./fetch-init";
import { discoverOidcEndpoints, type OidcEndpoints } from "./oidc-discovery";
import { type UpstreamProvider, UpstreamIdentityError } from "./types";

const userinfoSchema = z.object({
	email: z.string().min(1),
	email_verified: z.boolean().optional(),
	name: z.string().optional(),
});

export type OidcPreset = {
	name: AuthProviderName;
	displayName: (env: Env) => string;
	logo?: string;
	endpoints: (env: Env) => Promise<OidcEndpoints>;
	credentials: (env: Env) => { clientId: string; clientSecret: string };
	allowedLogins: (env: Env) => string[];
	/**
	 * Whether a userinfo response that omits `email_verified` may still pass.
	 * An explicit `false` is always rejected; this only covers IdPs that never
	 * send the claim.
	 */
	allowsUnverifiedEmail: (env: Env) => boolean;
};

const isEmailTrusted = (verified: boolean | undefined, allowUnverified: boolean) =>
	verified === true || (verified === undefined && allowUnverified);

/**
 * Builds a provider for any OpenID Connect IdP: the identity is the verified
 * email from the `userinfo` endpoint, lowercased so the allowlist match is
 * case-insensitive. Google is a preset of this with fixed endpoints; the
 * generic `oidc` provider resolves them via discovery.
 */
export function createOidcProvider(preset: OidcPreset): UpstreamProvider {
	return {
		name: preset.name,
		displayName: preset.displayName,
		logo: preset.logo,
		scope: "openid email profile",
		endpoints: async (env) => {
			const { authorizeUrl, tokenUrl } = await preset.endpoints(env);
			return { authorizeUrl, tokenUrl };
		},
		credentials: preset.credentials,
		// Emails are case-insensitive, so both sides are lowercased for the match.
		allowedLogins: (env) => preset.allowedLogins(env).map((email) => email.toLowerCase()),
		fetchIdentity: async (accessToken, env) => {
			const label = preset.displayName(env);
			const { userinfoUrl } = await preset.endpoints(env);
			const res = await fetch(userinfoUrl, {
				...UPSTREAM_FETCH_INIT,
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			if (!res.ok) {
				throw new UpstreamIdentityError(`${label} userinfo request failed (${res.status})`);
			}
			const parsed = userinfoSchema.safeParse(await res.json());
			if (!parsed.success) {
				throw new UpstreamIdentityError(`${label} userinfo response is missing an email`);
			}
			// An unverified email could belong to anyone who typed it into an
			// account, so it must never satisfy the allowlist.
			if (!isEmailTrusted(parsed.data.email_verified, preset.allowsUnverifiedEmail(env))) {
				throw new UpstreamIdentityError(`${label} account email is not verified`);
			}
			const email = parsed.data.email.toLowerCase();
			return { login: email, name: parsed.data.name ?? email, email };
		},
	};
}

const DEFAULT_DISPLAY_NAME = "OpenID";

export const oidcProvider = createOidcProvider({
	name: "oidc",
	displayName: (env) => env.OIDC_DISPLAY_NAME || DEFAULT_DISPLAY_NAME,
	endpoints: (env) => discoverOidcEndpoints(env.OIDC_ISSUER_URL ?? ""),
	credentials: (env) => ({
		clientId: env.OIDC_CLIENT_ID ?? "",
		clientSecret: env.OIDC_CLIENT_SECRET ?? "",
	}),
	allowedLogins: (env) => parseList(env.VAULT_ALLOWED_OIDC_EMAILS),
	allowsUnverifiedEmail: (env) => env.OIDC_ALLOW_UNVERIFIED_EMAIL === "true",
});
