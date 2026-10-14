import { Octokit } from "octokit";
import { type ContentMatch, type FileEntry, VaultError, type VaultStorage } from "./types";

/**
 * GitHub-repo backend. Obsidian Git keeps the repo up to date, so the GitHub
 * API always sees the latest committed state. Writes and deletes become commits
 * on `branch`, so every mutation stays recoverable via `git revert`.
 */

export type GitHubStorageConfig = {
	owner: string;
	repo: string;
	branch: string;
	token: string;
};

type GitTreeEntry = { path?: string; type?: string; size?: number };

/** Narrows a git tree entry to a blob (file) with a definite string path. */
function isBlobEntry<T extends GitTreeEntry>(entry: T): entry is T & { path: string } {
	return entry.type === "blob" && typeof entry.path === "string";
}

export class GitHubStorage implements VaultStorage {
	private readonly octokit: Octokit;

	constructor(private readonly config: GitHubStorageConfig) {
		this.octokit = new Octokit({ auth: config.token });
	}

	async listFiles(): Promise<{ files: FileEntry[]; truncated: boolean }> {
		const res = await this.octokit.rest.git.getTree({
			owner: this.config.owner,
			repo: this.config.repo,
			tree_sha: this.config.branch,
			recursive: "true",
		});
		const files = res.data.tree
			.filter(isBlobEntry)
			.map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
		return { files, truncated: res.data.truncated };
	}

	async readFile(path: string): Promise<string> {
		const res = await this.octokit.rest.repos
			.getContent({
				owner: this.config.owner,
				repo: this.config.repo,
				path,
				ref: this.config.branch,
			})
			.catch((error: unknown) => {
				if (isNotFound(error)) throw new VaultError(`Note not found: ${path}`);
				throw error;
			});

		const data = res.data;
		if (Array.isArray(data) || data.type !== "file") {
			throw new VaultError(`Not a file: ${path}`);
		}

		if (data.encoding === "base64" && data.content) {
			return decodeBase64Utf8(data.content);
		}
		// Files > 1MB come back with empty content; fall back to the blob API.
		const blob = await this.octokit.rest.git.getBlob({
			owner: this.config.owner,
			repo: this.config.repo,
			file_sha: data.sha,
		});
		return decodeBase64Utf8(blob.data.content);
	}

	async writeFile(path: string, content: string): Promise<{ created: boolean }> {
		// GitHub's contents API needs the current blob sha to overwrite; its
		// absence means the file does not exist yet and this is a create.
		const sha = await this.existingFileSha(path);
		await this.octokit.rest.repos.createOrUpdateFileContents({
			owner: this.config.owner,
			repo: this.config.repo,
			path,
			message: `${sha ? "Update" : "Create"} ${path} via vault-mcp`,
			content: encodeBase64Utf8(content),
			branch: this.config.branch,
			...(sha ? { sha } : {}),
		});
		return { created: sha === undefined };
	}

	async deleteFile(path: string): Promise<boolean> {
		const sha = await this.existingFileSha(path);
		if (sha === undefined) return false;
		await this.octokit.rest.repos.deleteFile({
			owner: this.config.owner,
			repo: this.config.repo,
			path,
			message: `Delete ${path} via vault-mcp`,
			sha,
			branch: this.config.branch,
		});
		return true;
	}

	/** GitHub code search (indexed, default branch only). */
	async searchContent(query: string, limit: number): Promise<ContentMatch[]> {
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
