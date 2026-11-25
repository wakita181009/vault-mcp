import { invalidEnvError } from "../../env-error";
import { scanSearch } from "../scan-search";
import { type ContentMatch, type FileEntry, VaultError, type VaultStorage } from "../types";

/**
 * Cloudflare R2 backend. Object keys are vault-relative paths at the bucket
 * root (what an S3-compatible sync plugin such as Remotely Save produces with
 * no remote prefix and encryption off). The bucket arrives as a binding, so no
 * credential is stored and the backend can reach only that one bucket.
 *
 * Unlike the GitHub backend there is no history: an overwrite or delete is
 * not recoverable from here.
 */

// R2 returns at most 1000 keys per list call. Each page and each object read
// is a subrequest, and the Workers Free plan allows 1000 subrequests to
// Cloudflare services per invocation, so listing and search are both capped.
const MAX_LIST_PAGES = 20;
const MAX_SEARCH_SCAN = 500;

const NOTE_CONTENT_TYPE = "text/markdown; charset=utf-8";

export class R2Storage implements VaultStorage {
	constructor(private readonly bucket: R2Bucket) {}

	async listFiles(): Promise<{ files: FileEntry[]; truncated: boolean }> {
		const { objects, truncated } = await this.listObjects();
		const files = objects.map((obj) => ({
			path: obj.key,
			size: obj.size,
			modifiedAt: obj.uploaded,
		}));
		return { files, truncated };
	}

	async readFile(path: string): Promise<string> {
		const obj = await this.bucket.get(path);
		if (obj === null) throw new VaultError(`Note not found: ${path}`);
		return obj.text();
	}

	async writeFile(path: string, content: string): Promise<{ created: boolean }> {
		const existing = await this.bucket.head(path);
		// `put` replaces custom metadata wholesale; carry over whatever a sync
		// plugin stored on the object so an overwrite does not erase it.
		await this.bucket.put(path, content, {
			httpMetadata: { contentType: NOTE_CONTENT_TYPE },
			...(existing?.customMetadata ? { customMetadata: existing.customMetadata } : {}),
		});
		return { created: existing === null };
	}

	async deleteFile(path: string): Promise<boolean> {
		const existing = await this.bucket.head(path);
		if (existing === null) return false;
		await this.bucket.delete(path);
		return true;
	}

	/** R2 has no content index; see `scanSearch`. */
	async searchContent(
		query: string,
		limit: number,
		listCandidates: () => Promise<FileEntry[]>,
	): Promise<ContentMatch[]> {
		return scanSearch(query, limit, listCandidates, {
			maxScan: MAX_SEARCH_SCAN,
			read: async (path) => (await this.bucket.get(path))?.text() ?? null,
		});
	}

	private async listObjects(): Promise<{ objects: R2Object[]; truncated: boolean }> {
		const objects: R2Object[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const res = await this.bucket.list(cursor ? { cursor } : {});
			// Some S3 clients create zero-byte "folder" markers ending in `/`.
			objects.push(...res.objects.filter((obj) => !obj.key.endsWith("/")));
			if (!res.truncated) return { objects, truncated: false };
			cursor = res.cursor;
		}
		return { objects, truncated: true };
	}
}

export function r2StorageFromEnv(env: Pick<Env, "VAULT_BUCKET">): R2Storage {
	// Bindings are not strings, so `parseEnv` cannot see them; check here so a
	// missing `r2_buckets` entry fails as loudly as a missing secret.
	if (!env.VAULT_BUCKET) {
		throw invalidEnvError([
			{ key: "VAULT_BUCKET", message: "R2 binding is required when VAULT_STORAGE=r2" },
		]);
	}
	return new R2Storage(env.VAULT_BUCKET);
}
