import { describe, expect, it } from "vitest";
import { parseList } from "../src/parse-list";

describe("parseList", () => {
	it("returns an empty array for undefined or empty input", () => {
		expect(parseList(undefined)).toEqual([]);
		expect(parseList("")).toEqual([]);
	});

	it("splits on commas, trimming and dropping empty entries", () => {
		expect(parseList("a, b ,c")).toEqual(["a", "b", "c"]);
		expect(parseList("a,,b, ,c")).toEqual(["a", "b", "c"]);
	});
});
