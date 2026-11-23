import { describe, expect, it } from "vitest";
import { findFragments } from "../../src/storage/scan-search";

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
