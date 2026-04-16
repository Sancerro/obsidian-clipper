import { describe, expect, test } from 'vitest';
import {
	normaliseHeading,
	headingMatches,
	buildHierarchy,
	getDescendants,
	recomputeParentProgress,
	toggleHeadingProgress,
	type HeadingInfo,
} from './reading-progress';

// ── Fixtures ──────────────────────────────────────────────────

const HEADINGS: HeadingInfo[] = [
	{ text: 'Personality', level: 2 },
	{ text: 'Work habits', level: 3 },
	{ text: 'Mathematical range', level: 3 },
	{ text: 'Preferred problem-solving techniques', level: 3 },
	{ text: 'Lecture style', level: 3 },
	{ text: 'Career', level: 2 },
	{ text: 'Early work', level: 3 },
	{ text: 'Later work', level: 3 },
	{ text: 'Legacy', level: 2 },
];

// Multi-level: h2 → h3 → h4
const DEEP_HEADINGS: HeadingInfo[] = [
	{ text: 'The Boys Series', level: 2 },
	{ text: 'Background', level: 3 },
	{ text: 'Childhood', level: 4 },
	{ text: 'Hero Career', level: 4 },
	{ text: 'Season 1', level: 3 },
	{ text: 'Season 2', level: 3 },
	{ text: 'Lamplighter takes a stand', level: 4 },
	{ text: 'Suicide in Vought Tower', level: 4 },
	{ text: 'Legacy', level: 4 },
	{ text: 'Personality', level: 2 },
];

// Level-gap: h2 → h4 (h3 missing, e.g. content extractor removed intermediate headings)
const GAP_HEADINGS: HeadingInfo[] = [
	{ text: 'Types of Fiber', level: 2 },
	{ text: 'Further defining fiber', level: 3 },
	{ text: 'Fiber and Disease', level: 2 },
	{ text: 'Should I avoid nuts and seeds?', level: 4 }, // gap: h2 → h4
	{ text: 'Bottom Line', level: 2 },
];

// Parent headings with own content — independent checkboxes
const OWN_CONTENT_HEADINGS: HeadingInfo[] = [
	{ text: 'Types of Fiber', level: 2, hasOwnContent: true },
	{ text: 'Soluble fiber', level: 3 },
	{ text: 'Insoluble fiber', level: 3 },
	{ text: 'Benefits', level: 2 },
];

// Mixed: some parents with own content, some without
const MIXED_HEADINGS: HeadingInfo[] = [
	{ text: 'Overview', level: 2, hasOwnContent: true },
	{ text: 'History', level: 3 },
	{ text: 'Modern era', level: 3 },
	{ text: 'Technical details', level: 2 },  // pure parent (no own content)
	{ text: 'Architecture', level: 3 },
	{ text: 'Implementation', level: 3 },
	{ text: 'Performance', level: 2 },  // leaf
];

// Deep with hasOwnContent at multiple levels
const DEEP_OWN_CONTENT: HeadingInfo[] = [
	{ text: 'JVM', level: 2, hasOwnContent: true },
	{ text: 'Bytecode', level: 3, hasOwnContent: true },
	{ text: 'Verification', level: 4 },
	{ text: 'Execution', level: 4 },
	{ text: 'Garbage collection', level: 3 },
	{ text: 'Security', level: 2 },
];

// Single heading (edge case)
const SINGLE_HEADING: HeadingInfo[] = [
	{ text: 'Only section', level: 2 },
];

// All same level (flat structure)
const FLAT_HEADINGS: HeadingInfo[] = [
	{ text: 'Section A', level: 2 },
	{ text: 'Section B', level: 2 },
	{ text: 'Section C', level: 2 },
];

// ── normaliseHeading ──────────────────────────────────────────

