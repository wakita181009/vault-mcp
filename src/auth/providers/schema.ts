import { z } from "zod";
import { githubAuthSchema } from "./github.schema";
import { googleAuthSchema } from "./google.schema";
import { oidcAuthSchema } from "./oidc/schema";

// Each login provider brings its own OAuth app credentials and its own
// allowlist, because the identity it yields differs (GitHub login vs email).
export const authEnvSchema = z.discriminatedUnion("AUTH_PROVIDER", [
	githubAuthSchema,
	googleAuthSchema,
	oidcAuthSchema,
]);

export type AuthEnvConfig = z.infer<typeof authEnvSchema>;
export type AuthProviderName = AuthEnvConfig["AUTH_PROVIDER"];
