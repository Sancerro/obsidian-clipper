import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './test-fixture';
import type { Page, BrowserContext } from '@playwright/test';

// Regression tests for the highlight rendering + merge fixes on 2026-04-11.
// Every test hits the real extension in a real Chromium against the real
// plugin — no mocks, no JSDOM. The scenarios below each map 1:1 to a bug we
// fixed; the comments above each test describe the bug so a future failure
// is immediately actionable.

const POLL_OPTS = { intervals: [10, 10, 20, 30, 50, 100], timeout: 3000 };

// ── Per-test hygiene ─────────────────────────────────────
// Clear highlight state on the test URL + extension storage before and
// after every case, same pattern as sync.spec.ts.

async function clearExtensionStorage(context: BrowserContext): Promise<void> {
	const [sw] = context.serviceWorkers();
	if (!sw) return;
	await sw.evaluate(async () => {
		const api = (globalThis as any).chrome;
		await api.storage.local.remove([
			'readerHighlights',
			'highlights',
			'readerPendingRemoteRemovals',
		]);
	});
}

test.beforeEach(async ({ realPlugin, articleUrl, context }) => {
	await realPlugin.clearHighlightsForUrl(articleUrl);
	await clearExtensionStorage(context);
	await context.unrouteAll();
});

test.afterEach(async ({ realPlugin, articleUrl, context }) => {
	await realPlugin.clearHighlightsForUrl(articleUrl);
	await clearExtensionStorage(context);
	await context.unrouteAll();
});

// ── Helpers (mirror of sync.spec.ts — kept local so this file is self-contained) ──

async function enterHighlighterMode(page: Page): Promise<void> {
	await page.focus('body');
	await page.keyboard.press('h');
	await page.waitForFunction(
		() => document.body.classList.contains('obsidian-highlighter-active'),
		{ timeout: 5000 }
	);
}

async function programmaticSelectAndRelease(
	page: Page,
	selector: string,
	text: string
): Promise<void> {
	await page.evaluate(
		({ selector, text }) => {
			const root = document.querySelector(selector) as HTMLElement | null;
			if (!root) throw new Error(`root ${selector} not found`);
			const full = root.textContent || '';
			const startIdx = full.indexOf(text);
			if (startIdx === -1) throw new Error(`text "${text}" not found in ${selector}`);
			const endIdx = startIdx + text.length;

			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let accum = 0;
			let startNode: Text | null = null;
			let startOffset = 0;
			let endNode: Text | null = null;
			let endOffset = 0;
			let node: Node | null;
			while ((node = walker.nextNode())) {
				const t = node as Text;
				const len = t.data.length;
				if (!startNode && accum + len > startIdx) {
					startNode = t;
					startOffset = startIdx - accum;
				}
				if (accum + len >= endIdx) {
					endNode = t;
					endOffset = endIdx - accum;
					break;
				}
				accum += len;
			}
			if (!startNode || !endNode) throw new Error('could not find range bounds');

			const range = document.createRange();
			range.setStart(startNode, startOffset);
			range.setEnd(endNode, endOffset);
			const sel = window.getSelection();
			if (!sel) throw new Error('no selection');
			sel.removeAllRanges();
			sel.addRange(range);

			document.dispatchEvent(
				new MouseEvent('mouseup', { bubbles: true, cancelable: true })
			);
		},
		{ selector, text }
	);
}

/**
 * Select the given substring inside `rootSelector`, then invoke the clipper's
 * highlight flow via the extension's `highlightSelection` runtime message —
 * which, unlike a synthetic `document.dispatchEvent(mouseup)`, always reaches
 * the content script's isolated-world handler synchronously and calls
 * `handleTextSelection(window.getSelection())` directly.
 *
 * Why: synthetic `MouseEvent('mouseup')` dispatched from a `page.evaluate`
 * main-world context doesn't reliably propagate to content-script listeners
 * in the isolated world for every selection shape — the merge-from-right
 * scenario was getting silently dropped on the floor, even though the
 * capture-phase listener in the main world saw the event. The message path
 * is what `content.ts:405-412` exposes explicitly for programmatic triggers.
 */
