import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultClient, VaultError, type VaultConfig } from "../src/vault";

const gh = vi.hoisted(() => {
	const getContent = vi.fn();
	const getBlob = vi.fn();
	const getTree = vi.fn();
	const code = vi.fn();
	const rest = {
		repos: { getContent },
		git: { getBlob, getTree },
		search: { code },
	};
	return {
		getContent,
		getBlob,
		getTree,
		code,
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
