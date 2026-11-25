import { z } from "zod";

// Tuned for the Workers Free plan's 50 subrequests per invocation: a search
// spends up to `MAX_LIST_PAGES` (see `./index.ts`) on the listing plus one read
// per scanned note. Paid deploys can raise it.
export const DEFAULT_S3_SEARCH_SCAN = 40;
const MAX_S3_SEARCH_SCAN = 1000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const s3StorageSchema = z.object({
	VAULT_STORAGE: z.literal("s3"),
	VAULT_S3_BUCKET: z.string().min(1),
	VAULT_S3_REGION: z.string().min(1),
	// Unset means AWS. Credentials ride on every request, so plain http is only
	// accepted for a local server (e.g. MinIO under `wrangler dev`).
	VAULT_S3_ENDPOINT: z
		.string()
		.url()
		// zod keeps running refinements after `.url()` fails, so guard the parse
		// or a scheme-less value throws instead of being reported as an issue.
		.refine((raw) => {
			const url = URL.parse(raw);
			return (
				url !== null &&
				(url.protocol === "https:" ||
					(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
			);
		}, "must be an https URL (http only for localhost)")
		.refine((raw) => !/[?#]/.test(raw), "must not contain a query string or fragment")
		.optional(),
	VAULT_S3_ACCESS_KEY_ID: z.string().min(1),
	VAULT_S3_SECRET_ACCESS_KEY: z.string().min(1),
	VAULT_S3_SEARCH_SCAN: z
		.string()
		.regex(/^[1-9]\d*$/, "must be a positive integer")
		.transform(Number)
		.pipe(z.number().max(MAX_S3_SEARCH_SCAN))
		.default(DEFAULT_S3_SEARCH_SCAN),
});

export type S3StorageEnvConfig = z.infer<typeof s3StorageSchema>;
