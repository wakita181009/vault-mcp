import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Storage, type S3StorageConfig } from "../../src/storage/s3";
import { parseListPage } from "../../src/storage/s3/xml";
import { VaultError } from "../../src/storage/types";
import { VaultClient } from "../../src/vault";

const CONFIG: S3StorageConfig = {
	bucket: "vault",
	region: "us-east-1",
	endpoint: "https://s3.example.com",
	accessKeyId: "AKIAEXAMPLE",
	secretAccessKey: "secret",
	maxSearchScan: 40,
};

type Stored = { body: string; modified: Date; headers: Record<string, string> };

/**
 * Path-style S3 stand-in behind `fetch`. Keys come back form-encoded the way
 * AWS does it for `encoding-type=url` (space as `+`), so decoding is exercised.
 */
function fakeS3(initial: Record<string, string> = {}, { pageSize = 1000, urlEncoded = true } = {}) {
	const objects = new Map<string, Stored>(
		Object.entries(initial).map(([key, body], i) => [
			key,
			{ body, modified: new Date(i * 1000), headers: {} },
		]),
	);
	const requests: Request[] = [];
	const failures = new Map<string, Response>();

	const encodeKey = (key: string) =>
		urlEncoded
			? encodeURIComponent(key).replace(/%20/g, "+")
			: key.replace(/&/g, "&amp;").replace(/</g, "&lt;");

	const list = (url: URL) => {
		const keys = [...objects.keys()].sort();
		const start = Number(url.searchParams.get("continuation-token") ?? 0);
		const page = keys.slice(start, start + pageSize);
		const next = start + pageSize;
		const contents = page
			.map((key) => {
				const obj = objects.get(key) as Stored;
				return `<Contents><Key>${encodeKey(key)}</Key><LastModified>${obj.modified.toISOString()}</LastModified><Size>${new TextEncoder().encode(obj.body).length}</Size></Contents>`;
			})
			.join("");
		return new Response(
			`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${urlEncoded ? "<EncodingType>url</EncodingType>" : ""}<IsTruncated>${next < keys.length}</IsTruncated>${contents}${next < keys.length ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`,
			{ headers: { "content-type": "application/xml" } },
		);
	};

	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = input instanceof Request ? input : new Request(input, init);
		requests.push(req);
		const url = new URL(req.url);
		const failure = failures.get(`${req.method} ${url.pathname}`);
		if (failure) return failure.clone();
		if (url.pathname === "/vault" && url.searchParams.get("list-type") === "2") return list(url);

		const key = decodeURIComponent(url.pathname.replace(/^\/vault\//, ""));
		const obj = objects.get(key);
		switch (req.method) {
			case "GET":
				return obj
					? new Response(obj.body)
					: new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
			case "HEAD":
				return obj
					? new Response(null, { headers: obj.headers })
					: new Response(null, { status: 404 });
			case "PUT": {
				const headers = Object.fromEntries(
					[...req.headers].filter(([name]) => name.startsWith("x-amz-meta-")),
				);
				objects.set(key, { body: await req.text(), modified: new Date(), headers });
				return new Response(null, { status: 200 });
			}
			case "DELETE":
				objects.delete(key);
				return new Response(null, { status: 204 });
		}
		return new Response(null, { status: 405 });
	});

	return { objects, requests, failures, fetchMock };
}

let s3: ReturnType<typeof fakeS3>;
const storage = (config: Partial<S3StorageConfig> = {}) => new S3Storage({ ...CONFIG, ...config });
const install = (fake: ReturnType<typeof fakeS3>) => {
	s3 = fake;
	vi.stubGlobal("fetch", fake.fetchMock);
};

beforeEach(() => install(fakeS3()));
afterEach(() => vi.unstubAllGlobals());

