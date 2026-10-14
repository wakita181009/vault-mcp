import { describe, expect, it } from "vitest";
import type { VaultStorage } from "../src/storage/types";
import { VaultClient, VaultError } from "../src/vault";

/** Minimal in-memory backend: proves the policy layer needs nothing GitHub-specific. */
const memoryStorage = (files: Record<string, string>): VaultStorage => ({
	listFiles: async () => ({
		files: Object.entries(files).map(([path, c]) => ({ path, size: c.length })),
		truncated: false,
	}),
	readFile: async (path) => {
		const content = files[path];
		if (content === undefined) throw new VaultError(`Not a file: ${path}`);
		return content;
	},
	writeFile: async (path, content) => {
		const created = !(path in files);
		files[path] = content;
		return { created };
	},
	deleteFile: async (path) => {
		if (!(path in files)) return false;
		delete files[path];
		return true;
	},
	searchContent: async () => [],
});

describe("VaultClient over a non-GitHub backend", () => {
	const client = () =>
		new VaultClient(memoryStorage({ "notes/a.md": "alpha", ".obsidian/x.md": "hidden" }), {
			allowedPrefixes: [],
			deniedPrefixes: [".obsidian/"],
		});

	it("lists, reads, writes, deletes and searches through the backend", async () => {
		const c = client();
		expect((await c.listNotes()).notes.map((n) => n.path)).toEqual(["notes/a.md"]);
		expect((await c.readNote("notes/a.md")).content).toBe("alpha");
		expect(await c.writeNote("notes/b.md", "beta")).toEqual({ path: "notes/b.md", created: true });
		expect((await c.searchNotes("b", 10)).map((h) => h.path)).toEqual(["notes/b.md"]);
		expect(await c.deleteNote("notes/b.md")).toEqual({ path: "notes/b.md" });
		await expect(c.deleteNote("notes/b.md")).rejects.toThrow(/Note not found/);
	});

	it("still enforces policy before the backend is reached", async () => {
		const c = client();
		await expect(c.readNote(".obsidian/x.md")).rejects.toBeInstanceOf(VaultError);
		await expect(c.writeNote("notes/a.txt", "x")).rejects.toThrow(/Not a note/);
		await expect(c.deleteNote("../a.md")).rejects.toThrow(/Invalid path/);
	});
});