describe('normaliseHeading', () => {
	test('trims and collapses whitespace', () => {
		expect(normaliseHeading('  hello   world  ')).toBe('hello world');
	});

	test('handles newlines and tabs', () => {
		expect(normaliseHeading('hello\n\tworld')).toBe('hello world');
	});

	test('empty string', () => {
		expect(normaliseHeading('')).toBe('');
	});

	test('only whitespace', () => {
		expect(normaliseHeading('   \t\n  ')).toBe('');
	});

	test('single word no change', () => {
		expect(normaliseHeading('Overview')).toBe('Overview');
	});

	test('preserves case', () => {
		expect(normaliseHeading('JVM in the Web Browser')).toBe('JVM in the Web Browser');
	});
});

// ── headingMatches ────────────────────────────────────────────

describe('headingMatches', () => {
	test('matches identical strings', () => {
		expect(headingMatches('Personality', 'Personality')).toBe(true);
	});

	test('matches with different whitespace', () => {
		expect(headingMatches('Work  habits', 'Work habits')).toBe(true);
	});

	test('rejects different strings', () => {
		expect(headingMatches('Personality', 'Career')).toBe(false);
	});

	test('matches with leading/trailing whitespace', () => {
		expect(headingMatches('  Personality  ', 'Personality')).toBe(true);
	});

	test('empty strings match', () => {
		expect(headingMatches('', '  ')).toBe(true);
	});
});

// ── buildHierarchy ────────────────────────────────────────────

describe('buildHierarchy', () => {
	test('maps h2 parents to h3 children', () => {
		const hierarchy = buildHierarchy(HEADINGS);
		expect(hierarchy.get('Personality')).toEqual([
			'Work habits',
			'Mathematical range',
			'Preferred problem-solving techniques',
			'Lecture style',
		]);
		expect(hierarchy.get('Career')).toEqual(['Early work', 'Later work']);
		expect(hierarchy.get('Legacy')).toEqual([]);
	});

	test('maps h3 parents to h4 children', () => {
		const hierarchy = buildHierarchy(DEEP_HEADINGS);
		expect(hierarchy.get('Background')).toEqual(['Childhood', 'Hero Career']);
		expect(hierarchy.get('Season 2')).toEqual([
			'Lamplighter takes a stand',
			'Suicide in Vought Tower',
			'Legacy',
		]);
		expect(hierarchy.get('Season 1')).toEqual([]);
	});

	test('h2 maps to direct h3 children only (not h4)', () => {
		const hierarchy = buildHierarchy(DEEP_HEADINGS);
		expect(hierarchy.get('The Boys Series')).toEqual(['Background', 'Season 1', 'Season 2']);
	});

	test('every heading is a key in the map', () => {
		const hierarchy = buildHierarchy(DEEP_HEADINGS);
		expect(hierarchy.size).toBe(DEEP_HEADINGS.length);
	});

	test('flat headings (all same level) have no children', () => {
		const hierarchy = buildHierarchy(FLAT_HEADINGS);
		expect(hierarchy.get('Section A')).toEqual([]);
		expect(hierarchy.get('Section B')).toEqual([]);
		expect(hierarchy.get('Section C')).toEqual([]);
	});

	test('single heading', () => {
		const hierarchy = buildHierarchy(SINGLE_HEADING);
		expect(hierarchy.get('Only section')).toEqual([]);
		expect(hierarchy.size).toBe(1);
	});

	test('empty input', () => {
		const hierarchy = buildHierarchy([]);
		expect(hierarchy.size).toBe(0);
	});
});

// ── getDescendants ────────────────────────────────────────────

describe('getDescendants', () => {
	test('returns all nested descendants', () => {
		const desc = getDescendants(DEEP_HEADINGS, 0); // The Boys Series
		expect(desc).toEqual([
			'Background', 'Childhood', 'Hero Career',
			'Season 1',
			'Season 2', 'Lamplighter takes a stand', 'Suicide in Vought Tower', 'Legacy',
		]);
	});

	test('stops at same-level heading', () => {
		const desc = getDescendants(HEADINGS, 0); // Personality
		expect(desc).toEqual([
			'Work habits', 'Mathematical range',
			'Preferred problem-solving techniques', 'Lecture style',
		]);
		expect(desc).not.toContain('Career');
	});

	test('leaf heading has no descendants', () => {
		expect(getDescendants(HEADINGS, 8)).toEqual([]); // Legacy
		expect(getDescendants(HEADINGS, 1)).toEqual([]); // Work habits
	});

	test('finds h4 under h2 despite level gap', () => {
		const desc = getDescendants(GAP_HEADINGS, 2); // Fiber and Disease
		expect(desc).toContain('Should I avoid nuts and seeds?');
	});

	test('last heading in list', () => {
		expect(getDescendants(FLAT_HEADINGS, 2)).toEqual([]); // Section C
	});
});

