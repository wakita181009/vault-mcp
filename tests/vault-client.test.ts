import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultClient, VaultError, type VaultConfig } from "../src/vault";

const gh = vi.hoisted(() => {
	const getContent = vi.fn();
	const getBlob = vi.fn();
	const getTree = vi.fn();
	const code = vi.fn();
	const createOrUpdateFileContents = vi.fn();
	const deleteFile = vi.fn();
	const rest = {
		repos: { getContent, createOrUpdateFileContents, deleteFile },
		git: { getBlob, getTree },
		search: { code },
	};
	return {
		getContent,
		getBlob,
		getTree,
		code,
		createOrUpdateFileContents,
		deleteFile,
		Octokit: vi.fn(function Octokit() {
			return { rest };
		}),
	};
});

vi.mock("octokit", () => ({ Octokit: gh.Octokit }));

/** Base64-encodes a UTF-8 string the way the GitHub API returns file content. */
const b64 = (s: string): string =>
	btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const config: VaultConfig = {
	owner: "o",
	repo: "r",
	branch: "main",
	token: "github_pat_x",
	allowedPrefixes: [],
	deniedPrefixes: [".obsidian"],
};

const treeResult = (
	entries: { path?: string; type?: string; size?: number }[],
	truncated = false,
) => ({ data: { tree: entries, truncated } });

let client: VaultClient;

beforeEach(() => {
	vi.clearAllMocks();
	client = new VaultClient(config);
});

describe("listNotes", () => {
	it("returns visible markdown blobs, sorted, ignoring non-notes and trees", async () => {
		gh.getTree.mockResolvedValue(
			treeResult([
				{ path: "b.md", type: "blob", size: 2 },
				{ path: "a.markdown", type: "blob", size: 1 },
				{ path: "img.png", type: "blob", size: 9 },
				{ path: "dir", type: "tree" },
				{ path: ".obsidian/workspace.md", type: "blob", size: 3 },
				{ type: "blob", size: 0 }, // blob with no path — dropped
			]),
		);
		const { notes, truncated } = await client.listNotes();
		expect(notes.map((n) => n.path)).toEqual(["a.markdown", "b.md"]);
		expect(truncated).toBe(false);
	});

	it("scopes to a subdirectory and reports truncation", async () => {
		gh.getTree.mockResolvedValue(
			treeResult(
				[
					{ path: "notes/a.md", type: "blob", size: 1 },
					{ path: "other/b.md", type: "blob", size: 1 },
				],
				true,
			),
		);
		const { notes, truncated } = await client.listNotes("notes");
		expect(notes.map((n) => n.path)).toEqual(["notes/a.md"]);
		expect(truncated).toBe(true);
	});
});

describe("readNote", () => {
	it("decodes inline base64 UTF-8 content", async () => {
		gh.getContent.mockResolvedValue({
			data: { type: "file", encoding: "base64", content: b64("café ☕"), sha: "sha1" },
		});
		const note = await client.readNote("notes/a.md");
		expect(note.content).toBe("café ☕");
		expect(note.path).toBe("notes/a.md");
	});

	it("falls back to the blob API when inline content is empty (large files)", async () => {
		gh.getContent.mockResolvedValue({
			data: { type: "file", encoding: "none", content: "", sha: "big-sha" },
		});
		gh.getBlob.mockResolvedValue({ data: { content: b64("large body") } });
		const note = await client.readNote("big.md");
		expect(note.content).toBe("large body");
		expect(gh.getBlob).toHaveBeenCalledWith(
			expect.objectContaining({ file_sha: "big-sha" }),
		);
	});

	it("rejects an invalid path before hitting the API", async () => {
		await expect(client.readNote("../escape.md")).rejects.toBeInstanceOf(VaultError);
		expect(gh.getContent).not.toHaveBeenCalled();
	});

	it("rejects a path hidden by policy", async () => {
		await expect(client.readNote(".obsidian/secret.md")).rejects.toBeInstanceOf(VaultError);
		expect(gh.getContent).not.toHaveBeenCalled();
	});

	it("throws when the path resolves to a directory listing", async () => {
		gh.getContent.mockResolvedValue({ data: [{ type: "file", name: "x" }] });
		await expect(client.readNote("adir")).rejects.toThrow(/Not a file/);
	});

	it("throws when the entry is not a file", async () => {
		gh.getContent.mockResolvedValue({ data: { type: "submodule", sha: "s" } });
		await expect(client.readNote("mod")).rejects.toThrow(/Not a file/);
	});
});

