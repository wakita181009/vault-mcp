import { z } from "zod";

export const githubAuthSchema = z.object({
	// Defaults to GitHub so deploys that predate `AUTH_PROVIDER` keep working.
	AUTH_PROVIDER: z.literal("github").default("github"),
	GITHUB_CLIENT_ID: z.string().min(1),
	GITHUB_CLIENT_SECRET: z.string().min(1),
	VAULT_ALLOWED_GITHUB_LOGINS: z.string(),
});