// ── recomputeParentProgress ───────────────────────────────────

describe('recomputeParentProgress', () => {
	test('auto-completes parent when all children are done', () => {
		const progress = ['Work habits', 'Mathematical range', 'Preferred problem-solving techniques', 'Lecture style'];
		recomputeParentProgress(HEADINGS, progress);
		expect(progress).toContain('Personality');
	});

	test('does not auto-complete parent when some children are missing', () => {
		const progress = ['Work habits', 'Mathematical range'];
		recomputeParentProgress(HEADINGS, progress);
		expect(progress).not.toContain('Personality');
	});

	test('removes parent when a child is unchecked', () => {
		const progress = ['Personality', 'Work habits', 'Mathematical range', 'Preferred problem-solving techniques'];
		recomputeParentProgress(HEADINGS, progress);
		expect(progress).not.toContain('Personality');
	});

	test('leaves childless h2 untouched', () => {
		const progress = ['Legacy'];
		recomputeParentProgress(HEADINGS, progress);
		expect(progress).toContain('Legacy');
	});

	test('does not add childless h2', () => {
		const progress: string[] = [];
		recomputeParentProgress(HEADINGS, progress);
		expect(progress).not.toContain('Legacy');
	});

	test('cascades bottom-up: completing h4s completes h3 then h2', () => {
		const progress = [
			'Childhood', 'Hero Career',
			'Season 1',
			'Lamplighter takes a stand', 'Suicide in Vought Tower', 'Legacy',
		];
		recomputeParentProgress(DEEP_HEADINGS, progress);
		expect(progress).toContain('Background');
		expect(progress).toContain('Season 2');
		expect(progress).toContain('The Boys Series');
	});

	test('incomplete h4 prevents h3 and h2 from auto-completing', () => {
		const progress = ['Childhood']; // Hero Career missing
		recomputeParentProgress(DEEP_HEADINGS, progress);
		expect(progress).not.toContain('Background');
		expect(progress).not.toContain('The Boys Series');
	});

	test('auto-completes parent with level gap', () => {
		const progress = ['Should I avoid nuts and seeds?'];
		recomputeParentProgress(GAP_HEADINGS, progress);
		expect(progress).toContain('Fiber and Disease');
	});

	test('removes parent when level-gap child is unchecked', () => {
		const progress = ['Fiber and Disease', 'Should I avoid nuts and seeds?'];
		progress.splice(progress.indexOf('Should I avoid nuts and seeds?'), 1);
		recomputeParentProgress(GAP_HEADINGS, progress);
		expect(progress).not.toContain('Fiber and Disease');
	});

	test('does NOT auto-complete parent with hasOwnContent', () => {
		const progress = ['Soluble fiber', 'Insoluble fiber'];
		recomputeParentProgress(OWN_CONTENT_HEADINGS, progress);
		expect(progress).not.toContain('Types of Fiber');
	});

	test('does not remove hasOwnContent parent even if children incomplete', () => {
		const progress = ['Types of Fiber', 'Soluble fiber'];
		recomputeParentProgress(OWN_CONTENT_HEADINGS, progress);
		expect(progress).toContain('Types of Fiber'); // independent, not removed
	});

	test('empty progress stays empty', () => {
		const progress: string[] = [];
		recomputeParentProgress(HEADINGS, progress);
		expect(progress).toEqual([]);
	});

	test('empty headings is a no-op', () => {
		const progress = ['Something'];
		recomputeParentProgress([], progress);
		expect(progress).toEqual(['Something']);
	});

	test('mixed: pure parent auto-derives, hasOwnContent does not', () => {
		// Complete all children of both parents
		const progress = ['History', 'Modern era', 'Architecture', 'Implementation'];
		recomputeParentProgress(MIXED_HEADINGS, progress);
		expect(progress).not.toContain('Overview'); // hasOwnContent — not auto-derived
		expect(progress).toContain('Technical details'); // pure parent — auto-derives
	});

	test('deep hasOwnContent: skips recompute at multiple levels', () => {
		const progress = ['Verification', 'Execution', 'Garbage collection'];
		recomputeParentProgress(DEEP_OWN_CONTENT, progress);
		// Bytecode has hasOwnContent — not auto-completed even though h4s are done
		expect(progress).not.toContain('Bytecode');
		// JVM has hasOwnContent — not auto-completed
		expect(progress).not.toContain('JVM');
	});
});

