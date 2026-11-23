/**
 * Kept in its own module so the auth providers can use it without importing
 * `vault.ts` (and, through it, the storage backends).
 */
export function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}
