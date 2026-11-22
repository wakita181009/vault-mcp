import { describe, expect, it, vi } from "vitest";
import { findFragments, R2Storage } from "../../src/storage/r2";
import { VaultError } from "../../src/storage/types";

/**
 * In-memory stand-in for the subset of `R2Bucket` the backend uses. `pageSize`
 * mimics R2's per-call list cap so pagination is exercised with few objects.
 */
function fakeBucket(initial: Record<string, string> = {}, pageSize = 1000) {
	const objects = new Map(Object.entries(initial));
	// Insertion order stands in for upload time: later keys are newer.
	const uploaded = new Map([...objects.keys()].map((key, i) => [key, new Date(i * 1000)]));
	const custom = new Map<string, Record<string, string>>();
	const meta = (key: string) => ({
		key,
		size: new TextEncoder().encode(objects.get(key)).length,
		uploaded: uploaded.get(key) ?? new Date(0),
		customMetadata: custom.get(key),
	});
	const bucket = {
		head: vi.fn(async (key: string) => (objects.has(key) ? meta(key) : null)),
		get: vi.fn(async (key: string) => {
			const body = objects.get(key);
			return body === undefined ? null : { ...meta(key), text: async () => body };
		}),
		put: vi.fn(async (key: string, value: string, options?: { customMetadata?: Record<string, string> }) => {
			objects.set(key, value);
			uploaded.set(key, new Date(Date.now()));
			if (options?.customMetadata) custom.set(key, options.customMetadata);
			else custom.delete(key);
			return meta(key);
		}),
		delete: vi.fn(async (key: string) => {
			objects.delete(key);
		}),
		list: vi.fn(async (options: { cursor?: string } = {}) => {
			const keys = [...objects.keys()].sort();
			const start = options.cursor ? Number(options.cursor) : 0;
			const page = keys.slice(start, start + pageSize);
			const next = start + pageSize;
			return {
				objects: page.map(meta),
				truncated: next < keys.length,
				...(next < keys.length ? { cursor: String(next) } : {}),
			};
		}),
	};
	return { bucket, objects, custom, storage: new R2Storage(bucket as unknown as R2Bucket) };
}

const all = () => true;

describe("R2Storage.listFiles", () => {
	it("lists every object with its size", async () => {
		const { storage } = fakeBucket({ "a.md": "abc", "dir/b.md": "x" });
		expect(await storage.listFiles()).toEqual({
			files: [
				{ path: "a.md", size: 3 },
				{ path: "dir/b.md", size: 1 },
			],
			truncated: false,
		});
	});

	it("follows the list cursor across pages", async () => {
		const { storage, bucket } = fakeBucket({ "a.md": "", "b.md": "", "c.md": "" }, 2);
		const { files, truncated } = await storage.listFiles();
		expect(files.map((f) => f.path)).toEqual(["a.md", "b.md", "c.md"]);
		expect(truncated).toBe(false);
		expect(bucket.list).toHaveBeenCalledTimes(2);
	});

	it("skips zero-byte folder markers", async () => {
		const { storage } = fakeBucket({ "dir/": "", "dir/a.md": "x" });
		expect((await storage.listFiles()).files.map((f) => f.path)).toEqual(["dir/a.md"]);
	});

	it("stops at the page cap and reports truncation", async () => {
		const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`n${i}.md`, ""]));
		const { storage, bucket } = fakeBucket(many, 1);
		const { files, truncated } = await storage.listFiles();
		expect(truncated).toBe(true);
		expect(files).toHaveLength(20);
		expect(bucket.list).toHaveBeenCalledTimes(20);
	});
});

describe("R2Storage.readFile", () => {
	it("returns the object body as text", async () => {
		const { storage } = fakeBucket({ "a.md": "# Hi ✓" });
		expect(await storage.readFile("a.md")).toBe("# Hi ✓");
	});

	it("throws VaultError for a missing key", async () => {
		const { storage } = fakeBucket();
		await expect(storage.readFile("nope.md")).rejects.toBeInstanceOf(VaultError);
	});
});

describe("R2Storage.writeFile", () => {
	it("reports created for a new key and stores it as markdown", async () => {
		const { storage, objects, bucket } = fakeBucket();
		expect(await storage.writeFile("a.md", "new")).toEqual({ created: true });
		expect(objects.get("a.md")).toBe("new");
		expect(bucket.put).toHaveBeenCalledWith("a.md", "new", {
			httpMetadata: { contentType: "text/markdown; charset=utf-8" },
		});
	});

	it("keeps sync-plugin custom metadata across an overwrite", async () => {
		const { storage, custom } = fakeBucket({ "a.md": "old" });
		custom.set("a.md", { mtime: "123" });
		await storage.writeFile("a.md", "new");
		expect(custom.get("a.md")).toEqual({ mtime: "123" });
	});

	it("reports not-created when overwriting", async () => {
		const { storage, objects } = fakeBucket({ "a.md": "old" });
		expect(await storage.writeFile("a.md", "new")).toEqual({ created: false });
		expect(objects.get("a.md")).toBe("new");
	});
});

