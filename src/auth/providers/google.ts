import { parseList } from "../../vault";
import { createOidcProvider } from "./oidc";

// Endpoints from https://accounts.google.com/.well-known/openid-configuration,
// pinned here so a Google login never depends on a live discovery fetch.
const GOOGLE_ENDPOINTS = {
	authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenUrl: "https://oauth2.googleapis.com/token",
	userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
};

export const googleProvider = createOidcProvider({
	name: "google",
	displayName: () => "Google",
	logo: "https://www.google.com/favicon.ico",
	endpoints: async () => GOOGLE_ENDPOINTS,
	credentials: (env) => ({
		clientId: env.GOOGLE_CLIENT_ID ?? "",
		clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
	}),
	allowedLogins: (env) => parseList(env.VAULT_ALLOWED_GOOGLE_EMAILS),
	// Google always sends `email_verified`, so there is nothing to opt into.
	allowsUnverifiedEmail: () => false,
});