async function selectAndTriggerHighlight(
	page: Page,
	selector: string,
	text: string
): Promise<void> {
	// Step 1: set the Selection in the main world (Selection is shared across
	// worlds because it's bound to the document).
	await page.evaluate(
		({ selector, text }) => {
			const root = document.querySelector(selector) as HTMLElement | null;
			if (!root) throw new Error(`root ${selector} not found`);
			const full = root.textContent || '';
			const startIdx = full.indexOf(text);
			if (startIdx === -1) throw new Error(`text "${text}" not found in ${selector}`);
			const endIdx = startIdx + text.length;

			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let accum = 0;
			let startNode: Text | null = null;
			let startOffset = 0;
			let endNode: Text | null = null;
			let endOffset = 0;
			let node: Node | null;
			while ((node = walker.nextNode())) {
				const t = node as Text;
				const len = t.data.length;
				if (!startNode && accum + len > startIdx) {
					startNode = t;
					startOffset = startIdx - accum;
				}
				if (accum + len >= endIdx) {
					endNode = t;
					endOffset = endIdx - accum;
					break;
				}
				accum += len;
			}
			if (!startNode || !endNode) throw new Error('could not find range bounds');

			const range = document.createRange();
			range.setStart(startNode, startOffset);
			range.setEnd(endNode, endOffset);
			const sel = window.getSelection();
			if (!sel) throw new Error('no selection');
			sel.removeAllRanges();
			sel.addRange(range);
		},
		{ selector, text }
	);

	// Step 2: ask the extension to run the highlight flow against the current
	// selection. The content script's `highlightSelection` handler reads
	// `window.getSelection()` directly and calls `handleTextSelection`, which
	// is the exact same entry point as `handleMouseUp` would use.
	const ctx = page.context();
	const [sw] = ctx.serviceWorkers();
	if (!sw) throw new Error('no service worker — extension not loaded?');
	const tabId = await sw.evaluate(async () => {
		const tabs = await (globalThis as any).chrome.tabs.query({
			active: true, currentWindow: true,
		});
		return tabs[0]?.id ?? null;
	});
	if (tabId == null) throw new Error('no active tab');
	await sw.evaluate(async (id) => {
		await (globalThis as any).chrome.tabs.sendMessage(id, {
			action: 'highlightSelection',
			isActive: true,
		});
	}, tabId);
}

async function waitForMarkContaining(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		(t) => {
			const marks = document.querySelectorAll('.reading-selection-highlight-mark');
			for (let i = 0; i < marks.length; i++) {
				if ((marks[i].textContent ?? '').includes(t)) return true;
			}
			return false;
		},
		text,
		{ timeout: 3000 }
	);
}

// ── Inline element coalescing (code, strong) ─────────────
//
// Bug: on the original page (not reader mode), `wrapRangeInMarks` used to
// run a "safe" coalescing pass that only merged adjacent mark spans and
// whitespace, NOT inline elements. That meant a selection crossing
// `<code>` or `<strong>` rendered as three separate rounded marks with
// a visible gap on either side of the inline element's padding/border.
//
// Fix: removed the `isReaderMode` guard on the inline-absorb coalescing
// rule in `src/utils/reader-highlights.ts`, so full coalescing runs on
// both modes. The absorbed inline element becomes a child of the mark
// span (legal HTML — all INLINE_TAGS are phrasing content).

