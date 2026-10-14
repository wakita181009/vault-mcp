/**
 * Backend contract for where the vault's files actually live. Implementations
 * only move bytes; every access rule (traversal rejection, allow/deny prefixes,
 * note-extension check) is enforced once in `VaultClient` before a path reaches
 * a backend, so a backend never needs to re-check policy.
 */

export type FileEntry = {
	path: string;
	size: number;
};

export type ContentMatch = {
	path: string;
	/** Matched fragments around each hit; may be empty if the backend has none. */
	fragments: string[];
};

export interface VaultStorage {
	/** Every file (not directories) in the vault, with `truncated` when the backend capped the list. */
	listFiles(): Promise<{ files: FileEntry[]; truncated: boolean }>;
	/** Raw UTF-8 content; throws `VaultError` if the path is not a file. */
	readFile(path: string): Promise<string>;
	/** Create or overwrite; `created` is false when the file already existed. */
	writeFile(path: string, content: string): Promise<{ created: boolean }>;
	/** Returns false if there was nothing to delete. */
	deleteFile(path: string): Promise<boolean>;
	/**
	 * Full-text search, if the backend has an index. `VaultClient` always adds
	 * filename matching on top, so a backend without search may return [].
	 */
	searchContent(query: string, limit: number): Promise<ContentMatch[]>;
}

export class VaultError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VaultError";
	}
}
