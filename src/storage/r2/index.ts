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
// Workers allow six simultaneous open connections per invocation; more just queue.
const SEARCH_CONCURRENCY = 6;
const MAX_FRAGMENTS_PER_FILE = 3;
const FRAGMENT_CONTEXT = 60;

const NOTE_CONTENT_TYPE = "text/markdown; charset=utf-8";

export class R2Storage implements VaultStorage {
	constructor(private readonly bucket: R2Bucket) {}

	async listFiles(): Promise<{ files: FileEntry[]; truncated: boolean }> {
		const { objects, truncated } = await this.listObjects();
		const files = objects.map((obj) => ({ path: obj.key, size: obj.size, modifiedAt: obj.uploaded }));
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

	/**
	 * R2 has no content index, so this scans candidate objects (case-insensitive
	 * substring match), most recently uploaded first, up to `MAX_SEARCH_SCAN`,
	 * and stops once `limit` files hit. Recency order means the notes left
	 * unscanned in a large vault are the stale ones, not an alphabetical tail.
	 */
	async searchContent(
		query: string,
		limit: number,
		listCandidates: () => Promise<FileEntry[]>,
	): Promise<ContentMatch[]> {
		if (query.length === 0) return [];
		const pattern = new RegExp(escapeRegExp(query), "giu");

		const candidates = (await listCandidates())
			.toSorted((a, b) => modifiedTime(b) - modifiedTime(a))
			.slice(0, MAX_SEARCH_SCAN)
			.map((file) => file.path);

		const hits: ContentMatch[] = [];
		for (let i = 0; i < candidates.length && hits.length < limit; i += SEARCH_CONCURRENCY) {
			const batch = candidates.slice(i, i + SEARCH_CONCURRENCY);
			const matches = await Promise.all(batch.map((path) => this.matchFile(path, pattern)));
			for (const match of matches) {
				if (match && hits.length < limit) hits.push(match);
			}
		}
		return hits;
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

	private async matchFile(path: string, pattern: RegExp): Promise<ContentMatch | null> {
		try {
			const obj = await this.bucket.get(path);
			// Deleted between list and get — not a match, not an error.
			if (obj === null) return null;
			const fragments = findFragments(await obj.text(), pattern);
			return fragments.length > 0 ? { path, fragments } : null;
		} catch {
			// One unreadable object must not reject the batch: `VaultClient` turns a
			// rejected content search into zero content hits, discarding the rest.
			return null;
		}
	}
}

/**
 * Up to `MAX_FRAGMENTS_PER_FILE` snippets around non-overlapping matches of a
 * global `pattern`. Matching the original text (not a lowercased copy) keeps
 * indexes valid when case folding changes string length (e.g. "İ").
 */
export function findFragments(text: string, pattern: RegExp): string[] {
	const fragments: string[] = [];
	let from = 0;
	for (const match of text.matchAll(pattern)) {
		if (fragments.length >= MAX_FRAGMENTS_PER_FILE) break;
		if (match.index < from) continue;
		const start = Math.max(0, match.index - FRAGMENT_CONTEXT);
		const end = Math.min(text.length, match.index + match[0].length + FRAGMENT_CONTEXT);
		fragments.push(text.slice(start, end));
		from = end;
	}
	return fragments;
}

const modifiedTime = (file: FileEntry) => file.modifiedAt?.getTime() ?? 0;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function r2StorageFromEnv(env: Pick<Env, "VAULT_BUCKET">): R2Storage {
	// Bindings are not strings, so `parseEnv` cannot see them; check here so a
	// missing `r2_buckets` entry fails as loudly as a missing secret.
	if (!env.VAULT_BUCKET) {
		throw new Error(
			"Invalid Worker environment:\n  - VAULT_BUCKET: R2 binding is required when VAULT_STORAGE=r2",
		);
	}
	return new R2Storage(env.VAULT_BUCKET);
}
