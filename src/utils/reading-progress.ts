/** Shared reading progress logic — extracted for testability. */

export interface HeadingInfo {
	text: string;
	level: 2 | 3 | 4 | 5 | 6;
	/** True when the heading has its own prose before the first child heading. */
	hasOwnContent?: boolean;
}

export function normaliseHeading(text: string): string {
	return text.trim().replace(/\s+/g, ' ');
}

export function headingMatches(a: string, b: string): boolean {
	return normaliseHeading(a) === normaliseHeading(b);
}

/**
 * Build parent→direct-children map from a flat ordered heading list.
 * Works for all levels: an h2's children are the h3s that follow it
 * (until the next h2), an h3's children are the h4s that follow it
 * (until the next h2 or h3), etc.
 */
export function buildHierarchy(headings: HeadingInfo[]): Map<string, string[]> {
	const map = new Map<string, string[]>();

	for (let i = 0; i < headings.length; i++) {
		const parent = headings[i];
		const children: string[] = [];

		for (let j = i + 1; j < headings.length; j++) {
			if (headings[j].level <= parent.level) break; // same or shallower — stop
			if (headings[j].level === parent.level + 1) {
				children.push(headings[j].text);
			}
		}

		map.set(parent.text, children);
	}

	return map;
}

/**
 * Collect ALL descendants (not just direct children) of a heading.
 * Used for cascading toggle: checking a parent checks the entire subtree.
 */
export function getDescendants(headings: HeadingInfo[], parentIdx: number): string[] {
	const parent = headings[parentIdx];
	const descendants: string[] = [];
	for (let j = parentIdx + 1; j < headings.length; j++) {
		if (headings[j].level <= parent.level) break;
		descendants.push(headings[j].text);
	}
	return descendants;
}

/** Recompute parent completion bottom-up: done iff all descendants are done. Mutates progress in-place.
 *  Parents with `hasOwnContent` are independent — their state is never auto-derived. */
export function recomputeParentProgress(headings: HeadingInfo[], progress: string[]): void {
	// Process bottom-up so deeper parents resolve before shallower ones
	for (let i = headings.length - 1; i >= 0; i--) {
		if (headings[i].hasOwnContent) continue; // independent checkbox
		const descendants = getDescendants(headings, i);
		if (descendants.length === 0) continue;

		const allDone = descendants.every(d =>
			progress.some(p => headingMatches(p, d))
		);
		const parentIdx = progress.findIndex(p => headingMatches(p, headings[i].text));
		if (allDone && parentIdx === -1) {
			progress.push(headings[i].text);
		} else if (!allDone && parentIdx >= 0) {
			progress.splice(parentIdx, 1);
		}
	}
}

/**
 * Toggle a heading's progress. Handles parent-child cascading:
 * - Parents with `hasOwnContent` toggle independently (like a leaf).
 * - Other parents with descendants toggle the entire subtree.
 * - Leaf headings recompute ancestor states.
 * Returns the new progress array (mutated in-place).
 */
export function toggleHeadingProgress(
	headings: HeadingInfo[],
	progress: string[],
	headingText: string,
): string[] {
	const normalized = normaliseHeading(headingText);

	// Find this heading's index in the list
	const headingIdx = headings.findIndex(h => normaliseHeading(h.text) === normalized);
	const heading = headingIdx >= 0 ? headings[headingIdx] : null;
	const descendants = headingIdx >= 0 ? getDescendants(headings, headingIdx) : [];

	if (descendants.length > 0 && !heading?.hasOwnContent) {
		// Pure parent heading: toggle entire subtree
		const parentDone = progress.some(p => normaliseHeading(p) === normalized);
		if (parentDone) {
			// Uncheck: remove parent + all descendants
			const toRemove = new Set([normalized, ...descendants.map(normaliseHeading)]);
			for (let i = progress.length - 1; i >= 0; i--) {
				if (toRemove.has(normaliseHeading(progress[i]))) {
					progress.splice(i, 1);
				}
			}
		} else {
			// Check: add all descendants + parent
			for (const desc of descendants) {
				if (!progress.some(p => headingMatches(p, desc))) {
					progress.push(desc);
				}
			}
			if (!progress.some(p => normaliseHeading(p) === normalized)) {
				progress.push(headingText);
			}
		}
	} else {
		// Leaf or independent parent: simple toggle
		const idx = progress.findIndex(p => normaliseHeading(p) === normalized);
		if (idx >= 0) {
			progress.splice(idx, 1);
		} else {
			progress.push(headingText);
		}
	}

	recomputeParentProgress(headings, progress);
	return progress;
}
