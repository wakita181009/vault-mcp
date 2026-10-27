import { z } from "zod";
import { parseList } from "../../vault";
import { type UpstreamProvider, UpstreamIdentityError } from "./types";

// Endpoints from https://accounts.google.com/.well-known/openid-configuration.
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const userinfoSchema = z.object({
	email: z.string().min(1),
	email_verified: z.boolean().optional(),
	name: z.string().optional(),
});

export const googleProvider: UpstreamProvider = {
	name: "google",
	displayName: "Google",
	logo: "https://www.google.com/favicon.ico",
	authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenUrl: "https://oauth2.googleapis.com/token",
	scope: "openid email profile",
	credentials: (env) => ({
		clientId: env.GOOGLE_CLIENT_ID ?? "",
		clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
	}),
	// Emails are case-insensitive, so both sides are lowercased for the match.
	allowedLogins: (env) =>
		parseList(env.VAULT_ALLOWED_GOOGLE_EMAILS).map((email) => email.toLowerCase()),
	fetchIdentity: async (accessToken) => {
		const res = await fetch(USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!res.ok) {
			throw new UpstreamIdentityError(`Google userinfo request failed (${res.status})`);
		}
		const parsed = userinfoSchema.safeParse(await res.json());
		if (!parsed.success) {
			throw new UpstreamIdentityError("Google userinfo response is missing an email");
		}
		// An unverified email could belong to anyone who typed it into a Google
		// account, so it must never satisfy the allowlist.
		if (parsed.data.email_verified !== true) {
			throw new UpstreamIdentityError("Google account email is not verified");
		}
		const email = parsed.data.email.toLowerCase();
		return { login: email, name: parsed.data.name ?? email, email };
	},
};
