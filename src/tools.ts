import { VaultError } from "./vault";
import type { VaultClient } from "./vault";

export type VaultReader = Pick<VaultClient, "listNotes" | "readNote" | "searchNotes">;

export type VaultWriter = Pick<VaultClient, "writeNote">;

export type VaultDeleter = Pick<VaultClient, "deleteNote">;

export type ToolResult = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
};

export function textResult(text: string): ToolResult {
	return { content: [{ type: "text" as const, text }] };
}

export function errorResult(error: unknown): ToolResult {
	const message =
		error instanceof VaultError ? error.message : `Vault operation failed: ${String(error)}`;
	return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Runs a tool body, turning any thrown error into an MCP error result instead of a protocol failure. */
async function toToolResult(run: () => Promise<string>): Promise<ToolResult> {
	try {
		return textResult(await run());
	} catch (error) {
		return errorResult(error);
	}
}

export function listNotesHandler(client: VaultReader, dir?: string): Promise<ToolResult> {
	return toToolResult(async () => {
		const { notes, truncated } = await client.listNotes(dir);
		const header = `${notes.length} note(s)${truncated ? " (listing truncated by backend)" : ""}:`;
		return [header, ...notes.map((n) => n.path)].join("\n");
	});
}

export function readNoteHandler(client: VaultReader, path: string): Promise<ToolResult> {
	return toToolResult(async () => (await client.readNote(path)).content);
}

export function writeNoteHandler(
	client: VaultWriter,
	path: string,
	content: string,
): Promise<ToolResult> {
	return toToolResult(async () => {
		const { path: written, created } = await client.writeNote(path, content);
		return `${created ? "Created" : "Updated"} ${written}`;
	});
}

export function deleteNoteHandler(client: VaultDeleter, path: string): Promise<ToolResult> {
	return toToolResult(async () => `Deleted ${(await client.deleteNote(path)).path}`);
}

export function searchNotesHandler(
	client: VaultReader,
	query: string,
	limit: number,
): Promise<ToolResult> {
	return toToolResult(async () => {
		const hits = await client.searchNotes(query, limit);
		if (hits.length === 0) return `No notes matched: ${query}`;
		return hits
			.map((hit) => {
				const snippet = hit.fragments.length > 0 ? `\n${hit.fragments.join("\n---\n")}` : "";
				return `## ${hit.path}${snippet}`;
			})
			.join("\n\n");
	});
}
