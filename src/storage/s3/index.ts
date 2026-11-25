import { AwsClient } from "aws4fetch";
import { scanSearch } from "../scan-search";
import { type ContentMatch, type FileEntry, VaultError, type VaultStorage } from "../types";
import type { S3StorageEnvConfig } from "./schema";
import { parseErrorCode, parseListPage } from "./xml";

/**
 * S3-compatible backend (AWS S3, Backblaze B2, MinIO, Wasabi, …). Object keys
 * are vault-relative paths at the bucket root, the same layout as R2. Requests
 * are SigV4-signed with keys that must be IAM-scoped to the one vault bucket.
 *
 * Like R2 there is no history: an overwrite or delete is not recoverable from
 * here (unless the bucket has versioning on).
 */

// Every S3 call is an external subrequest, and the Workers Free plan allows 50
// per invocation. Five 1000-key pages plus the default search scan stay under it.
const MAX_LIST_PAGES = 5;

const NOTE_CONTENT_TYPE = "text/markdown; charset=utf-8";
const USER_METADATA_PREFIX = "x-amz-meta-";

export type S3StorageConfig = {
	bucket: string;
	region: string;
	/** Unset means AWS (virtual-hosted URLs); set means path-style against this host. */
	endpoint?: string;
	accessKeyId: string;
	secretAccessKey: string;
	maxSearchScan: number;
};

export class S3Storage implements VaultStorage {
	private readonly client: AwsClient;
	private readonly listUrl: string;
	private readonly objectBase: string;

	constructor(private readonly config: S3StorageConfig) {
		this.client = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			service: "s3",
			region: config.region,
			// aws4fetch retries 5xx/429 ten times by default, and every retry is one
			// more subrequest against the per-invocation cap.
			retries: 0,
		});
		if (config.endpoint) {
			const bucketPath = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;
			this.listUrl = bucketPath;
			this.objectBase = `${bucketPath}/`;
		} else {
			this.listUrl = `https://${config.bucket}.s3.${config.region}.amazonaws.com/`;
			this.objectBase = this.listUrl;
		}
	}

	async listFiles(): Promise<{ files: FileEntry[]; truncated: boolean }> {
		const files: FileEntry[] = [];
		let token: string | undefined;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const params = new URLSearchParams({ "list-type": "2", "encoding-type": "url" });
			if (token) params.set("continuation-token", token);
			const res = await this.send("ListObjectsV2", `${this.listUrl}?${params}`);
			const { objects, truncated, nextToken } = parseListPage(await res.text());
			for (const obj of objects) {
				// Some S3 clients create zero-byte "folder" markers ending in `/`.
				if (obj.key.endsWith("/")) continue;
				files.push({
					path: obj.key,
					size: obj.size,
					...(obj.lastModified ? { modifiedAt: obj.lastModified } : {}),
				});
			}
			if (!truncated || !nextToken) return { files, truncated: false };
			token = nextToken;
		}
		return { files, truncated: true };
	}

	async readFile(path: string): Promise<string> {
		const text = await this.getText(path);
		if (text === null) throw new VaultError(`Note not found: ${path}`);
		return text;
	}

	async writeFile(path: string, content: string): Promise<{ created: boolean }> {
		const existing = await this.head(path);
		// PUT replaces user metadata wholesale; carry over whatever a sync plugin
		// stored on the object so an overwrite does not erase it.
		const headers = new Headers({ "content-type": NOTE_CONTENT_TYPE });
		for (const [name, value] of existing ?? []) {
			if (name.startsWith(USER_METADATA_PREFIX)) headers.set(name, value);
		}
		await this.send("PutObject", this.objectUrl(path), { method: "PUT", headers, body: content });
		return { created: existing === null };
	}

	async deleteFile(path: string): Promise<boolean> {
		// S3 answers 204 whether or not the key existed, so existence needs its own check.
		if ((await this.head(path)) === null) return false;
		await this.send("DeleteObject", this.objectUrl(path), { method: "DELETE" });
		return true;
	}

	/** S3 has no content index; see `scanSearch`. */
	async searchContent(
		query: string,
		limit: number,
		listCandidates: () => Promise<FileEntry[]>,
	): Promise<ContentMatch[]> {
		return scanSearch(query, limit, listCandidates, {
			maxScan: this.config.maxSearchScan,
			read: (path) => this.getText(path),
		});
	}

	private async getText(path: string): Promise<string | null> {
		const res = await this.send("GetObject", this.objectUrl(path), {}, { allowNotFound: true });
		if (res.status !== 404) return res.text();
		// A mistyped bucket is also a 404 (`NoSuchBucket`); only a missing key is a
		// missing note. HEAD has no body to tell them apart, so this is GET-only.
		const code = parseErrorCode(await res.text());
		if (code !== undefined && code !== "NoSuchKey") {
			throw new Error(`S3 GetObject failed: 404 ${code}`);
		}
		return null;
	}

	private async head(path: string): Promise<Headers | null> {
		const res = await this.send(
			"HeadObject",
			this.objectUrl(path),
			{ method: "HEAD" },
			{ allowNotFound: true },
		);
		return res.status === 404 ? null : res.headers;
	}

	private objectUrl(path: string): string {
		return this.objectBase + path.split("/").map(encodeURIComponent).join("/");
	}

	private async send(
		operation: string,
		url: string,
		init: RequestInit = {},
		{ allowNotFound = false } = {},
	): Promise<Response> {
		const res = await this.client.fetch(url, init);
		if (res.ok || (allowNotFound && res.status === 404)) return res;
		// HEAD carries no body, so the status alone has to do there.
		const code = init.method === "HEAD" ? undefined : parseErrorCode(await res.text());
		throw new Error(`S3 ${operation} failed: ${res.status}${code ? ` ${code}` : ""}`);
	}
}

export function s3StorageFromEnv(config: S3StorageEnvConfig): S3Storage {
	return new S3Storage({
		bucket: config.VAULT_S3_BUCKET,
		region: config.VAULT_S3_REGION,
		endpoint: config.VAULT_S3_ENDPOINT,
		accessKeyId: config.VAULT_S3_ACCESS_KEY_ID,
		secretAccessKey: config.VAULT_S3_SECRET_ACCESS_KEY,
		maxSearchScan: config.VAULT_S3_SEARCH_SCAN,
	});
}
