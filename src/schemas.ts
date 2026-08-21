import { z } from "zod";

/**
 * MCP tool input schemas, kept in a standalone module with no imports besides
 * zod: the zod-aot vite plugin (autoDiscover) executes this file at build time
 * and compiles every exported schema into an optimized validator.
 */

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 30;

export const listNotesInput = z.object({
	dir: z
		.string()
		.optional()
		.describe("Optional repo-relative directory to scope the listing to, e.g. 'user_profile'."),
});

export const readNoteInput = z.object({
	path: z.string().describe("Repo-relative path to the note, e.g. 'user_profile/identity.md'."),
});

export const writeNoteInput = z.object({
	path: z.string().describe("Repo-relative path to the note, e.g. 'user_profile/identity.md'."),
	content: z
		.string()
		.describe("Full markdown content to write. Overwrites the note if it already exists."),
});

export const deleteNoteInput = z.object({
	path: z
		.string()
		.describe("Repo-relative path to the note to delete, e.g. 'user_profile/identity.md'."),
});

export const searchNotesInput = z.object({
	query: z.string().describe("Text to search for across note contents and filenames."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_SEARCH_LIMIT)
		.default(DEFAULT_SEARCH_LIMIT)
		.describe("Maximum number of notes to return."),
});
