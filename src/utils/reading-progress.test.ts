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

describe('normaliseHeading', () => {
	test('trims and collapses whitespace', () => {
		expect(normaliseHeading('  hello   world  ')).toBe('hello world');
	});

	test('handles newlines and tabs', () => {
		expect(normaliseHeading('hello\n\tworld')).toBe('hello world');
	});
});

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
});

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
		// Season 1 has no h4 children
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
});

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
		// Lecture style missing
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
			'Childhood', 'Hero Career',          // all h4s under Background
			'Season 1',                           // leaf h3
			'Lamplighter takes a stand', 'Suicide in Vought Tower', 'Legacy', // all h4s under Season 2
		];
		recomputeParentProgress(DEEP_HEADINGS, progress);
		expect(progress).toContain('Background');  // h4s complete → h3 auto-completes
		expect(progress).toContain('Season 2');    // h4s complete → h3 auto-completes
		expect(progress).toContain('The Boys Series'); // all h3s complete → h2 auto-completes
	});

	test('incomplete h4 prevents h3 and h2 from auto-completing', () => {
		const progress = ['Childhood']; // Hero Career missing
		recomputeParentProgress(DEEP_HEADINGS, progress);
		expect(progress).not.toContain('Background');
		expect(progress).not.toContain('The Boys Series');
	});
});

describe('toggleHeadingProgress', () => {
	test('toggling a leaf child on', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Work habits');
		expect(progress).toContain('Work habits');
		expect(progress).not.toContain('Personality');
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
		expect(progress).not.toContain('Mathematical range');
		expect(progress).not.toContain('Preferred problem-solving techniques');
		expect(progress).not.toContain('Lecture style');
		expect(progress).not.toContain('Personality');
	});

	test('toggling parent off leaves other sections untouched', () => {
		const progress = ['Work habits', 'Mathematical range', 'Preferred problem-solving techniques', 'Lecture style', 'Personality', 'Early work'];
		toggleHeadingProgress(HEADINGS, progress, 'Personality');
		expect(progress).toContain('Early work');
		expect(progress).not.toContain('Work habits');
	});

	test('toggling childless h2 works as a simple toggle', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Legacy');
		expect(progress).toContain('Legacy');

		toggleHeadingProgress(HEADINGS, progress, 'Legacy');
		expect(progress).not.toContain('Legacy');
	});

	test('partial children + toggle parent on fills remaining', () => {
		const progress = ['Work habits', 'Mathematical range'];
		toggleHeadingProgress(HEADINGS, progress, 'Personality');
		expect(progress).toContain('Work habits');
		expect(progress).toContain('Mathematical range');
		expect(progress).toContain('Preferred problem-solving techniques');
		expect(progress).toContain('Lecture style');
		expect(progress).toContain('Personality');
	});

	test('whitespace-normalized heading matches', () => {
		const progress: string[] = [];
		toggleHeadingProgress(HEADINGS, progress, 'Work  habits');
		expect(progress.some(p => normaliseHeading(p) === 'Work habits')).toBe(true);
	});

	// Deep hierarchy tests
	test('toggling h2 checks entire subtree (h3s and h4s)', () => {
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'The Boys Series');
		expect(progress).toContain('Background');
		expect(progress).toContain('Childhood');
		expect(progress).toContain('Hero Career');
		expect(progress).toContain('Season 1');
		expect(progress).toContain('Season 2');
		expect(progress).toContain('Lamplighter takes a stand');
		expect(progress).toContain('Suicide in Vought Tower');
		expect(progress).toContain('Legacy');
		expect(progress).toContain('The Boys Series');
	});

	test('toggling h3 checks its h4 children', () => {
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Background');
		expect(progress).toContain('Childhood');
		expect(progress).toContain('Hero Career');
		expect(progress).toContain('Background');
		expect(progress).not.toContain('The Boys Series'); // other h3s not done
	});

	test('completing all h3 subtrees auto-completes h2', () => {
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Background'); // checks Childhood, Hero Career, Background
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Season 1');   // leaf h3
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Season 2');   // checks h4s + Season 2
		expect(progress).toContain('The Boys Series');
	});

	test('toggling h4 leaf recomputes h3 parent', () => {
		const progress = ['Childhood'];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Hero Career');
		expect(progress).toContain('Background'); // both h4s done
	});

	test('unchecking one h4 removes h3 and h2', () => {
		// Start fully completed
		const progress: string[] = [];
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'The Boys Series');
		expect(progress).toContain('The Boys Series');

		// Uncheck one h4
		toggleHeadingProgress(DEEP_HEADINGS, progress, 'Childhood');
		expect(progress).not.toContain('Childhood');
		expect(progress).not.toContain('Background');      // child missing
		expect(progress).not.toContain('The Boys Series'); // h3 missing
	});

	test('clicking parent when all descendants already checked works', () => {
		// Simulate: child was checked, parent wasn't auto-completed (e.g. loaded from storage)
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
});

// Parent headings with own content — independent checkboxes
const OWN_CONTENT_HEADINGS: HeadingInfo[] = [
	{ text: 'Types of Fiber', level: 2, hasOwnContent: true },
	{ text: 'Soluble fiber', level: 3 },
	{ text: 'Insoluble fiber', level: 3 },
	{ text: 'Benefits', level: 2 },
];

describe('hasOwnContent parents (independent checkboxes)', () => {
	test('recompute does NOT auto-complete parent with hasOwnContent', () => {
		const progress = ['Soluble fiber', 'Insoluble fiber'];
		recomputeParentProgress(OWN_CONTENT_HEADINGS, progress);
		expect(progress).not.toContain('Types of Fiber');
	});

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
		// Parent stays as-is (was already checked, not auto-derived)
		expect(progress).toContain('Types of Fiber');
	});

	test('parent without hasOwnContent still auto-derives', () => {
		// Benefits has no children and no hasOwnContent — works as leaf
		const progress: string[] = [];
		toggleHeadingProgress(OWN_CONTENT_HEADINGS, progress, 'Benefits');
		expect(progress).toContain('Benefits');
	});
});

describe('level-gap headings (h2 → h4)', () => {
	test('getDescendants finds h4 under h2 despite level gap', () => {
		const descendants = getDescendants(GAP_HEADINGS, 2); // Fiber and Disease
		expect(descendants).toContain('Should I avoid nuts and seeds?');
	});

	test('recompute auto-completes parent with level gap', () => {
		const progress = ['Should I avoid nuts and seeds?'];
		recomputeParentProgress(GAP_HEADINGS, progress);
		expect(progress).toContain('Fiber and Disease');
	});

	test('recompute removes parent when level-gap child is unchecked', () => {
		const progress = ['Fiber and Disease', 'Should I avoid nuts and seeds?'];
		// Remove the child
		progress.splice(progress.indexOf('Should I avoid nuts and seeds?'), 1);
		recomputeParentProgress(GAP_HEADINGS, progress);
		expect(progress).not.toContain('Fiber and Disease');
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
		expect(progress).toContain('Should I avoid nuts and seeds?');
		expect(progress).toContain('Fiber and Disease');
	});

	test('unchecking h2 removes h4 despite gap', () => {
		const progress: string[] = [];
		toggleHeadingProgress(GAP_HEADINGS, progress, 'Fiber and Disease');
		expect(progress).toContain('Fiber and Disease');

		toggleHeadingProgress(GAP_HEADINGS, progress, 'Fiber and Disease');
		expect(progress).not.toContain('Fiber and Disease');
		expect(progress).not.toContain('Should I avoid nuts and seeds?');
	});
});
