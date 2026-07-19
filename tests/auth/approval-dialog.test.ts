import { describe, expect, it } from "vitest";
import { sanitizeText, sanitizeUrl } from "../../src/auth/approval-dialog";

describe("sanitizeText", () => {
	it("escapes all HTML-significant characters", () => {
		expect(sanitizeText(`a & b <c> "d" 'e'`)).toBe(
			"a &amp; b &lt;c&gt; &quot;d&quot; &#039;e&#039;",
		);
	});

	it("neutralizes a script payload", () => {
		expect(sanitizeText("<script>alert('xss')</script>")).toBe(
			"&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
		);
	});

	it("escapes ampersands first so entities are not double-encoded", () => {
		expect(sanitizeText("&lt;")).toBe("&amp;lt;");
	});
});

describe("sanitizeUrl", () => {
	it("accepts http and https URLs and trims surrounding whitespace", () => {
		expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
		expect(sanitizeUrl("http://example.com/path")).toBe("http://example.com/path");
		expect(sanitizeUrl("  https://example.com  ")).toBe("https://example.com");
	});

	it("rejects dangerous schemes", () => {
		expect(sanitizeUrl("javascript:alert(1)")).toBe("");
		expect(sanitizeUrl("data:text/html,<script>1</script>")).toBe("");
		expect(sanitizeUrl("file:///etc/passwd")).toBe("");
		expect(sanitizeUrl("ftp://example.com")).toBe("");
	});

	it("rejects empty, non-URL, and control-character input", () => {
		expect(sanitizeUrl("")).toBe("");
		expect(sanitizeUrl("   ")).toBe("");
		expect(sanitizeUrl("not a url")).toBe("");
		expect(sanitizeUrl("https://example.com/\x01path")).toBe("");
	});

	it("accepts schemes case-insensitively", () => {
		expect(sanitizeUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
	});
});