describe("writeNote", () => {
	const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

	it("creates a note when it does not exist, base64-encoding UTF-8 content", async () => {
		gh.getContent.mockRejectedValue(notFound());
		gh.createOrUpdateFileContents.mockResolvedValue({ data: {} });

		const result = await client.writeNote("notes/new.md", "body ☕");

		expect(result).toEqual({ path: "notes/new.md", created: true });
		const call = gh.createOrUpdateFileContents.mock.calls[0][0];
		expect(call.content).toBe(b64("body ☕"));
		expect(call.path).toBe("notes/new.md");
		expect(call.branch).toBe("main");
		expect(call.sha).toBeUndefined();
		expect(call.message).toContain("Create");
	});

	it("overwrites an existing note, passing its current sha", async () => {
		gh.getContent.mockResolvedValue({ data: { type: "file", sha: "old-sha" } });
		gh.createOrUpdateFileContents.mockResolvedValue({ data: {} });

		const result = await client.writeNote("notes/a.md", "updated");

		expect(result).toEqual({ path: "notes/a.md", created: false });
		const call = gh.createOrUpdateFileContents.mock.calls[0][0];
		expect(call.sha).toBe("old-sha");
		expect(call.message).toContain("Update");
	});

	it("rejects an invalid path before hitting the API", async () => {
		await expect(client.writeNote("../escape.md", "x")).rejects.toBeInstanceOf(VaultError);
		expect(gh.createOrUpdateFileContents).not.toHaveBeenCalled();
	});

	it("rejects a non-note path", async () => {
		await expect(client.writeNote("notes/a.txt", "x")).rejects.toThrow(/Not a note/);
		expect(gh.createOrUpdateFileContents).not.toHaveBeenCalled();
	});

	it("rejects a path hidden by policy", async () => {
		await expect(client.writeNote(".obsidian/secret.md", "x")).rejects.toBeInstanceOf(VaultError);
		expect(gh.createOrUpdateFileContents).not.toHaveBeenCalled();
	});
});

describe("deleteNote", () => {
	const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

	it("deletes an existing note, passing its current sha", async () => {
		gh.getContent.mockResolvedValue({ data: { type: "file", sha: "old-sha" } });
		gh.deleteFile.mockResolvedValue({ data: {} });

		const result = await client.deleteNote("notes/a.md");

		expect(result).toEqual({ path: "notes/a.md" });
		const call = gh.deleteFile.mock.calls[0][0];
		expect(call.path).toBe("notes/a.md");
		expect(call.sha).toBe("old-sha");
		expect(call.branch).toBe("main");
		expect(call.message).toContain("Delete");
	});

	it("throws when the note does not exist", async () => {
		gh.getContent.mockRejectedValue(notFound());
		await expect(client.deleteNote("notes/ghost.md")).rejects.toThrow(/Note not found/);
		expect(gh.deleteFile).not.toHaveBeenCalled();
	});

	it("rejects an invalid path before hitting the API", async () => {
		await expect(client.deleteNote("../escape.md")).rejects.toBeInstanceOf(VaultError);
		expect(gh.deleteFile).not.toHaveBeenCalled();
	});

	it("rejects a non-note path", async () => {
		await expect(client.deleteNote("notes/a.txt")).rejects.toThrow(/Not a note/);
		expect(gh.deleteFile).not.toHaveBeenCalled();
	});

	it("rejects a path hidden by policy", async () => {
		await expect(client.deleteNote(".obsidian/secret.md")).rejects.toBeInstanceOf(VaultError);
		expect(gh.deleteFile).not.toHaveBeenCalled();
	});
});

describe("searchNotes", () => {
	it("merges content-search and filename hits, de-duplicating by path", async () => {
		gh.code.mockResolvedValue({
			data: {
				items: [
					{
						path: "notes/found.md",
						text_matches: [{ fragment: "hello" }, { fragment: undefined }],
					},
				],
			},
		});
		gh.getTree.mockResolvedValue(
			treeResult([
				{ path: "notes/found.md", type: "blob" }, // same path — merged
				{ path: "notes/query-name.md", type: "blob" }, // filename match
				{ path: "other.txt", type: "blob" }, // not a note
			]),
		);
		const hits = await client.searchNotes("query", 10);
		const paths = hits.map((h) => h.path).sort();
		expect(paths).toEqual(["notes/found.md", "notes/query-name.md"]);
		const found = hits.find((h) => h.path === "notes/found.md");
		expect(found?.fragments).toEqual(["hello"]);
	});

	it("falls back to filename search when content search fails", async () => {
		gh.code.mockRejectedValue(new Error("search index cold"));
		gh.getTree.mockResolvedValue(
			treeResult([{ path: "notes/query-here.md", type: "blob" }]),
		);
		const hits = await client.searchNotes("query", 10);
		expect(hits.map((h) => h.path)).toEqual(["notes/query-here.md"]);
	});

	it("respects the result limit", async () => {
		gh.code.mockResolvedValue({ data: { items: [] } });
		gh.getTree.mockResolvedValue(
			treeResult([
				{ path: "a-note.md", type: "blob" },
				{ path: "b-note.md", type: "blob" },
				{ path: "c-note.md", type: "blob" },
			]),
		);
		const hits = await client.searchNotes("note", 2);
		expect(hits).toHaveLength(2);
	});
});
