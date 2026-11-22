import type { VaultEnvConfig } from "../config";
import { GitHubStorage } from "./github";
import { R2Storage } from "./r2";
import type { VaultStorage } from "./types";

/** Construct the backend `VAULT_STORAGE` selects from an already-validated config. */
export function storageFromEnv(config: VaultEnvConfig, env: Env): VaultStorage {
	switch (config.VAULT_STORAGE) {
		case "github":
			return new GitHubStorage({
				owner: config.VAULT_OWNER,
				repo: config.VAULT_REPO,
				branch: config.VAULT_BRANCH,
				token: config.VAULT_GITHUB_TOKEN,
			});
		case "r2":
			// Bindings are not strings, so `parseEnv` cannot see them; check here so a
			// missing `r2_buckets` entry fails as loudly as a missing secret.
			if (!env.VAULT_BUCKET) {
				throw new Error(
					"Invalid Worker environment:\n  - VAULT_BUCKET: R2 binding is required when VAULT_STORAGE=r2",
				);
			}
			return new R2Storage(env.VAULT_BUCKET);
	}
}
