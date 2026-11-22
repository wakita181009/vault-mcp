import { githubStorageFromEnv } from "./github";
import { r2StorageFromEnv } from "./r2";
import type { StorageEnvConfig } from "./schema";
import type { VaultStorage } from "./types";

/** Construct the backend `VAULT_STORAGE` selects from an already-validated config. */
export function storageFromEnv(config: StorageEnvConfig, env: Env): VaultStorage {
	switch (config.VAULT_STORAGE) {
		case "github":
			return githubStorageFromEnv(config);
		case "r2":
			return r2StorageFromEnv(env);
	}
}
