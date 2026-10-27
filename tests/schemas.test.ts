import { describe, expect, it } from "vitest";
import {
	deleteNoteInput,
	listNotesInput,
	readNoteInput,
	searchNotesInput,
	writeNoteInput,
} from "../src/schemas";

describe("list_notes input", () => {
	it("accepts an empty object and an optional dir", () => {
		expect(listNotesInput.parse({})).toEqual({});
		expect(listNotesInput.parse({ dir: "user_profile" })).toEqual({ dir: "user_profile" });
	});

	it("rejects a non-string dir", () => {
		expect(listNotesInput.safeParse({ dir: 1 }).success).toBe(false);
	});
});

describe("read_note / delete_note input", () => {
	it("requires a string path", () => {
		expect(readNoteInput.parse({ path: "a.md" })).toEqual({ path: "a.md" });
		expect(deleteNoteInput.parse({ path: "a.md" })).toEqual({ path: "a.md" });
		expect(readNoteInput.safeParse({}).success).toBe(false);
		expect(deleteNoteInput.safeParse({ path: null }).success).toBe(false);
	});
});

describe("write_note input", () => {
	it("requires both path and content", () => {
		expect(writeNoteInput.parse({ path: "a.md", content: "# hi" })).toEqual({
			path: "a.md",
			content: "# hi",
		});
		expect(writeNoteInput.safeParse({ path: "a.md" }).success).toBe(false);
		expect(writeNoteInput.safeParse({ content: "x" }).success).toBe(false);
	});
});

describe("search_notes input", () => {
	it("defaults limit to 10", () => {
		expect(searchNotesInput.parse({ query: "todo" })).toEqual({ query: "todo", limit: 10 });
	});

	it("keeps an explicit limit inside 1..30", () => {
		expect(searchNotesInput.parse({ query: "q", limit: 30 }).limit).toBe(30);
		expect(searchNotesInput.parse({ query: "q", limit: 1 }).limit).toBe(1);
	});

	it("rejects out-of-range, fractional, or missing-query input", () => {
		expect(searchNotesInput.safeParse({ query: "q", limit: 0 }).success).toBe(false);
		expect(searchNotesInput.safeParse({ query: "q", limit: 31 }).success).toBe(false);
		expect(searchNotesInput.safeParse({ query: "q", limit: 2.5 }).success).toBe(false);
		expect(searchNotesInput.safeParse({ limit: 5 }).success).toBe(false);
	});
});