// ── toggleHeadingProgress ─────────────────────────────────────

describe('toggleHeadingProgress', () => {
	// ── Basic leaf toggle ──

	test('toggling a leaf child on', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Work habits');
		expect(progress).toContain('Work habits');
		expect(progress).not.toContain('Personality');
	});

	test('toggling a leaf child off', () => {
		const progress = ['Work habits'];
		toggleHeadingProgress(HEADINGS, progress, 'Work habits');
		expect(progress).not.toContain('Work habits');
	});

	test('toggling last child auto-completes parent', () => {
		const progress = ['Work habits', 'Mathematical range', 'Preferred problem-solving techniques'];
		toggleHeadingProgress(HEADINGS, progress, 'Lecture style');
		expect(progress).toContain('Lecture style');
		expect(progress).toContain('Personality');
	});

	test('toggling a child off removes parent', () => {
		const progress = ['Work habits', 'Mathematical range', 'Preferred problem-solving techniques', 'Lecture style', 'Personality'];
		toggleHeadingProgress(HEADINGS, progress, 'Work habits');
		expect(progress).not.toContain('Work habits');
		expect(progress).not.toContain('Personality');
	});

	test('toggling childless h2 works as a simple toggle', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Legacy');
		expect(progress).toContain('Legacy');

		toggleHeadingProgress(HEADINGS, progress, 'Legacy');
		expect(progress).not.toContain('Legacy');
	});

	// ── Pure parent cascade ──

	test('toggling parent on checks all descendants', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Personality');
		expect(progress).toContain('Work habits');
		expect(progress).toContain('Mathematical range');
		expect(progress).toContain('Preferred problem-solving techniques');
		expect(progress).toContain('Lecture style');
		expect(progress).toContain('Personality');
	});

	test('toggling parent off unchecks all descendants', () => {
		const progress = ['Work habits', 'Mathematical range', 'Preferred problem-solving techniques', 'Lecture style', 'Personality'];
		toggleHeadingProgress(HEADINGS, progress, 'Personality');
		expect(progress).not.toContain('Work habits');
		expect(progress).not.toContain('Personality');
	});

	test('toggling parent off leaves other sections untouched', () => {
		const progress = ['Work habits', 'Mathematical range', 'Preferred problem-solving techniques', 'Lecture style', 'Personality', 'Early work'];
		toggleHeadingProgress(HEADINGS, progress, 'Personality');
		expect(progress).toContain('Early work');
		expect(progress).not.toContain('Work habits');
	});

	test('partial children + toggle parent on fills remaining', () => {
		const progress = ['Work habits', 'Mathematical range'];
		toggleHeadingProgress(HEADINGS, progress, 'Personality');
		expect(progress).toContain('Preferred problem-solving techniques');
		expect(progress).toContain('Lecture style');
		expect(progress).toContain('Personality');
	});

	test('whitespace-normalized heading matches', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Work  habits');
		expect(progress.some(p => normaliseHeading(p) === 'Work habits')).toBe(true);
	});

	// ── Deep hierarchy ──

	test('toggling h2 checks entire subtree (h3s and h4s)', () => {
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'The Boys Series');
		expect(progress).toContain('Background');
		expect(progress).toContain('Childhood');
		expect(progress).toContain('Hero Career');
		expect(progress).toContain('Season 1');
		expect(progress).toContain('Season 2');
		expect(progress).toContain('Lamplighter takes a stand');
		expect(progress).toContain('The Boys Series');
	});

	test('toggling h3 checks its h4 children', () => {
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Background');
		expect(progress).toContain('Childhood');
		expect(progress).toContain('Hero Career');
		expect(progress).toContain('Background');
		expect(progress).not.toContain('The Boys Series');
	});

	test('completing all h3 subtrees auto-completes h2', () => {
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Background');
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Season 1');
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Season 2');
		expect(progress).toContain('The Boys Series');
	});

	test('toggling h4 leaf recomputes h3 parent', () => {
		const progress = ['Childhood'];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Hero Career');
		expect(progress).toContain('Background');
	});

	test('unchecking one h4 removes h3 and h2', () => {
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'The Boys Series');
		expect(progress).toContain('The Boys Series');

		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Childhood');
		expect(progress).not.toContain('Childhood');
		expect(progress).not.toContain('Background');
		expect(progress).not.toContain('The Boys Series');
	});

	// ── Level gap ──

	test('clicking parent when all descendants already checked works', () => {
		const progress = ['Further defining fiber'];
		toggleHeadingProgress(GAP_HEADINGS, progress, 'Types of Fiber');
		expect(progress).toContain('Types of Fiber');
		expect(progress).toContain('Further defining fiber');
	});

	test('clicking parent unchecks entire subtree', () => {
		const progress = ['Types of Fiber', 'Further defining fiber'];
		toggleHeadingProgress(GAP_HEADINGS, progress, 'Types of Fiber');
		expect(progress).not.toContain('Types of Fiber');
		expect(progress).not.toContain('Further defining fiber');
	});

	test('toggling h2 checks h4 descendant despite gap', () => {
		const progress: string[] = [];
		toggleHeadingProgress(GAP_HEADINGS, progress, 'Fiber and Disease');
		expect(progress).toContain('Should I avoid nuts and seeds?');
		expect(progress).toContain('Fiber and Disease');
	});

	test('toggling h4 leaf auto-completes h2 parent despite gap', () => {
		const progress: string[] = [];
		toggleHeadingProgress(GAP_HEADINGS, progress, 'Should I avoid nuts and seeds?');
		expect(progress).toContain('Fiber and Disease');
	});

	test('unchecking h2 removes h4 despite gap', () => {
		const progress: string[] = [];
		toggleHeadingProgress(GAP_HEADINGS, progress, 'Fiber and Disease');
		toggleHeadingProgress(GAP_HEADINGS, progress, 'Fiber and Disease');
		expect(progress).not.toContain('Fiber and Disease');
		expect(progress).not.toContain('Should I avoid nuts and seeds?');
	});

	// ── hasOwnContent ──

	test('toggling parent with hasOwnContent does NOT cascade to children', () => {
		const progress: string[] = [];
		toggleHeadingProgress(OWN_CONTENT_HEADINGS, progress, 'Types of Fiber');
		expect(progress).toContain('Types of Fiber');
		expect(progress).not.toContain('Soluble fiber');
		expect(progress).not.toContain('Insoluble fiber');
	});

	test('unchecking parent with hasOwnContent does NOT remove children', () => {
		const progress = ['Types of Fiber', 'Soluble fiber'];
		toggleHeadingProgress(OWN_CONTENT_HEADINGS, progress, 'Types of Fiber');
		expect(progress).not.toContain('Types of Fiber');
		expect(progress).toContain('Soluble fiber');
	});

	test('toggling children does not affect hasOwnContent parent', () => {
		const progress = ['Types of Fiber'];
		toggleHeadingProgress(OWN_CONTENT_HEADINGS, progress, 'Soluble fiber');
		toggleHeadingProgress(OWN_CONTENT_HEADINGS, progress, 'Insoluble fiber');
		expect(progress).toContain('Soluble fiber');
		expect(progress).toContain('Insoluble fiber');
		expect(progress).toContain('Types of Fiber'); // stays — not auto-derived
	});

	test('parent without hasOwnContent still auto-derives', () => {
		const progress: string[] = [];
		toggleHeadingProgress(OWN_CONTENT_HEADINGS, progress, 'Benefits');
		expect(progress).toContain('Benefits');
	});

	// ── Mixed hasOwnContent and pure parents ──

	test('mixed: hasOwnContent parent toggles independently', () => {
		const progress: string[] = [];
		toggleHeadingProgress(MIXED_HEADINGS, progress, 'Overview');
		expect(progress).toContain('Overview');
		expect(progress).not.toContain('History');
		expect(progress).not.toContain('Modern era');
	});

	test('mixed: pure parent cascades to children', () => {
		const progress: string[] = [];
		toggleHeadingProgress(MIXED_HEADINGS, progress, 'Technical details');
		expect(progress).toContain('Technical details');
		expect(progress).toContain('Architecture');
		expect(progress).toContain('Implementation');
	});

	test('mixed: completing children of pure parent auto-completes it', () => {
		const progress: string[] = [];
		toggleHeadingProgress(MIXED_HEADINGS, progress, 'Architecture');
		toggleHeadingProgress(MIXED_HEADINGS, progress, 'Implementation');
		expect(progress).toContain('Technical details');
	});

	test('mixed: completing children of hasOwnContent parent does NOT auto-complete it', () => {
		const progress: string[] = [];
		toggleHeadingProgress(MIXED_HEADINGS, progress, 'History');
		toggleHeadingProgress(MIXED_HEADINGS, progress, 'Modern era');
		expect(progress).not.toContain('Overview');
	});

	// ── Deep hasOwnContent ──

	test('deep: hasOwnContent at h2 and h3 both toggle independently', () => {
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_OWN_CONTENT, progress, 'JVM');
		expect(progress).toEqual(['JVM']);

		toggleHeadingProgress(DEEP_OWN_CONTENT, progress, 'Bytecode');
		expect(progress).toContain('JVM');
		expect(progress).toContain('Bytecode');
		expect(progress).not.toContain('Verification');
	});

	test('deep: completing h4 leaves under hasOwnContent h3 does not auto-complete h3', () => {
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_OWN_CONTENT, progress, 'Verification');
		toggleHeadingProgress(DEEP_OWN_CONTENT, progress, 'Execution');
		expect(progress).toContain('Verification');
		expect(progress).toContain('Execution');
		expect(progress).not.toContain('Bytecode'); // hasOwnContent
		expect(progress).not.toContain('JVM');       // hasOwnContent
	});

	// ── Edge cases ──

	test('toggling unknown heading is a no-op with recompute', () => {
		const progress = ['Work habits'];
		toggleHeadingProgress(HEADINGS, progress, 'Nonexistent heading');
		// The unknown heading gets added as a leaf toggle
		expect(progress).toContain('Nonexistent heading');
		// Existing progress unchanged
		expect(progress).toContain('Work habits');
	});

	test('toggling with empty heading list', () => {
		const progress: string[] = [];
		toggleHeadingProgress([], progress, 'Something');
		expect(progress).toContain('Something');
	});

	test('double toggle returns to original state', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Legacy');
		toggleHeadingProgress(HEADINGS, progress, 'Legacy');
		expect(progress).toEqual([]);
	});

	test('double toggle on parent returns to original state', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Personality');
		const afterCheck = [...progress];
		expect(afterCheck.length).toBeGreaterThan(0);

		toggleHeadingProgress(HEADINGS, progress, 'Personality');
		expect(progress).toEqual([]);
	});

	test('completing all sections in flat structure', () => {
		const progress: string[] = [];
		toggleHeadingProgress(FLAT_HEADINGS, progress, 'Section A');
		toggleHeadingProgress(FLAT_HEADINGS, progress, 'Section B');
		toggleHeadingProgress(FLAT_HEADINGS, progress, 'Section C');
		expect(progress).toContain('Section A');
		expect(progress).toContain('Section B');
		expect(progress).toContain('Section C');
	});

	test('no duplicate entries after multiple toggles', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Personality');
		// All children + parent should be added once
		const counts = new Map<string, number>();
		for (const p of progress) {
			const n = normaliseHeading(p);
			counts.set(n, (counts.get(n) || 0) + 1);
		}
		for (const [, count] of counts) {
			expect(count).toBe(1);
		}
	});

	test('progress array is mutated in-place', () => {
		const progress: string[] = [];
		const returned = toggleHeadingProgress(HEADINGS, progress, 'Legacy');
		expect(returned).toBe(progress);
		expect(progress).toContain('Legacy');
	});
});

