import { z } from "zod";

export const googleAuthSchema = z.object({
	AUTH_PROVIDER: z.literal("google"),
	GOOGLE_CLIENT_ID: z.string().min(1),
	GOOGLE_CLIENT_SECRET: z.string().min(1),
	VAULT_ALLOWED_GOOGLE_EMAILS: z.string(),
});
