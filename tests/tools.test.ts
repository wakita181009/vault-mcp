import { describe, expect, it } from "vitest";
import {
	errorResult,
	isLoginAllowed,
	listNotesHandler,
	readNoteHandler,
	searchNotesHandler,
	textResult,
	type VaultReader,
	type VaultWriter,
	writeNoteHandler,
} from "../src/tools";
import { VaultError } from "../src/vault";

const okClient: VaultReader = {
	listNotes: async (dir?: string) => ({
		notes: dir === "sub" ? [{ path: "sub/a.md", size: 1 }] : [{ path: "a.md", size: 1 }],
		truncated: false,
	}),
	readNote: async (path: string) => ({ path, content: "hello world" }),
	searchNotes: async () => [{ path: "a.md", fragments: ["frag one", "frag two"] }],
};

describe("textResult / errorResult", () => {
	it("wraps text in the MCP content shape", () => {
		expect(textResult("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
	});

	it("surfaces a VaultError message verbatim and flags isError", () => {
		const result = errorResult(new VaultError("nope"));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("nope");
	});

	it("wraps a non-VaultError with a generic prefix", () => {
		const result = errorResult(new Error("boom"));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Vault operation failed:");
	});
});

describe("isLoginAllowed", () => {
	it("is false for an undefined login", () => {
		expect(isLoginAllowed(undefined, ["alice"])).toBe(false);
	});

	it("is false for a login absent from the allowlist", () => {
		expect(isLoginAllowed("carol", ["alice", "bob"])).toBe(false);
	});

	it("is true for an allowed login", () => {
		expect(isLoginAllowed("alice", ["alice", "bob"])).toBe(true);
	});
});

describe("listNotesHandler", () => {
	it("renders a header and one line per note", async () => {
		const result = await listNotesHandler(okClient);
		expect(result.content[0].text).toBe("1 note(s):\na.md");
	});

	it("passes the dir through to the client", async () => {
		const result = await listNotesHandler(okClient, "sub");
		expect(result.content[0].text).toContain("sub/a.md");
	});

	it("notes when the tree was truncated", async () => {
		const client: VaultReader = {
			...okClient,
			listNotes: async () => ({ notes: [], truncated: true }),
		};
		const result = await listNotesHandler(client);
		expect(result.content[0].text).toContain("tree truncated by GitHub");
	});

	it("returns an error result when the client throws", async () => {
		const client: VaultReader = {
			...okClient,
			listNotes: async () => {
				throw new VaultError("list failed");
			},
		};
		const result = await listNotesHandler(client);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("list failed");
	});
});

describe("readNoteHandler", () => {
	it("returns the raw note content", async () => {
		const result = await readNoteHandler(okClient, "a.md");
		expect(result.content[0].text).toBe("hello world");
	});

	it("returns an error result when the client throws", async () => {
		const client: VaultReader = {
			...okClient,
			readNote: async () => {
				throw new VaultError("not accessible");
			},
		};
		const result = await readNoteHandler(client, "secret.md");
		expect(result.isError).toBe(true);
	});
});

describe("writeNoteHandler", () => {
	const okWriter: VaultWriter = {
		writeNote: async (path: string) => ({ path, created: true }),
	};

	it("reports a create", async () => {
		const result = await writeNoteHandler(okWriter, "a.md", "body");
		expect(result.content[0].text).toBe("Created a.md");
		expect(result.isError).toBeUndefined();
	});

	it("reports an update", async () => {
		const client: VaultWriter = {
			writeNote: async (path: string) => ({ path, created: false }),
		};
		const result = await writeNoteHandler(client, "a.md", "body");
		expect(result.content[0].text).toBe("Updated a.md");
	});

	it("returns an error result when the client throws", async () => {
		const client: VaultWriter = {
			writeNote: async () => {
				throw new VaultError("not accessible");
			},
		};
		const result = await writeNoteHandler(client, ".obsidian/x.md", "body");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("not accessible");
	});
});

describe("searchNotesHandler", () => {
	it("renders a block per hit with joined fragments", async () => {
		const result = await searchNotesHandler(okClient, "query", 10);
		expect(result.content[0].text).toBe("## a.md\nfrag one\n---\nfrag two");
	});

	it("renders a heading-only block when a hit has no fragments", async () => {
		const client: VaultReader = {
			...okClient,
			searchNotes: async () => [{ path: "a.md", fragments: [] }],
		};
		const result = await searchNotesHandler(client, "query", 10);
		expect(result.content[0].text).toBe("## a.md");
	});

	it("reports when nothing matched", async () => {
		const client: VaultReader = {
			...okClient,
			searchNotes: async () => [],
		};
		const result = await searchNotesHandler(client, "ghost", 10);
		expect(result.content[0].text).toBe("No notes matched: ghost");
	});

	it("returns an error result when the client throws", async () => {
		const client: VaultReader = {
			...okClient,
			searchNotes: async () => {
				throw new Error("search failed");
			},
		};
		const result = await searchNotesHandler(client, "query", 10);
		expect(result.isError).toBe(true);
	});
});
