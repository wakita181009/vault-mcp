import { z } from "zod";
import { githubStorageSchema } from "./github/schema";
import { r2StorageSchema } from "./r2/schema";
import { s3StorageSchema } from "./s3/schema";

// Storage backends are chosen independently of the login provider, so they form
// their own discriminated union keyed on `VAULT_STORAGE`.
export const storageEnvSchema = z.discriminatedUnion("VAULT_STORAGE", [
	githubStorageSchema,
	r2StorageSchema,
	s3StorageSchema,
]);

export type StorageEnvConfig = z.infer<typeof storageEnvSchema>;
export type StorageBackendName = StorageEnvConfig["VAULT_STORAGE"];
