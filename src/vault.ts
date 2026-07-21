import { Octokit } from "octokit";
import { parseEnv } from "./config";

/**
 * Access layer over the GitHub-hosted Obsidian vault.
 *
 * The vault is a private GitHub repo; Obsidian Git keeps it up to date, so the
 * GitHub API always sees the latest committed state. Reads dominate; the only
 * mutations are `writeNote` (create/overwrite a single note) and `deleteNote`
 * (remove one), both gated by the same path-visibility policy as reads. There
 * is deliberately no rename/move — the GitHub API has no atomic move and it
 * would silently break Obsidian's wikilinks, which are not rewritten here.
 */

export type VaultConfig = {
	owner: string;
	repo: string;
	branch: string;
	token: string;
	/** If non-empty, only paths under one of these prefixes are visible. */
	allowedPrefixes: string[];
	/** Paths under any of these prefixes are always hidden (takes precedence). */
	deniedPrefixes: string[];
};

export type NoteEntry = {
	path: string;
	size: number;
};

export type SearchHit = {
	path: string;
	/** Matched fragments (content matches). Empty when the hit is filename-only. */
	fragments: string[];
};

const NOTE_EXTENSIONS = [".md", ".markdown"];

/** Validate the Worker env (fail fast on misconfig) and build the vault-read config. */
export function vaultConfigFromEnv(env: Env): VaultConfig {
	const config = parseEnv(env);
	return {
		owner: config.VAULT_OWNER,
		repo: config.VAULT_REPO,
		branch: config.VAULT_BRANCH,
		token: config.VAULT_GITHUB_TOKEN,
		allowedPrefixes: parseList(config.VAULT_ALLOWED_PREFIXES),
		deniedPrefixes: parseList(config.VAULT_DENIED_PREFIXES),
	};
}

export function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Whether a repo path may be exposed given the allow/deny policy. */
export function isPathVisible(path: string, config: VaultConfig): boolean {
	const p = normalizePath(path);
	if (p === null) return false;
	if (config.deniedPrefixes.some((prefix) => matchesPrefix(p, prefix))) return false;
	if (config.allowedPrefixes.length === 0) return true;
	return config.allowedPrefixes.some((prefix) => matchesPrefix(p, prefix));
}

/**
 * Validate & normalize an incoming path. Returns null for anything that looks
 * like traversal or an absolute path — those must never reach the GitHub API.
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

type GitTreeEntry = { path?: string; type?: string; size?: number };

/** Narrows a git tree entry to a blob (file) with a definite string path. */
function isBlobEntry<T extends GitTreeEntry>(entry: T): entry is T & { path: string } {
	return entry.type === "blob" && typeof entry.path === "string";
}

export class VaultClient {
	private readonly octokit: Octokit;

	constructor(private readonly config: VaultConfig) {
		this.octokit = new Octokit({ auth: config.token });
	}

	/**
	 * List notes (markdown files) under the visible portion of the vault.
	 * `dir`, when provided, further scopes the listing to that subtree.
	 */
	async listNotes(dir?: string): Promise<{ notes: NoteEntry[]; truncated: boolean }> {
		const { tree, truncated } = await this.fetchTree();
		const dirPrefix = dir ? normalizePath(dir) : null;

		const notes = tree
			.filter(isBlobEntry)
			.map((entry) => ({ path: entry.path, size: entry.size ?? 0 }))
			.filter((entry) => isNote(entry.path))
			.filter((entry) => isPathVisible(entry.path, this.config))
			.filter((entry) => (dirPrefix ? matchesPrefix(entry.path, dirPrefix) : true))
			.sort((a, b) => a.path.localeCompare(b.path));

		return { notes, truncated };
	}

	async readNote(path: string): Promise<{ path: string; content: string }> {
		const normalized = normalizePath(path);
		if (normalized === null) {
			throw new VaultError(`Invalid path: ${path}`);
		}
		if (!isPathVisible(normalized, this.config)) {
			throw new VaultError(`Path is not accessible: ${normalized}`);
		}

		const res = await this.octokit.rest.repos.getContent({
			owner: this.config.owner,
			repo: this.config.repo,
			path: normalized,
			ref: this.config.branch,
		});

		const data = res.data;
		if (Array.isArray(data) || data.type !== "file") {
			throw new VaultError(`Not a file: ${normalized}`);
		}

		let content: string;
		if (data.encoding === "base64" && data.content) {
			content = decodeBase64Utf8(data.content);
		} else {
			// Files > 1MB come back with empty content; fall back to the blob API.
			const blob = await this.octokit.rest.git.getBlob({
				owner: this.config.owner,
				repo: this.config.repo,
				file_sha: data.sha,
			});
			content = decodeBase64Utf8(blob.data.content);
		}

		return { path: normalized, content };
	}

