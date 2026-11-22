import { z } from "zod";

// Any OpenID Connect IdP (Entra ID, Okta, Auth0, Keycloak, …), located by its
// issuer URL; the endpoints are resolved via discovery at login time.
export const oidcAuthSchema = z.object({
	AUTH_PROVIDER: z.literal("oidc"),
	// The discovery URL is built by appending `/.well-known/openid-configuration`,
	// which a query string or fragment would silently corrupt.
	OIDC_ISSUER_URL: z
		.string()
		.url()
		.startsWith("https://", "must be an https URL")
		.refine((url) => !/[?#]/.test(url), "must not contain a query string or fragment"),
	OIDC_CLIENT_ID: z.string().min(1),
	OIDC_CLIENT_SECRET: z.string().min(1),
	// Optional knobs; their defaults live next to the provider in `./index.ts`
	// because the provider reads the raw env before `parseEnv` runs.
	OIDC_DISPLAY_NAME: z.string().min(1).optional(),
	OIDC_ALLOW_UNVERIFIED_EMAIL: z.enum(["true", "false"]).optional(),
	VAULT_ALLOWED_OIDC_EMAILS: z.string(),
});