describe("S3Storage requests", () => {
	it("signs every request with SigV4 for the configured region", async () => {
		install(fakeS3({ "a.md": "x" }));
		await storage().readFile("a.md");
		const auth = s3.requests[0]?.headers.get("authorization") ?? "";
		expect(auth).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/,
		);
	});

	it("uses path-style URLs on a custom endpoint, percent-encoding each key segment", async () => {
		install(fakeS3({ "my notes/a+b (1).md": "x" }));
		await storage({ endpoint: "https://s3.example.com/" }).readFile("my notes/a+b (1).md");
		expect(s3.requests[0]?.url).toBe("https://s3.example.com/vault/my%20notes/a%2Bb%20(1).md");
	});

	it("uses virtual-hosted AWS URLs when no endpoint is set", async () => {
		await storage({ endpoint: undefined, region: "ap-northeast-1" })
			.readFile("a.md")
			.catch(() => {});
		await storage({ endpoint: undefined, region: "ap-northeast-1" })
			.listFiles()
			.catch(() => {});
		expect(s3.requests[0]?.url).toBe("https://vault.s3.ap-northeast-1.amazonaws.com/a.md");
		expect(s3.requests[1]?.url).toMatch(/^https:\/\/vault\.s3\.ap-northeast-1\.amazonaws\.com\/\?/);
	});

	it("does not retry a failed request (each retry would spend a subrequest)", async () => {
		s3.failures.set(
			"GET /vault/a.md",
			new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }),
		);
		await expect(storage().readFile("a.md")).rejects.toThrow(
			"S3 GetObject failed: 500 InternalError",
		);
		expect(s3.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports the status alone for a failed HEAD, which has no body", async () => {
		s3.failures.set("HEAD /vault/a.md", new Response(null, { status: 403 }));
		await expect(storage().deleteFile("a.md")).rejects.toThrow(/^S3 HeadObject failed: 403$/);
	});
});

describe("S3Storage.listFiles", () => {
	it("lists every object with size and modification time, decoding keys", async () => {
		install(fakeS3({ "a b.md": "abc", "dir/日本.md": "x", "c+d%.md": "" }));
		const { files, truncated } = await storage().listFiles();
		expect(truncated).toBe(false);
		expect(files.map((f) => f.path).sort()).toEqual(["a b.md", "c+d%.md", "dir/日本.md"]);
		expect(files.find((f) => f.path === "a b.md")).toMatchObject({
			size: 3,
			modifiedAt: new Date(0),
		});
		expect(s3.requests[0]?.url).toContain("encoding-type=url");
	});

	it("follows continuation tokens across pages", async () => {
		install(fakeS3({ "a.md": "", "b.md": "", "c.md": "" }, { pageSize: 2 }));
		const { files } = await storage().listFiles();
		expect(files.map((f) => f.path)).toEqual(["a.md", "b.md", "c.md"]);
		expect(new URL(s3.requests[1]?.url ?? "").searchParams.get("continuation-token")).toBe("2");
	});

	it("stops after five pages and flags the listing as truncated", async () => {
		const many = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`n${i}.md`, ""]));
		install(fakeS3(many, { pageSize: 1 }));
		const { files, truncated } = await storage().listFiles();
		expect(files).toHaveLength(5);
		expect(truncated).toBe(true);
	});

	it("skips zero-byte folder markers", async () => {
		install(fakeS3({ "dir/": "", "dir/a.md": "x" }));
		expect((await storage().listFiles()).files.map((f) => f.path)).toEqual(["dir/a.md"]);
	});

	it("reads raw keys from a server that ignores encoding-type", async () => {
		install(fakeS3({ "50%+ & <more>.md": "x" }, { urlEncoded: false }));
		expect((await storage().listFiles()).files.map((f) => f.path)).toEqual(["50%+ & <more>.md"]);
	});

	it("surfaces a listing error with its S3 code", async () => {
		s3.failures.set(
			"GET /vault",
			new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
		);
		await expect(storage().listFiles()).rejects.toThrow(
			"S3 ListObjectsV2 failed: 403 AccessDenied",
		);
	});
});

describe("S3Storage.readFile", () => {
	it("returns the object's UTF-8 text", async () => {
		install(fakeS3({ "a.md": "héllo" }));
		expect(await storage().readFile("a.md")).toBe("héllo");
	});

	it("throws VaultError for a missing note", async () => {
		await expect(storage().readFile("missing.md")).rejects.toBeInstanceOf(VaultError);
	});

	it("treats a body-less 404 as a missing note", async () => {
		s3.failures.set("GET /vault/a.md", new Response(null, { status: 404 }));
		await expect(storage().readFile("a.md")).rejects.toBeInstanceOf(VaultError);
	});

	it("reports a missing bucket as an S3 error, not a missing note", async () => {
		s3.failures.set(
			"GET /vault/a.md",
			new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }),
		);
		await expect(storage().readFile("a.md")).rejects.toThrow(
			"S3 GetObject failed: 404 NoSuchBucket",
		);
	});
});

