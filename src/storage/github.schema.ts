import { z } from "zod";

// Kept free of the backend's runtime imports so `config.ts` can compose it
// without pulling Octokit (or an import cycle) into env validation.
export const githubStorageSchema = z.object({
	// Defaults to GitHub so deploys that predate `VAULT_STORAGE` keep working.
	VAULT_STORAGE: z.literal("github").default("github"),
	// Fine-grained PATs start with `github_pat_`; reject a classic `ghp_` token or
	// placeholder early rather than on the first GitHub API 401.
	VAULT_GITHUB_TOKEN: z
		.string()
		.startsWith("github_pat_", "must be a fine-grained PAT (starts with `github_pat_`)"),
	// Vault target. Also secrets, not committed vars: this is a public template,
	// so committing them would leak the private vault.
	VAULT_OWNER: z.string().min(1),
	VAULT_REPO: z.string().min(1),
	VAULT_BRANCH: z.string().min(1).default("main"),
});

export type GitHubStorageEnvConfig = z.infer<typeof githubStorageSchema>;
