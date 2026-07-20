import { VaultError } from "./vault";
import type { VaultClient } from "./vault";

/** The subset of VaultClient the tool handlers depend on. */
export type VaultReader = Pick<VaultClient, "listNotes" | "readNote" | "searchNotes">;

/** MCP tool result: text content, optionally flagged as an error. */
export type ToolResult = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
};

export function textResult(text: string): ToolResult {
	return { content: [{ type: "text" as const, text }] };
}

export function errorResult(error: unknown): ToolResult {
	const message = error instanceof VaultError ? error.message : `Vault read failed: ${String(error)}`;
	return { content: [{ type: "text" as const, text: message }], isError: true };
}

export async function listNotesHandler(client: VaultReader, dir?: string): Promise<ToolResult> {
	try {
		const { notes, truncated } = await client.listNotes(dir);
		const lines = notes.map((n) => n.path);
		const header = `${notes.length} note(s)${truncated ? " (tree truncated by GitHub)" : ""}:`;
		return textResult([header, ...lines].join("\n"));
	} catch (error) {
		return errorResult(error);
	}
}

export async function readNoteHandler(client: VaultReader, path: string): Promise<ToolResult> {
	try {
		const note = await client.readNote(path);
		return textResult(note.content);
	} catch (error) {
		return errorResult(error);
	}
}

export async function searchNotesHandler(
	client: VaultReader,
	query: string,
	limit: number,
): Promise<ToolResult> {
	try {
		const hits = await client.searchNotes(query, limit);
		if (hits.length === 0) {
			return textResult(`No notes matched: ${query}`);
		}
		const blocks = hits.map((hit) => {
			const snippet = hit.fragments.length > 0 ? `\n${hit.fragments.join("\n---\n")}` : "";
			return `## ${hit.path}${snippet}`;
		});
		return textResult(blocks.join("\n\n"));
	} catch (error) {
		return errorResult(error);
	}
}

/** Whether a GitHub login is present and on the configured allowlist. */
export function isLoginAllowed(login: string | undefined, allowedLogins: string[]): boolean {
	return login !== undefined && allowedLogins.includes(login);
}