test('coalesce: selection across <code> produces one continuous mark', async ({
	page, articleUrl,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	// "result of 2.0 * 0.5 is" spans: text, <code>2.0 * 0.5</code>, text.
	// Before the fix: 3 separate marks. After the fix: 1 mark that contains
	// the <code> as a descendant.
	await programmaticSelectAndRelease(page, '#p5', 'result of 2.0 * 0.5 is');
	await waitForMarkContaining(page, 'result of');

	const result = await page.evaluate(() => {
		const marks = document.querySelectorAll('.reading-selection-highlight-mark');
		return {
			markCount: marks.length,
			firstMarkText: marks[0]?.textContent ?? null,
			firstMarkContainsCode: !!marks[0]?.querySelector('code#test-code'),
			codeStillExists: !!document.getElementById('test-code'),
		};
	});

	expect(result.markCount).toBe(1);
	// Word-boundary expansion may tack on trailing punctuation, so assert containment.
	expect(result.firstMarkText).toContain('result of 2.0 * 0.5 is');
	expect(result.firstMarkContainsCode).toBe(true);
	// The <code> element itself must survive intact (only its parent changed).
	expect(result.codeStillExists).toBe(true);
});

test('coalesce: selection across <strong> produces one continuous mark', async ({
	page, articleUrl,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	// "is lossy compression." spans: text, <strong>lossy compression</strong>, text.
	await programmaticSelectAndRelease(page, '#p5', 'is lossy compression.');
	await waitForMarkContaining(page, 'lossy compression');

	const result = await page.evaluate(() => {
		const marks = document.querySelectorAll('.reading-selection-highlight-mark');
		return {
			markCount: marks.length,
			firstMarkText: marks[0]?.textContent ?? null,
			firstMarkContainsStrong: !!marks[0]?.querySelector('strong#test-strong'),
			strongStillExists: !!document.getElementById('test-strong'),
		};
	});

	expect(result.markCount).toBe(1);
	expect(result.firstMarkText).toContain('is lossy compression');
	expect(result.firstMarkContainsStrong).toBe(true);
	expect(result.strongStillExists).toBe(true);
});

// ── Overlap-from-left merge (the bug the user just hit) ──
//
// Bug: `handleReaderModeHighlight`'s merge branch expanded the new range
// to cover overlapping marks via `markRange.selectNodeContents(mark)`,
// which anchors the expanded boundaries on the mark ELEMENT itself
// (e.g. `(mark, 0)`). Immediately afterwards the mark was unwrapped via
// `replaceWith(...childNodes)`, which removed the mark from the DOM.
// At that instant the range's start/end containers became detached
// nodes — `getRangeCleanText` returned empty, `wrapRangeInMarks` wrapped
// nothing, and the net result was "old highlight deleted, no new
// highlight created". User-visible symptom: dragging to extend an
// existing highlight from the left (or right) just deleted it.
//
// Fix: anchor expansion boundaries on the mark's FIRST and LAST
// text-node descendants. Text nodes get reparented into the mark's
// former parent during `replaceWith` and remain valid after the unwrap.

test('merge from left: new selection starting inside an existing highlight extends it', async ({
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	// Step 1: create an existing highlight on "exquisite opal jewels".
	await selectAndTriggerHighlight(page, '#p3', 'exquisite opal jewels');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(1);

	const beforeIds = await page.evaluate(() => Array.from(
		document.querySelectorAll('.reading-selection-highlight-mark')
	).map(m => ({
		id: (m as HTMLElement).dataset.highlightId,
		text: m.textContent,
	})));
	expect(beforeIds).toHaveLength(1);
	const oldId = beforeIds[0].id;

	// Step 2: new selection that STARTS INSIDE the existing mark
	// ("opal jewels") and extends to the right past it. Before the fix
	// this deleted the "exquisite opal jewels" mark without replacement.
	// After the fix the two should merge into one covering the union.
	await selectAndTriggerHighlight(page, '#p3', 'opal jewels. A mad boxer');

	// Wait for the DOM to settle on a mark that contains both halves of
	// the union — handleReaderModeHighlight mutates the DOM synchronously
	// during the mouseup handler, but plugin reconciliation is async so
	// we poll for steady state rather than asserting immediately.
	await page.waitForFunction(
		() => {
			const marks = document.querySelectorAll('.reading-selection-highlight-mark');
			if (marks.length === 0) return false;
			const text = Array.from(marks).map(m => m.textContent).join('');
			return text.includes('exquisite') && text.includes('mad boxer');
		},
		{ timeout: 3000 }
	);

	// DOM invariants after merge: exactly one unique highlight id, with
	// text covering the union. Zero marks = the "deletion" failure mode;
	// two distinct ids = non-merging failure mode.
	const afterState = await page.evaluate(() => {
		const marks = document.querySelectorAll('.reading-selection-highlight-mark');
		const ids = Array.from(marks).map(m => (m as HTMLElement).dataset.highlightId);
		return {
			markCount: marks.length,
			uniqueHighlightIds: new Set(ids).size,
			concatenatedText: Array.from(marks).map(m => m.textContent).join(''),
		};
	});
	expect(afterState.markCount).toBeGreaterThan(0);
	expect(afterState.uniqueHighlightIds).toBe(1);
	expect(afterState.concatenatedText).toContain('exquisite');
	expect(afterState.concatenatedText).toContain('mad boxer');

	// Plugin state: exactly one highlight whose text covers the union.
	await expect.poll(
		async () => {
			const highlights = await realPlugin.getHighlights(articleUrl);
			if (highlights.length !== 1) return false;
			const t = highlights[0].exactText;
			return t.includes('exquisite') && t.includes('opal jewels') && t.includes('mad boxer');
		},
		POLL_OPTS
	).toBe(true);

	// And the remaining highlight should NOT be the old one — the merge
	// replaces the old ID with a new one.
	const finalHighlights = await realPlugin.getHighlights(articleUrl);
	expect(finalHighlights.map(h => h.id)).not.toContain(oldId);
});

test('merge from right: new selection ending inside an existing highlight extends it', async ({
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	// Step 1: existing highlight on "mad boxer shot a quick".
	await selectAndTriggerHighlight(page, '#p3', 'mad boxer shot a quick');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(1);

	// Step 2: new selection that ENDS INSIDE the existing mark. Symmetric
	// to the left case — same underlying boundary-expansion bug would
	// detach range.end instead of range.start.
	await selectAndTriggerHighlight(page, '#p3', 'jewels. A mad boxer shot');

	// Verify the DOM state first — the union should be represented as a
	// single merged highlight.
	await page.waitForFunction(
		() => {
			const marks = document.querySelectorAll('.reading-selection-highlight-mark');
			if (marks.length === 0) return false;
			const text = Array.from(marks).map(m => m.textContent).join('');
			return text.includes('jewels') && text.includes('mad boxer') && text.includes('quick');
		},
		{ timeout: 3000 }
	);
	const domState = await page.evaluate(() => {
		const marks = document.querySelectorAll('.reading-selection-highlight-mark');
		const uniqueIds = new Set(
			Array.from(marks).map(m => (m as HTMLElement).dataset.highlightId)
		);
		return {
			markCount: marks.length,
			uniqueHighlightIds: uniqueIds.size,
			firstMarkText: marks[0]?.textContent ?? null,
		};
	});
	expect(domState.markCount).toBeGreaterThan(0);
	expect(domState.uniqueHighlightIds).toBe(1);
	expect(domState.firstMarkText).toContain('jewels');
	expect(domState.firstMarkText).toContain('quick');

	// Then verify the plugin ends up with exactly one highlight covering
	// the same union. This is a separate assertion from the DOM check
	// because the plugin POSTs are fire-and-forget from the content
	// script, and reconciliation timing is distinct from local state.
	await expect.poll(
		async () => {
			const highlights = await realPlugin.getHighlights(articleUrl);
			if (highlights.length !== 1) return false;
			const t = highlights[0].exactText;
			return t.includes('jewels') && t.includes('mad boxer') && t.includes('quick');
		},
		POLL_OPTS
	).toBe(true);
});

// ── Drag-preview CSS: ::selection rules load and are sane ──
//
// Bug 1 (drag-preview color): the old overlay-div preview painted its
// yellow ON TOP of the text (z-index above glyphs), which over-tinted
// bold/colored text. Fixed by moving the preview to `::selection` so
// the browser paints yellow BEHIND the glyphs, same compositing as the
// applied mark's `background`.
//
// Bug 2 (bolded text double-dip): the first version of the `::selection`
// fix also set `text-decoration: underline 0.1em ...`. That caused a
// second underline to stack on nested inline elements during selection
// — the `<p>::selection` rule drew an underline that propagated through
// the child `<strong>`, and the `<strong>::selection` rule drew its own
// on top, producing a visibly thicker yellow band on the bold portion.
// Fixed by dropping `text-decoration` from the rule entirely.
//
// This test asserts the final state of both fixes by inspecting the
// loaded stylesheet rather than screenshotting the drag (screenshot
// diffs of native ::selection painting are noisy across platforms).

test('::selection rule: highlighter.css defines yellow bg with no text-decoration', () => {
	// The compiled dev/highlighter.css is what actually ships with the
	// extension. Parsing document.styleSheets from a Playwright page works
	// in theory but Chromium refuses cssRules access on content_scripts-
	// injected stylesheets (security check), so we go straight to the file.
	const cssPath = path.resolve(__dirname, '..', 'dev', 'highlighter.css');
	const css = fs.readFileSync(cssPath, 'utf8');

	// Grab the exact rule body for `body.obsidian-highlighter-active *::selection`.
	// Regex is intentionally tolerant to whitespace — the compiled output's
	// formatting depends on minification mode.
	const match = css.match(
		/body\.obsidian-highlighter-active\s+\*::selection\s*\{([^}]*)\}/
	);
	expect(
		match,
		'dev/highlighter.css must declare body.obsidian-highlighter-active *::selection'
	).not.toBeNull();

	const body = match![1];

	// Yellow bg — drag-preview must match the applied mark's rgba.
	expect(body, 'drag-preview ::selection must paint the mark yellow').toMatch(
		/background-color:\s*rgba\(255,\s*220,\s*50,\s*0?\.25\)/
	);

	// !important is load-bearing: reader.scss's `.obsidian-reader-active body
	// ::selection` has the same specificity (0,1,2) and is injected later via
	// chrome.scripting.insertCSS. Without !important, source-order gives the
	// reader theme's text-selection color precedence inside reader mode,
	// making the drag-preview show blue/grey instead of yellow.
	expect(
		body,
		'::selection background-color must use !important (reader.scss same-specificity cascade)'
	).toMatch(/background-color:\s*rgba\(255,\s*220,\s*50,\s*0?\.25\)\s*!important/);
	expect(
		body,
		'::selection color must use !important (reader.scss same-specificity cascade)'
	).toMatch(/color:\s*inherit\s*!important/);

	// No text-decoration — this is the regression guard for the bolded-text
	// double-dip bug. Setting text-decoration on a universal ::selection causes
	// the underline to stack on nested inline elements (e.g. <strong>).
	expect(
		body,
		'drag-preview ::selection must not set text-decoration (causes bolded-text double-dip)'
	).not.toMatch(/text-decoration/);
});

// ── Chrome manifest includes highlighter.css in content_scripts ──
//
// Bug: commit 0549f33 "Improve highlight sync and error handling" (Apr 10)
// removed the `ensureHighlighterCSS()` lazy-loader function introduced by
// upstream `1b96adb "Lazy highlights (#768)"`, but didn't restore the
// static `"css": ["highlighter.css"]` entry that the upstream PR had
// removed in favor of the (now-gone) lazy loader. Net effect on Chrome
// and Safari: highlighter.css was never loaded on any content page,
// so .reading-selection-highlight-mark had no styles and marks rendered
// as plain invisible spans. Firefox was unaffected because manifest.firefox.json
// still had the static CSS entry.
//
// Fix: re-added `"css": ["highlighter.css"]` to `content_scripts[0]` of
// both manifest.chrome.json and manifest.safari.json, matching Firefox.
//
// This test guards against the static entry being accidentally removed
// again by reading the manifest files directly. Each file check is its
// own assertion so a failure is unambiguous.

test('manifest: chrome, firefox, and safari all load highlighter.css via content_scripts', () => {
	const manifests = [
		{ file: 'src/manifest.chrome.json', browser: 'chrome' },
		{ file: 'src/manifest.firefox.json', browser: 'firefox' },
		{ file: 'src/manifest.safari.json', browser: 'safari' },
	];

	for (const { file, browser } of manifests) {
		const manifestPath = path.resolve(__dirname, '..', file);
		const raw = fs.readFileSync(manifestPath, 'utf8');
		const manifest = JSON.parse(raw) as {
			content_scripts?: Array<{ js?: string[]; css?: string[] }>;
		};

		expect(
			manifest.content_scripts,
			`${browser} manifest must declare content_scripts`
		).toBeDefined();
		expect(
			manifest.content_scripts!.length,
			`${browser} manifest must have at least one content_scripts entry`
		).toBeGreaterThan(0);
		expect(
			manifest.content_scripts![0].css,
			`${browser} manifest content_scripts[0] must declare css (regression guard for missing highlighter.css)`
		).toContain('highlighter.css');
	}
});

// ── Loaded stylesheet check: highlighter.css is actually injected on a raw page ──
//
// Even if the manifest declares the CSS, we still want proof that Chrome
// actually injected it into the page at runtime. The manifest test above
// guards against the file-level regression; this one guards against a
// runtime regression where the manifest is right but something else
// (e.g. a future move back to lazy loading, a declarativeNetRequest
// rule, an invalid `matches` pattern) stops the CSS from reaching the
// page.

test('runtime: highlighter.css styles apply on a raw page load', async ({
	page, articleUrl,
}) => {
	await page.goto(articleUrl);

	// Inject a canary mark directly into the DOM and read back its computed
	// background-color. If highlighter.css is loaded the rule matches and we
	// get the yellow; if not, bg is rgba(0,0,0,0) or similar.
	const canaryBg = await page.evaluate(() => {
		const el = document.createElement('span');
		el.className = 'reading-selection-highlight-mark';
		el.textContent = 'canary';
		document.body.appendChild(el);
		const bg = window.getComputedStyle(el).backgroundColor;
		el.remove();
		return bg;
	});

	// Accept any non-transparent yellow variant. Browsers normalize
	// rgba to `rgba(r, g, b, a)` with one-space-after-comma, but computed
	// values can drift on different Chromium versions, so regex-match.
	expect(canaryBg).toMatch(/^rgba?\(255,\s*220,\s*50,\s*0?\.25\)$/);
});

// ── Midnight theme: both light and dark CSS variable sets defined ─────
//
// Bug: during the rebase tracked by branch `codex/pre-rebase-custom-20260410`,
// the midnight theme lost its parchment-light variant (commit `7dd38dc`) and
// was replaced with a dark-only rule (commit `5c39263`). The `d` key toggle
// in reader mode flipped the theme-light/theme-dark class correctly but had
// no effect because there were no light CSS variables — only the near-black
// dark set existed.
//
// Fix: restored the two-variant block. Light (parchment #f4f0e8) at the top,
// dark (#0d0d0d) inside `&.theme-dark, .theme-dark`. This test guards both
// variants by parsing the reader-themes SCSS directly.

test('midnight theme: both parchment-light and near-black-dark CSS variables defined', () => {
	const scssPath = path.resolve(__dirname, '..', 'src', 'styles', '_reader-themes.scss');
	const scss = fs.readFileSync(scssPath, 'utf8');

	// The midnight block should contain both the light bg and the dark bg.
	// Find the midnight theme block.
	const midnightStart = scss.indexOf('[data-reader-theme="midnight"]');
	expect(midnightStart, 'midnight theme block must exist in _reader-themes.scss').toBeGreaterThan(-1);

	// Extract from the start of midnight to the next theme block or end.
	const midnightBlock = scss.slice(midnightStart, midnightStart + 1200);

	// Light variant: parchment background
	expect(
		midnightBlock,
		'midnight must define parchment-light --background-primary: #f4f0e8'
	).toContain('--background-primary: #f4f0e8');

	// Light variant: warm stone text
	expect(
		midnightBlock,
		'midnight must define warm-stone-light --text-normal: #3a3226'
	).toContain('--text-normal: #3a3226');

	// Dark variant: near-black background inside .theme-dark
	expect(
		midnightBlock,
		'midnight must define near-black-dark --background-primary: #0d0d0d inside theme-dark'
	).toContain('--background-primary: #0d0d0d');

	// Dark variant: light grey text
	expect(
		midnightBlock,
		'midnight must define --text-normal: #d4d4d4 inside theme-dark'
	).toContain('--text-normal: #d4d4d4');

	// Must NOT have standalone `color-scheme: dark` (that was the revert's bug —
	// it forced dark color-scheme regardless of the class toggle).
	expect(
		midnightBlock,
		'midnight must not have standalone color-scheme: dark (breaks d-key toggle)'
	).not.toMatch(/^\s*color-scheme:\s*dark;/m);
});
