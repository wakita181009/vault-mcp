import { z } from "zod";

// R2 needs no secret: the bucket arrives as the `VAULT_BUCKET` binding, which
// zod cannot validate as a string, so its presence is checked where the backend
// is constructed (`r2FromEnv`).
export const r2StorageSchema = z.object({
	VAULT_STORAGE: z.literal("r2"),
});
