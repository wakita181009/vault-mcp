import { parseEnv } from "./config";
import { parseList } from "./parse-list";
import { storageFromEnv } from "./storage";
import { type ContentMatch, type FileEntry, VaultError, type VaultStorage } from "./storage/types";

export { VaultError } from "./storage/types";

/**
 * Policy layer over a `VaultStorage` backend (see `storage/`).
 *
 * Reads dominate; the only mutations are `writeNote` (create/overwrite a single
 * note) and `deleteNote` (remove one), both gated by the same path-visibility
 * policy as reads. There is deliberately no rename/move — not every backend has
 * an atomic move and it would silently break Obsidian's wikilinks, which are
 * not rewritten here. Every guard lives here, not in the backends, so adding a
 * backend cannot weaken the policy.
 */

export type VaultConfig = {
	/** If non-empty, only paths under one of these prefixes are visible. */
	allowedPrefixes: string[];
	/** Paths under any of these prefixes are always hidden (takes precedence). */
	deniedPrefixes: string[];
};

export type NoteEntry = {
	path: string;
	size: number;
};

export type SearchHit = ContentMatch;

const NOTE_EXTENSIONS = [".md", ".markdown"];

export function vaultClientFromEnv(env: Env): VaultClient {
	const config = parseEnv(env);
	const storage = storageFromEnv(config, env);
	return new VaultClient(storage, {
		allowedPrefixes: parseList(config.VAULT_ALLOWED_PREFIXES),
		deniedPrefixes: parseList(config.VAULT_DENIED_PREFIXES),
	});
}

export function isPathVisible(path: string, config: VaultConfig): boolean {
	const p = normalizePath(path);
	if (p === null) return false;
	if (config.deniedPrefixes.some((prefix) => matchesPrefix(p, prefix))) return false;
	if (config.allowedPrefixes.length === 0) return true;
	return config.allowedPrefixes.some((prefix) => matchesPrefix(p, prefix));
}

/**
 * Validate & normalize an incoming path. Returns null for anything that looks
 * like traversal or an absolute path — those must never reach a backend.
 */
export function normalizePath(path: string): string | null {
	const trimmed = path.trim().replace(/^\/+/, "");
	if (trimmed.length === 0) return null;
	if (trimmed.includes("\\")) return null;
	if (trimmed.includes("\0")) return null;
	// Reject any `..` segment (traversal) — check segment-wise, not substring.
	if (trimmed.split("/").some((seg) => seg === "..")) return null;
	return trimmed;
}

function matchesPrefix(path: string, prefix: string): boolean {
	const clean = prefix.replace(/\/+$/, "");
	return path === clean || path.startsWith(`${clean}/`);
}

function isNote(path: string): boolean {
	const lower = path.toLowerCase();
	return NOTE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function filenameMatches(query: string, files: Promise<FileEntry[]>): Promise<SearchHit[]> {
	const needle = query.toLowerCase();
	return (await files)
		.filter((entry) => entry.path.toLowerCase().includes(needle))
		.map((entry) => ({ path: entry.path, fragments: [] }));
}

export class VaultClient {
	constructor(
		private readonly storage: VaultStorage,
		private readonly config: VaultConfig,
	) {}

	async listNotes(dir?: string): Promise<{ notes: NoteEntry[]; truncated: boolean }> {
		const dirPrefix = dir ? this.guardReadable(dir) : null;
		const { files, truncated } = await this.storage.listFiles();

		const notes = files
			.filter((entry) => isNote(entry.path))
			.filter((entry) => isPathVisible(entry.path, this.config))
			.filter((entry) => (dirPrefix ? matchesPrefix(entry.path, dirPrefix) : true))
			.sort((a, b) => a.path.localeCompare(b.path));

		return { notes, truncated };
	}

	async readNote(path: string): Promise<{ path: string; content: string }> {
		const normalized = this.guardReadable(path);
		const content = await this.storage.readFile(normalized);
		return { path: normalized, content };
	}

	async writeNote(path: string, content: string): Promise<{ path: string; created: boolean }> {
		const normalized = this.guardMutable(path);
		const { created } = await this.storage.writeFile(normalized, content);
		return { path: normalized, created };
	}

	async deleteNote(path: string): Promise<{ path: string }> {
		const normalized = this.guardMutable(path);
		const found = await this.storage.deleteFile(normalized);
		if (!found) {
			throw new VaultError(`Note not found: ${normalized}`);
		}
		return { path: normalized };
	}

	/**
	 * Content search is combined with filename matching from the listing so
	 * results are useful even when the backend's index is cold, unavailable, or
	 * absent.
	 *
	 * The vault is listed at most once per search: filename matching and a
	 * scanning backend share one memoized listing, because on R2 every listed
	 * page is a subrequest against a per-invocation cap.
	 */
	async searchNotes(query: string, limit: number): Promise<SearchHit[]> {
		const hits = new Map<string, SearchHit>();

		let listing: Promise<FileEntry[]> | undefined;
		const visibleNotes = () => {
			listing ??= this.storage
				.listFiles()
				.then(({ files }) => files.filter((entry) => this.isVisibleNote(entry.path)));
			return listing;
		};

		const [contentHits, filenameHits] = await Promise.all([
			this.storage.searchContent(query, limit, visibleNotes).catch((error: unknown) => {
				// Degrade to filename-only results, but leave a trace: a rate limit or a
				// revoked token otherwise looks exactly like "no content matches".
				console.warn("Content search failed; returning filename matches only:", error);
				return [] as SearchHit[];
			}),
			filenameMatches(query, visibleNotes()),
		]);

		for (const hit of [...contentHits, ...filenameHits]) {
			if (!this.isVisibleNote(hit.path)) continue;
			const existing = hits.get(hit.path);
			hits.set(hit.path, {
				path: hit.path,
				fragments: [...(existing?.fragments ?? []), ...hit.fragments],
			});
			if (hits.size >= limit) break;
		}

		return [...hits.values()];
	}

	private isVisibleNote(path: string): boolean {
		return isNote(path) && isPathVisible(path, this.config);
	}

	private guardReadable(path: string): string {
		const normalized = normalizePath(path);
		if (normalized === null) {
			throw new VaultError(`Invalid path: ${path}`);
		}
		if (!isPathVisible(normalized, this.config)) {
			throw new VaultError(`Path is not accessible: ${normalized}`);
		}
		return normalized;
	}

	/** Read guards plus the note-extension check — mutations must never touch non-note files. */
	private guardMutable(path: string): string {
		const normalized = this.guardReadable(path);
		if (!isNote(normalized)) {
			throw new VaultError(`Not a note (.md/.markdown): ${normalized}`);
		}
		return normalized;
	}
}