// ── Introduction level matching ──────────────────────────────
// Tests for the fix: synthetic intro should match the first heading level,
// not always be h2. This prevents intro from becoming an accidental parent.

describe('intro section as sibling (level matching)', () => {
	// Simulates the reader.ts fix: intro takes the level of the first heading
	function addIntro(headings: HeadingInfo[]): HeadingInfo[] {
		const introLevel = headings.length > 0 ? headings[0].level : 2;
		return [{ text: 'Introduction', level: introLevel }, ...headings];
	}

	test('intro matches h4 when all headings are h4', () => {
		const headings: HeadingInfo[] = [
			{ text: 'Exercise 1', level: 4 },
			{ text: 'Exercise 2', level: 4 },
			{ text: 'Exercise 3', level: 4 },
		];
		const withIntro = addIntro(headings);
		expect(withIntro[0].level).toBe(4);
		// Intro should be a sibling, not a parent — no children in hierarchy
		const hierarchy = buildHierarchy(withIntro);
		const introChildren = hierarchy.get('Introduction');
		expect(introChildren).toEqual([]);
	});

	test('intro matches h2 when first heading is h2', () => {
		const withIntro = addIntro(HEADINGS);
		expect(withIntro[0].level).toBe(2);
		// Intro is a sibling of other h2 sections — no children
		const hierarchy = buildHierarchy(withIntro);
		const introChildren = hierarchy.get('Introduction');
		expect(introChildren).toEqual([]);
	});

	test('intro defaults to h2 when no headings exist', () => {
		const withIntro = addIntro([]);
		expect(withIntro[0].level).toBe(2);
	});

	test('intro matches h3 for h3-only pages', () => {
		const headings: HeadingInfo[] = [
			{ text: 'Part A', level: 3 },
			{ text: 'Part B', level: 3 },
		];
		const withIntro = addIntro(headings);
		expect(withIntro[0].level).toBe(3);
		const hierarchy = buildHierarchy(withIntro);
		// All three should be top-level with no children
		expect(hierarchy.get('Introduction')).toEqual([]);
		expect(hierarchy.get('Part A')).toEqual([]);
		expect(hierarchy.get('Part B')).toEqual([]);
	});

	test('old behavior (h2) would make intro parent of h3 headings', () => {
		const headings: HeadingInfo[] = [
			{ text: 'Chapter 1', level: 3 },
			{ text: 'Chapter 2', level: 3 },
		];
		// Simulate old behavior: always h2
		const oldIntro: HeadingInfo[] = [{ text: 'Introduction', level: 2 }, ...headings];
		const hierarchy = buildHierarchy(oldIntro);
		// Old behavior: intro at h2 is parent of h3 children
		expect(hierarchy.get('Introduction')).toEqual(['Chapter 1', 'Chapter 2']);

		// New behavior: intro matches first heading level → all siblings
		const newIntro = addIntro(headings);
		const newHierarchy = buildHierarchy(newIntro);
		expect(newHierarchy.get('Introduction')).toEqual([]);
	});

	test('recomputeParentProgress works with level-matched intro', () => {
		const headings: HeadingInfo[] = [
			{ text: 'Exercise 1', level: 4 },
			{ text: 'Exercise 2', level: 4 },
			{ text: 'Exercise 3', level: 4 },
		];
		const withIntro = addIntro(headings);
		const progress = ['Exercise 1', 'Exercise 2', 'Exercise 3'];
		recomputeParentProgress(withIntro, progress);
		// Intro is a sibling, not a parent — it should NOT auto-complete
		expect(progress).not.toContain('Introduction');
	});
});