	/**
	 * Create a new note or overwrite an existing one. Enforces the same path
	 * guards as reads (traversal/absolute rejection, allow/deny policy) and only
	 * accepts markdown paths, so writes can never reach `.git/`, `.obsidian/`, or
	 * any non-note file. Returns whether the note was created (vs. updated).
	 */
	async writeNote(path: string, content: string): Promise<{ path: string; created: boolean }> {
		const normalized = normalizePath(path);
		if (normalized === null) {
			throw new VaultError(`Invalid path: ${path}`);
		}
		if (!isNote(normalized)) {
			throw new VaultError(`Not a note (.md/.markdown): ${normalized}`);
		}
		if (!isPathVisible(normalized, this.config)) {
			throw new VaultError(`Path is not accessible: ${normalized}`);
		}

		// GitHub's contents API needs the current blob sha to overwrite; its
		// absence means the file does not exist yet and this is a create.
		const sha = await this.existingFileSha(normalized);
		await this.octokit.rest.repos.createOrUpdateFileContents({
			owner: this.config.owner,
			repo: this.config.repo,
			path: normalized,
			message: `${sha ? "Update" : "Create"} ${normalized} via vault-mcp`,
			content: encodeBase64Utf8(content),
			branch: this.config.branch,
			...(sha ? { sha } : {}),
		});

		return { path: normalized, created: sha === undefined };
	}

	/**
	 * Delete an existing note. Enforces the same path guards as writes
	 * (traversal/absolute rejection, note-extension check, allow/deny policy), so
	 * a delete can never reach `.git/`, `.obsidian/`, agent dirs, or any non-note
	 * file. The removal is a git commit and stays recoverable via `git revert`.
	 */
	async deleteNote(path: string): Promise<{ path: string }> {
		const normalized = normalizePath(path);
		if (normalized === null) {
			throw new VaultError(`Invalid path: ${path}`);
		}
		if (!isNote(normalized)) {
			throw new VaultError(`Not a note (.md/.markdown): ${normalized}`);
		}
		if (!isPathVisible(normalized, this.config)) {
			throw new VaultError(`Path is not accessible: ${normalized}`);
		}

		// deleteFile needs the current blob sha; its absence means the note does
		// not exist — report that rather than letting a raw 404 surface.
		const sha = await this.existingFileSha(normalized);
		if (sha === undefined) {
			throw new VaultError(`Note not found: ${normalized}`);
		}
		await this.octokit.rest.repos.deleteFile({
			owner: this.config.owner,
			repo: this.config.repo,
			path: normalized,
			message: `Delete ${normalized} via vault-mcp`,
			sha,
			branch: this.config.branch,
		});

		return { path: normalized };
	}

	private async existingFileSha(path: string): Promise<string | undefined> {
		try {
			const res = await this.octokit.rest.repos.getContent({
				owner: this.config.owner,
				repo: this.config.repo,
				path,
				ref: this.config.branch,
			});
			const data = res.data;
			if (Array.isArray(data) || data.type !== "file") {
				throw new VaultError(`Not a file: ${path}`);
			}
			return data.sha;
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
	}

	/**
	 * Search notes. Combines GitHub content search (indexed, default branch) with
	 * filename matching from the tree so results are useful even when the code
	 * search index is cold or unavailable for the query.
	 */
	async searchNotes(query: string, limit: number): Promise<SearchHit[]> {
		const hits = new Map<string, SearchHit>();

		const [contentHits, filenameHits] = await Promise.all([
			this.contentSearch(query, limit).catch(() => [] as SearchHit[]),
			this.filenameSearch(query),
		]);

		for (const hit of [...contentHits, ...filenameHits]) {
			if (!isNote(hit.path) || !isPathVisible(hit.path, this.config)) continue;
			const existing = hits.get(hit.path);
			if (existing) {
				existing.fragments.push(...hit.fragments);
			} else {
				hits.set(hit.path, { path: hit.path, fragments: [...hit.fragments] });
			}
			if (hits.size >= limit) break;
		}

		return [...hits.values()];
	}

	private async contentSearch(query: string, limit: number): Promise<SearchHit[]> {
		const res = await this.octokit.rest.search.code({
			q: `${query} repo:${this.config.owner}/${this.config.repo}`,
			per_page: Math.min(limit, 30),
			mediaType: { format: "text-match" },
		});

		return res.data.items.map((item) => ({
			path: item.path,
			fragments: (item.text_matches ?? [])
				.map((m) => m.fragment)
				.filter((f): f is string => typeof f === "string"),
		}));
	}

	private async filenameSearch(query: string): Promise<SearchHit[]> {
		const { tree } = await this.fetchTree();
		const needle = query.toLowerCase();
		return tree
			.filter(isBlobEntry)
			.map((entry) => entry.path)
			.filter((path) => path.toLowerCase().includes(needle))
			.map((path) => ({ path, fragments: [] }));
	}

	private async fetchTree() {
		const res = await this.octokit.rest.git.getTree({
			owner: this.config.owner,
			repo: this.config.repo,
			tree_sha: this.config.branch,
			recursive: "true",
		});
		return { tree: res.data.tree, truncated: res.data.truncated };
	}
}

export class VaultError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VaultError";
	}
}

function decodeBase64Utf8(b64: string): string {
	const binary = atob(b64.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** Whether an Octokit error is a 404 (file not found) rather than a real failure. */
function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && (error as { status?: number }).status === 404
	);
}
