import type { ContentMatch, FileEntry } from "./types";

/**
 * Content search for backends without an index (R2, S3): read candidate notes
 * and substring-match them (case-insensitive), most recently modified first, up
 * to `maxScan`, stopping once `limit` files hit. Recency order means the notes
 * left unscanned in a large vault are the stale ones, not an alphabetical tail.
 */

// Workers allow six simultaneous open connections per invocation; more just queue.
const SEARCH_CONCURRENCY = 6;
const MAX_FRAGMENTS_PER_FILE = 3;
const FRAGMENT_CONTEXT = 60;

export type ScanOptions = {
	/** Every object read is a subrequest, so the scan is capped per backend. */
	maxScan: number;
	/** The file's text, or `null` if it vanished between list and read. */
	read: (path: string) => Promise<string | null>;
};

export async function scanSearch(
	query: string,
	limit: number,
	listCandidates: () => Promise<FileEntry[]>,
	{ maxScan, read }: ScanOptions,
): Promise<ContentMatch[]> {
	if (query.length === 0) return [];
	const pattern = new RegExp(escapeRegExp(query), "giu");

	const paths = (await listCandidates())
		.toSorted((a, b) => modifiedTime(b) - modifiedTime(a))
		.slice(0, maxScan)
		.map((file) => file.path);

	const hits: ContentMatch[] = [];
	for (
		let i = 0;
		i < paths.length && hits.length < limit;
		i += SEARCH_CONCURRENCY
	) {
		const batch = paths.slice(i, i + SEARCH_CONCURRENCY);
		const matches = await Promise.all(
			batch.map((path) => matchFile(path, pattern, read)),
		);
		for (const match of matches) {
			if (match && hits.length < limit) hits.push(match);
		}
	}
	return hits;
}

async function matchFile(
	path: string,
	pattern: RegExp,
	read: ScanOptions["read"],
): Promise<ContentMatch | null> {
	try {
		const text = await read(path);
		if (text === null) return null;
		const fragments = findFragments(text, pattern);
		return fragments.length > 0 ? { path, fragments } : null;
	} catch {
		// One unreadable object must not reject the batch: `VaultClient` turns a
		// rejected content search into zero content hits, discarding the rest.
		return null;
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
		const end = Math.min(
			text.length,
			match.index + match[0].length + FRAGMENT_CONTEXT,
		);
		fragments.push(text.slice(start, end));
		from = end;
	}
	return fragments;
}

const modifiedTime = (file: FileEntry) => file.modifiedAt?.getTime() ?? 0;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
