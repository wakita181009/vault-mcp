import { parseEnv } from "./config";
import { GitHubStorage } from "./storage/github";
import { type ContentMatch, VaultError, type VaultStorage } from "./storage/types";

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

/** Validate the Worker env (fail fast on misconfig) and wire the configured backend. */
export function vaultClientFromEnv(env: Env): VaultClient {
	const config = parseEnv(env);
	const storage = new GitHubStorage({
		owner: config.VAULT_OWNER,
		repo: config.VAULT_REPO,
		branch: config.VAULT_BRANCH,
		token: config.VAULT_GITHUB_TOKEN,
	});
	return new VaultClient(storage, {
		allowedPrefixes: parseList(config.VAULT_ALLOWED_PREFIXES),
		deniedPrefixes: parseList(config.VAULT_DENIED_PREFIXES),
	});
}

export function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Whether a vault path may be exposed given the allow/deny policy. */
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

export class VaultClient {
	constructor(
		private readonly storage: VaultStorage,
		private readonly config: VaultConfig,
	) {}

	/**
	 * List notes (markdown files) under the visible portion of the vault.
	 * `dir`, when provided, further scopes the listing to that subtree.
	 */
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

	/**
	 * Create a new note or overwrite an existing one. Enforces the same path
	 * guards as reads (traversal/absolute rejection, allow/deny policy) and only
	 * accepts markdown paths, so writes can never reach `.git/`, `.obsidian/`, or
	 * any non-note file. Returns whether the note was created (vs. updated).
	 */
	async writeNote(path: string, content: string): Promise<{ path: string; created: boolean }> {
		const normalized = this.guardMutable(path);
		const { created } = await this.storage.writeFile(normalized, content);
		return { path: normalized, created };
	}

	/**
	 * Delete an existing note. Enforces the same path guards as writes
	 * (traversal/absolute rejection, note-extension check, allow/deny policy), so
	 * a delete can never reach `.git/`, `.obsidian/`, agent dirs, or any non-note
	 * file.
	 */
	async deleteNote(path: string): Promise<{ path: string }> {
		const normalized = this.guardMutable(path);
		const found = await this.storage.deleteFile(normalized);
		if (!found) {
			throw new VaultError(`Note not found: ${normalized}`);
		}
		return { path: normalized };
	}

	/**
	 * Search notes. Combines the backend's content search with filename matching
	 * from the listing so results are useful even when the backend's index is
	 * cold, unavailable, or absent.
	 */
	async searchNotes(query: string, limit: number): Promise<SearchHit[]> {
		const hits = new Map<string, SearchHit>();

		const [contentHits, filenameHits] = await Promise.all([
			this.storage.searchContent(query, limit).catch(() => [] as SearchHit[]),
			this.filenameSearch(query),
		]);

		for (const hit of [...contentHits, ...filenameHits]) {
			if (!isNote(hit.path) || !isPathVisible(hit.path, this.config)) continue;
			const existing = hits.get(hit.path);
			hits.set(hit.path, {
				path: hit.path,
				fragments: [...(existing?.fragments ?? []), ...hit.fragments],
			});
			if (hits.size >= limit) break;
		}

		return [...hits.values()];
	}

	private async filenameSearch(query: string): Promise<SearchHit[]> {
		const { files } = await this.storage.listFiles();
		const needle = query.toLowerCase();
		return files
			.map((entry) => entry.path)
			.filter((path) => path.toLowerCase().includes(needle))
			.map((path) => ({ path, fragments: [] }));
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