describe("R2Storage.deleteFile", () => {
	it("deletes an existing key", async () => {
		const { storage, objects } = fakeBucket({ "a.md": "x" });
		expect(await storage.deleteFile("a.md")).toBe(true);
		expect(objects.has("a.md")).toBe(false);
	});

	it("returns false without deleting when the key is absent", async () => {
		const { storage, bucket } = fakeBucket();
		expect(await storage.deleteFile("a.md")).toBe(false);
		expect(bucket.delete).not.toHaveBeenCalled();
	});
});

describe("R2Storage.searchContent", () => {
	it("matches content case-insensitively with fragments", async () => {
		const { storage } = fakeBucket({ "a.md": "Hello World", "b.md": "nothing here" });
		expect(await storage.searchContent("world", 10, all)).toEqual([
			{ path: "a.md", fragments: ["Hello World"] },
		]);
	});

	it("only reads candidates the caller accepts", async () => {
		const { storage, bucket } = fakeBucket({ "a.md": "hit", ".obsidian/x.md": "hit" });
		const hits = await storage.searchContent("hit", 10, (p) => !p.startsWith(".obsidian/"));
		expect(hits.map((h) => h.path)).toEqual(["a.md"]);
		expect(bucket.get).not.toHaveBeenCalledWith(".obsidian/x.md");
	});

	it("stops scanning once the limit is reached", async () => {
		const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`n${i}.md`, "hit"]));
		const { storage, bucket } = fakeBucket(many);
		const hits = await storage.searchContent("hit", 2, all);
		expect(hits).toHaveLength(2);
		// One concurrent batch, not all 30 objects.
		expect(bucket.get).toHaveBeenCalledTimes(6);
	});

	it("caps how many objects one search reads", async () => {
		const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`n${i}.md`, "miss"]));
		const { storage, bucket } = fakeBucket(many);
		expect(await storage.searchContent("hit", 10, all)).toEqual([]);
		expect(bucket.get).toHaveBeenCalledTimes(500);
	});

	it("treats regex metacharacters in the query literally", async () => {
		const { storage } = fakeBucket({ "a.md": "cost is $5 (approx)", "b.md": "cost is 55" });
		expect((await storage.searchContent("$5 (", 10, all)).map((h) => h.path)).toEqual(["a.md"]);
	});

	it("scans the most recently uploaded notes first", async () => {
		const { storage, bucket } = fakeBucket({ "old.md": "hit", "new.md": "hit" });
		expect((await storage.searchContent("hit", 1, all)).map((h) => h.path)).toEqual(["new.md"]);
		expect(bucket.get.mock.calls[0]?.[0]).toBe("new.md");
	});

	it("keeps other hits when one object fails to read", async () => {
		const { storage, bucket } = fakeBucket({ "a.md": "hit", "b.md": "hit" });
		bucket.get.mockRejectedValueOnce(new Error("R2 transient"));
		expect(await storage.searchContent("hit", 10, all)).toHaveLength(1);
	});

	it("treats an object deleted mid-scan as a non-match", async () => {
		const { storage, bucket } = fakeBucket({ "a.md": "hit" });
		bucket.get.mockResolvedValueOnce(null);
		expect(await storage.searchContent("hit", 10, all)).toEqual([]);
	});

	it("returns nothing for an empty query without reading", async () => {
		const { storage, bucket } = fakeBucket({ "a.md": "x" });
		expect(await storage.searchContent("", 10, all)).toEqual([]);
		expect(bucket.list).not.toHaveBeenCalled();
	});
});

describe("findFragments", () => {
	it("returns context around each non-overlapping hit, up to three", () => {
		const text = ["x".repeat(100), "KEY", "y".repeat(200), "key", "z".repeat(200), "key", "w".repeat(200), "key"].join("");
		const fragments = findFragments(text, /key/giu);
		expect(fragments).toHaveLength(3);
		expect(fragments[0]).toBe(`${"x".repeat(60)}KEY${"y".repeat(60)}`);
	});

	it("clamps fragments at the text edges", () => {
		expect(findFragments("key at start", /key/giu)).toEqual(["key at start"]);
	});

	it("stays aligned after characters whose lowercase form is longer", () => {
		expect(findFragments("İİİ needle", /needle/giu)).toEqual(["İİİ needle"]);
	});
});
