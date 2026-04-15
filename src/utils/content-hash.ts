/** FNV-1a 32-bit hash — fast, good distribution, no crypto overhead. */
export function fnv1a(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

/**
 * Compute a stable content hash from article text.
 * Strips formatting artifacts (extra whitespace, line breaks) so minor
 * layout changes don't trigger false positives.
 */
export function contentHash(text: string): string {
	const normalized = text.replace(/\s+/g, ' ').trim();
	return fnv1a(normalized);
}
