import { describe, expect, it } from "vitest";
import {
	type ApprovalDialogOptions,
	renderApprovalDialog,
	sanitizeText,
	sanitizeUrl,
} from "../../src/auth/approval-dialog";

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

describe("renderApprovalDialog", () => {
	const baseOptions: ApprovalDialogOptions = {
		client: null,
		server: { name: "Vault MCP" },
		state: { oauthReqInfo: { clientId: "c1" } },
		csrfToken: "csrf-abc",
		setCookie: "__Host-CSRF_TOKEN=csrf-abc; HttpOnly",
	};
	const request = new Request("https://mcp.example/authorize");

	it("sets security headers and the CSRF cookie", () => {
		const res = renderApprovalDialog(request, baseOptions);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Set-Cookie")).toBe(baseOptions.setCookie);
	});

	it("embeds the encoded state and CSRF token in the form", async () => {
		const res = renderApprovalDialog(request, baseOptions);
		const html = await res.text();
		expect(html).toContain(`value="${btoa(JSON.stringify(baseOptions.state))}"`);
		expect(html).toContain('name="csrf_token" value="csrf-abc"');
		expect(html).toContain('action="/authorize"');
		expect(html).toContain("Unknown MCP Client");
	});

	it("renders optional server and client fields when present and valid", async () => {
		const res = renderApprovalDialog(request, {
			...baseOptions,
			server: {
				name: "Vault MCP",
				description: "A private vault",
				logo: "https://example.com/logo.png",
			},
			client: {
				clientId: "c1",
				clientName: "Claude",
				clientUri: "https://claude.ai",
				policyUri: "https://claude.ai/privacy",
				tosUri: "https://claude.ai/tos",
				contacts: ["team@claude.ai"],
				redirectUris: ["https://claude.ai/callback", "javascript:alert(1)"],
			} as ApprovalDialogOptions["client"],
		});
		const html = await res.text();
		expect(html).toContain("A private vault");
		expect(html).toContain('src="https://example.com/logo.png"');
		expect(html).toContain("https://claude.ai/privacy");
		expect(html).toContain("https://claude.ai/tos");
		expect(html).toContain("team@claude.ai");
		expect(html).toContain("https://claude.ai/callback");
		// The unsafe redirect URI is dropped by sanitizeUrl.
		expect(html).not.toContain("javascript:alert(1)");
	});

	it("escapes a malicious client name", async () => {
		const res = renderApprovalDialog(request, {
			...baseOptions,
			client: { clientId: "c1", clientName: "<script>alert(1)</script>" } as ApprovalDialogOptions["client"],
		});
		const html = await res.text();
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