describe("S3Storage.writeFile", () => {
	it("creates a missing note as markdown", async () => {
		expect(await storage().writeFile("new.md", "# hi")).toEqual({ created: true });
		expect(s3.objects.get("new.md")?.body).toBe("# hi");
		const put = s3.requests.find((r) => r.method === "PUT");
		expect(put?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
	});

	it("overwrites an existing note, keeping its user metadata", async () => {
		install(fakeS3({ "a.md": "old" }));
		(s3.objects.get("a.md") as Stored).headers = {
			"x-amz-meta-mtime": "123",
			"content-language": "en",
		};
		expect(await storage().writeFile("a.md", "new")).toEqual({ created: false });
		expect(s3.objects.get("a.md")).toMatchObject({
			body: "new",
			headers: { "x-amz-meta-mtime": "123" },
		});
		const put = s3.requests.find((r) => r.method === "PUT");
		expect(put?.headers.has("content-language")).toBe(false);
	});
});

describe("S3Storage.deleteFile", () => {
	it("deletes an existing note", async () => {
		install(fakeS3({ "a.md": "x" }));
		expect(await storage().deleteFile("a.md")).toBe(true);
		expect(s3.objects.has("a.md")).toBe(false);
	});

	it("reports a missing note without sending a DELETE", async () => {
		expect(await storage().deleteFile("missing.md")).toBe(false);
		expect(s3.requests.some((r) => r.method === "DELETE")).toBe(false);
	});
});

describe("S3Storage.searchContent", () => {
	const allFiles = (s: S3Storage) => async () => (await s.listFiles()).files;

	it("finds matching notes with fragments", async () => {
		install(fakeS3({ "a.md": "nothing", "b.md": "the Needle here" }));
		const s = storage();
		expect(await s.searchContent("needle", 10, allFiles(s))).toEqual([
			{ path: "b.md", fragments: ["the Needle here"] },
		]);
	});

	it("reads at most maxSearchScan notes, newest first", async () => {
		install(fakeS3({ "old.md": "needle", "new.md": "needle" }));
		const s = storage({ maxSearchScan: 1 });
		expect((await s.searchContent("needle", 10, allFiles(s))).map((h) => h.path)).toEqual([
			"new.md",
		]);
		expect(
			s3.requests.filter((r) => r.method === "GET" && !r.url.includes("list-type")),
		).toHaveLength(1);
	});

	it("skips a note deleted between listing and reading", async () => {
		install(fakeS3({ "a.md": "needle" }));
		const s = storage();
		const listed = await allFiles(s)();
		s3.objects.delete("a.md");
		expect(await s.searchContent("needle", 10, async () => listed)).toEqual([]);
	});
});

describe("S3Storage behind the VaultClient policy", () => {
	it("never lets a `.` segment smuggle a denied path past the prefix check", async () => {
		install(fakeS3({ ".obsidian/x.md": "hidden" }));
		const client = new VaultClient(storage(), {
			allowedPrefixes: [],
			deniedPrefixes: [".obsidian/"],
		});
		await expect(client.readNote("./.obsidian/x.md")).rejects.toThrow(/Invalid path/);
		await expect(client.writeNote("./.obsidian/x.md", "pwn")).rejects.toThrow(/Invalid path/);
		await expect(client.deleteNote("./.obsidian/x.md")).rejects.toThrow(/Invalid path/);
		expect(s3.requests).toEqual([]);
		expect(s3.objects.get(".obsidian/x.md")?.body).toBe("hidden");
	});
});

describe("parseListPage", () => {
	it("decodes XML entities in non-key fields", () => {
		const page = parseListPage(
			"<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b&#x3D;&#61;</NextContinuationToken></ListBucketResult>",
		);
		expect(page).toEqual({ objects: [], truncated: true, nextToken: "a&b==" });
	});

	it("tolerates missing Size/LastModified and leaves unknown entities as-is", () => {
		expect(parseListPage("<Contents><Key>&#X41;&nbsp;.md</Key></Contents>").objects).toEqual([
			{ key: "A&nbsp;.md", size: 0 },
		]);
	});

	it("drops a key that is not valid UTF-8 instead of failing the page", () => {
		const page = parseListPage(
			"<EncodingType>url</EncodingType><Contents><Key>caf%E9.md</Key></Contents><Contents><Key>ok.md</Key></Contents>",
		);
		expect(page.objects.map((o) => o.key)).toEqual(["ok.md"]);
	});

	it("leaves an out-of-range numeric entity as-is", () => {
		expect(parseListPage("<Contents><Key>&#x110000;.md</Key></Contents>").objects[0]?.key).toBe(
			"&#x110000;.md",
		);
	});

	it("ignores a Contents entry without a key", () => {
		expect(parseListPage("<Contents><Size>1</Size></Contents>").objects).toEqual([]);
	});
});
