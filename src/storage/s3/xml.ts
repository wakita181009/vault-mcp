/**
 * Minimal readers for the S3 XML responses this backend consumes. Workers have
 * no DOMParser, and the documents are machine-generated with a fixed shape, so
 * tag extraction is enough without pulling in an XML library.
 */

export type ListedObject = { key: string; size: number; lastModified?: Date };

export type ListPage = {
	objects: ListedObject[];
	truncated: boolean;
	nextToken?: string;
};

const XML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

function decodeXml(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(entity, body: string) => {
			if (body[0] === "#") {
				const code =
					body[1] === "x" || body[1] === "X"
						? Number.parseInt(body.slice(2), 16)
						: Number(body.slice(1));
				return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
			}
			return XML_ENTITIES[body] ?? entity;
		},
	);
}

function tagText(xml: string, tag: string): string | undefined {
	const raw = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
	return raw === undefined ? undefined : decodeXml(raw);
}

/**
 * S3 form-encodes keys (space as `+`), matching botocore's `unquote_plus`. A key
 * whose bytes are not UTF-8 cannot be decoded or addressed as a vault path, so it
 * is dropped rather than failing the whole listing.
 */
function decodeKey(key: string): string | undefined {
	try {
		return decodeURIComponent(key.replace(/\+/g, " "));
	} catch {
		return undefined;
	}
}

/** Parses one ListObjectsV2 page, requested with `encoding-type=url`. */
export function parseListPage(xml: string): ListPage {
	// Honour the response, not the request: a compatible server that ignores
	// `encoding-type` returns raw keys, and decoding those would corrupt any `%` or `+`.
	const urlEncoded = tagText(xml, "EncodingType") === "url";
	const objects = [
		...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g),
	].flatMap(([, block]) => {
		const raw = tagText(block, "Key");
		const key =
			raw === undefined ? undefined : urlEncoded ? decodeKey(raw) : raw;
		if (key === undefined) return [];
		const modified = tagText(block, "LastModified");
		return [
			{
				key,
				size: Number(tagText(block, "Size") ?? 0),
				...(modified ? { lastModified: new Date(modified) } : {}),
			},
		];
	});

	return {
		objects,
		truncated: tagText(xml, "IsTruncated") === "true",
		nextToken: tagText(xml, "NextContinuationToken"),
	};
}

/** The `<Code>` of an S3 error document (e.g. `AccessDenied`), if present. */
export function parseErrorCode(xml: string): string | undefined {
	return tagText(xml, "Code");
}
