import { test, expect } from './test-fixture';
import type { Page, BrowserContext, Worker } from '@playwright/test';

const LATENCY_BUDGET_MS = 100;

/**
 * All six ordered pairs of highlight propagation between
 * Web page (W), Reader mode (R), and Obsidian (O — represented
 * by the fake plugin's state and SSE stream).
 *
 * Pages/fixtures are served over HTTP on :3100 so the
 * extension's content_scripts can inject. Every test uses the
 * same fixture URL, pre-registered as a linked note with the
 * fake plugin so reader mode pulls from /page?url=.
 */

const LINKED_NOTE = {
	notePath: 'Test/fixture-article.md',
	title: 'Fixture Article',
	// Minimal reader-mode body: matches the text nodes in the page fixture
	// so text-anchor highlights from the page survive into reader.
	content:
		'<article>' +
		'<h1>The fixture article</h1>' +
		'<p>The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump. Sphinx of black quartz, judge my vow.</p>' +
		'<p>Bright vixens jump; dozy fowl quack. The five boxing wizards jump quickly. Jackdaws love my big sphinx of quartz. Waltz, bad nymph, for quick jigs vex.</p>' +
		'<p>Crazy Fredrick bought many very exquisite opal jewels. A mad boxer shot a quick, gloved jab to the jaw of his dizzy opponent.</p>' +
		'<p>Read more about <a id="test-link" href="#link-target">linked foxes</a> at the end of this article.</p>' +
		'<p id="link-target">This is where the link points to.</p>' +
		'</article>',
};

// ── Helpers ──────────────────────────────────────────────

/**
 * Perform a real mouse drag across the given substring inside `selector`
 * but STOP BEFORE releasing. Call `releaseDrag(page)` to release. Split
 * this way so that latency tests can start their timer immediately before
 * the mouseup (which is when the highlighter content script does its work).
 */
async function dragSelect(page: Page, selector: string, text: string): Promise<void> {
	const box = await page.evaluate(
		({ selector, text }) => {
			const root = document.querySelector(selector);
			if (!root) return null;
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let node: Node | null;
			while ((node = walker.nextNode())) {
				const textContent = node.textContent ?? '';
				const idx = textContent.indexOf(text);
				if (idx === -1) continue;
				const r = document.createRange();
				r.setStart(node, idx);
				r.setEnd(node, idx + text.length);
				const rect = r.getBoundingClientRect();
				return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
			}
			return null;
		},
		{ selector, text }
	);
	if (!box) throw new Error(`text "${text}" not found inside ${selector}`);

	const cy = box.y + box.h / 2;
	await page.mouse.move(box.x + 1, cy);
	await page.mouse.down();
	await page.mouse.move(box.x + box.w / 2, cy, { steps: 5 });
	await page.mouse.move(box.x + box.w - 1, cy, { steps: 5 });
}

async function releaseDrag(page: Page): Promise<void> {
	await page.mouse.up();
}

/**
 * Create a text selection that spans multiple text nodes (e.g. around a link),
 * then dispatch a `mouseup` event that the highlighter's content-script
 * listener will pick up. Use this for selections that `dragSelect` can't handle.
 */
async function programmaticSelectAndRelease(
	page: Page,
	selector: string,
	text: string
): Promise<void> {
	await page.evaluate(
		({ selector, text }) => {
			const root = document.querySelector(selector) as HTMLElement | null;
			if (!root) throw new Error(`root ${selector} not found`);
			const full = root.innerText;
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

			// Trigger the highlighter listener — it reads document.getSelection()
			// on mouseup and wraps it in marks.
			document.dispatchEvent(
				new MouseEvent('mouseup', { bubbles: true, cancelable: true })
			);
		},
		{ selector, text }
	);
}

async function enterHighlighterMode(page: Page): Promise<void> {
	// content.ts binds a plain 'h' keydown handler that toggles highlighter
	// (guarded: no modifiers, not in inputs, not in reader mode).
	await page.focus('body');
	await page.keyboard.press('h');
	await page.waitForFunction(
		() => document.body.classList.contains('obsidian-highlighter-active'),
		{ timeout: 5000 }
	);
}

async function getServiceWorker(context: BrowserContext): Promise<Worker> {
	const existing = context.serviceWorkers();
	if (existing.length > 0) return existing[0];
	return await context.waitForEvent('serviceworker', { timeout: 10_000 });
}

/**
 * Toggle reader mode in the given page by reaching into the extension's
 * service worker. Extension keyboard commands can't be reliably triggered
 * from `page.keyboard.press`, so we replicate what the `toggle_reader`
 * command handler in background.ts does: inject reader-script.js into the
 * target tab and send it a toggleReaderMode message.
 */
async function enterReaderMode(page: Page): Promise<void> {
	const ctx = page.context();
	const sw = await getServiceWorker(ctx);

	// Multiple tabs may share the same URL (W→R, R→W, etc.), so we can't find
	// the correct tab by URL alone. Bring the target page to front and query
	// the currently active tab instead.
	await page.bringToFront();
	const tabId = await sw.evaluate(async () => {
		const tabs = await (globalThis as any).chrome.tabs.query({ active: true, currentWindow: true });
		return tabs[0]?.id ?? null;
	});
	if (tabId == null) throw new Error(`no active tab found`);

	await sw.evaluate(async (id) => {
		const chromeApi = (globalThis as any).chrome;
		await chromeApi.scripting.executeScript({
			target: { tabId: id },
			files: ['reader-script.js'],
		});
		await chromeApi.tabs.sendMessage(id, { action: 'toggleReaderMode' });
	}, tabId);

	await page.waitForFunction(
		() => document.documentElement.classList.contains('obsidian-reader-active'),
		{ timeout: 10_000 }
	);
	await page.waitForSelector('article', { timeout: 5_000 });
}

async function waitForMarkWithText(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		(t) => {
			const marks = document.querySelectorAll('.reading-selection-highlight-mark');
			for (let i = 0; i < marks.length; i++) {
				if ((marks[i].textContent ?? '').includes(t)) return true;
			}
			return false;
		},
		text,
		{ timeout: LATENCY_BUDGET_MS + 2000 }
	);
}

// ── Shared setup ─────────────────────────────────────────

test.beforeEach(async ({ fakePlugin, articleUrl }) => {
	fakePlugin.registerNote(articleUrl, LINKED_NOTE);
});

// ── The 6 pairs ──────────────────────────────────────────

test('W → O: highlight in page view propagates to plugin', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	await dragSelect(page, '#p1', 'quick brown fox');
	const waiter = fakePlugin.waitForClipperAdd(articleUrl);

	const t0 = Date.now();
	await releaseDrag(page);
	const received = await waiter;
	const latency = Date.now() - t0;

	expect(received.exactText).toContain('quick brown fox');
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(1);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('W → R: highlight in page view appears in reader mode in another tab', async ({
	context,
	articleUrl,
	fakePlugin,
}) => {
	// Destination tab in reader mode, subscribed to SSE
	const readerTab = await context.newPage();
	await readerTab.goto(articleUrl);
	await enterReaderMode(readerTab);

	// Source tab in page mode
	const pageTab = await context.newPage();
	await pageTab.goto(articleUrl);
	await enterHighlighterMode(pageTab);

	// Prep the drag; measurement starts at release
	await dragSelect(pageTab, '#p2', 'boxing wizards');

	const t0 = Date.now();
	await releaseDrag(pageTab);
	// Wait for reader tab to visually show the mark
	await waitForMarkWithText(readerTab, 'boxing wizards');
	const latency = Date.now() - t0;
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(1);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('R → O: highlight in reader mode propagates to plugin', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	await page.goto(articleUrl);
	await enterReaderMode(page);
	await enterHighlighterMode(page);

	await dragSelect(page, 'article', 'opal jewels');
	const waiter = fakePlugin.waitForClipperAdd(articleUrl);

	const t0 = Date.now();
	await releaseDrag(page);
	const received = await waiter;
	const latency = Date.now() - t0;

	expect(received.exactText).toContain('opal jewels');
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(1);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('R → W: highlight in reader mode appears in page view in another tab', async ({
	context,
	articleUrl,
	fakePlugin,
}) => {
	const pageTab = await context.newPage();
	await pageTab.goto(articleUrl);
	// page tab starts in page mode, no highlighter

	const readerTab = await context.newPage();
	await readerTab.goto(articleUrl);
	await enterReaderMode(readerTab);
	await enterHighlighterMode(readerTab);

	await dragSelect(readerTab, 'article', 'Crazy Fredrick');

	const t0 = Date.now();
	await releaseDrag(readerTab);
	await waitForMarkWithText(pageTab, 'Crazy Fredrick');
	const latency = Date.now() - t0;
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(1);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('O → W: plugin-side highlight appears in page view via SSE', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	await page.goto(articleUrl);
	// Let the SSE subscription open (background establishes after first loadHighlights)
	await page.waitForFunction(
		() => (window as any).__highlightSyncReady !== false,
		{ timeout: 2000 }
	).catch(() => { /* no such flag; relying on natural settle */ });
	// Give the SSE handshake a moment
	await page.waitForTimeout(300);

	const t0 = Date.now();
	fakePlugin.injectHighlightFromObsidian(articleUrl, {
		id: 'obs-w-' + Date.now(),
		exactText: 'vexingly quick daft zebras',
		prefixText: 'How ',
		suffixText: ' jump',
	});
	await waitForMarkWithText(page, 'vexingly quick daft zebras');
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('O → R: plugin-side highlight appears in reader mode via SSE', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	await page.goto(articleUrl);
	await enterReaderMode(page);
	await page.waitForTimeout(300); // SSE handshake settle

	const t0 = Date.now();
	fakePlugin.injectHighlightFromObsidian(articleUrl, {
		id: 'obs-r-' + Date.now(),
		exactText: 'five boxing wizards',
		prefixText: 'The ',
		suffixText: ' jump',
	});
	await waitForMarkWithText(page, 'five boxing wizards');
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

// ── Clicking a link inside a highlight ────────────────────

/**
 * Regression guards: clicking a link inside a highlight must NOT delete the
 * highlight. The guard lives in `attachMarkClickHandler` at
 * src/utils/reader-highlights.ts (an `a[href]` early-return in the click
 * handler). Navigation behaviour differs by mode:
 *   - Page + highlighter mode: `disableLinkClicks()` forces preventDefault
 *     on all links so the user doesn't accidentally navigate away while
 *     highlighting. Highlight must still be preserved.
 *   - Reader mode: no disableLinkClicks call; navigation happens normally.
 */

test('page+highlighter mode: clicking a highlighted link keeps the highlight (navigation blocked)', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	const waiter = fakePlugin.waitForClipperAdd(articleUrl);
	await programmaticSelectAndRelease(page, '#p4', 'about linked foxes');
	await waiter;

	// Sanity: a mark exists somewhere under the link's text.
	const linkHasMark = await page.evaluate(() => {
		const link = document.getElementById('test-link');
		return !!link?.querySelector('.reading-selection-highlight-mark');
	});
	expect(linkHasMark).toBe(true);

	await page.click('#test-link');

	// Navigation blocked by disableLinkClicks → URL stays on the article.
	expect(page.url()).not.toContain('#link-target');

	const markStillThere = await page.evaluate(() =>
		!!document.querySelector('.reading-selection-highlight-mark')
	);
	expect(markStillThere).toBe(true);
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(1);
});

test('reader mode: clicking a highlighted link navigates and keeps the highlight', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	// Seed the highlight via the plugin so it's there when reader boots.
	fakePlugin.injectHighlightFromObsidian(articleUrl, {
		id: 'link-test-' + Date.now(),
		exactText: 'linked foxes',
		prefixText: 'about ',
		suffixText: ' at',
	});

	await page.goto(articleUrl);
	await enterReaderMode(page);
	await waitForMarkWithText(page, 'linked foxes');

	const linkHasMark = await page.evaluate(() => {
		const link = document.querySelector('article #test-link');
		return !!link?.querySelector('.reading-selection-highlight-mark');
	});
	expect(linkHasMark).toBe(true);

	await page.click('article #test-link');
	await expect(page).toHaveURL(/#link-target$/);

	const markStillThere = await page.evaluate(() =>
		!!document.querySelector('.reading-selection-highlight-mark')
	);
	expect(markStillThere).toBe(true);
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(1);
});

// ── Remove propagation (the 6 pairs, mirror of add) ──────

/**
 * Click an existing mark with the given id by dispatching a synthetic
 * MouseEvent via page.evaluate. Avoids the CDP round-trips that
 * `locator.click()` adds (scroll, stability, hover, mousedown, mouseup),
 * which otherwise blow the 100ms latency budget.
 *
 * Highlighter mode must be active on the source tab for page-mode tests so
 * the page-level click handler's `canRemove` returns true; reader mode's
 * handler has no such guard.
 */
async function clickMarkById(page: Page, highlightId: string): Promise<void> {
	await page.evaluate((id) => {
		const mark = document.querySelector(
			`.reading-selection-highlight-mark[data-highlight-id="${id}"]`
		);
		if (!mark) throw new Error(`mark ${id} not found`);
		mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	}, highlightId);
}

async function waitForMarkGone(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		(t) => {
			const marks = document.querySelectorAll('.reading-selection-highlight-mark');
			for (let i = 0; i < marks.length; i++) {
				if ((marks[i].textContent ?? '').includes(t)) return false;
			}
			return true;
		},
		text,
		{ timeout: LATENCY_BUDGET_MS + 2000 }
	);
}

test('W → O (remove): removing a highlight in page view propagates to plugin', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	const id = 'rm-wo-' + Date.now();
	fakePlugin.injectHighlightFromObsidian(articleUrl, {
		id,
		exactText: 'quick brown fox',
		prefixText: 'The ',
		suffixText: ' jumps',
	});

	await page.goto(articleUrl);
	await enterHighlighterMode(page);
	await waitForMarkWithText(page, 'quick brown fox');

	const waiter = fakePlugin.waitForClipperRemove(articleUrl);
	const t0 = Date.now();
	await clickMarkById(page, id);
	const removedId = await waiter;
	const latency = Date.now() - t0;

	expect(removedId).toBe(id);
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(0);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('W → R (remove): removing a highlight in page view disappears in reader mode', async ({
	context,
	articleUrl,
	fakePlugin,
}) => {
	const id = 'rm-wr-' + Date.now();
	fakePlugin.injectHighlightFromObsidian(articleUrl, {
		id,
		exactText: 'boxing wizards',
		prefixText: 'five ',
		suffixText: ' jump',
	});

	const readerTab = await context.newPage();
	await readerTab.goto(articleUrl);
	await enterReaderMode(readerTab);
	await waitForMarkWithText(readerTab, 'boxing wizards');

	const pageTab = await context.newPage();
	await pageTab.goto(articleUrl);
	await enterHighlighterMode(pageTab);
	await waitForMarkWithText(pageTab, 'boxing wizards');

	const t0 = Date.now();
	await clickMarkById(pageTab, id);
	await waitForMarkGone(readerTab, 'boxing wizards');
	const latency = Date.now() - t0;
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(0);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('R → O (remove): removing a highlight in reader mode propagates to plugin', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	const id = 'rm-ro-' + Date.now();
	fakePlugin.injectHighlightFromObsidian(articleUrl, {
		id,
		exactText: 'opal jewels',
		prefixText: 'exquisite ',
		suffixText: '.',
	});

	await page.goto(articleUrl);
	await enterReaderMode(page);
	await waitForMarkWithText(page, 'opal jewels');

	const waiter = fakePlugin.waitForClipperRemove(articleUrl);
	const t0 = Date.now();
	await clickMarkById(page, id);
	const removedId = await waiter;
	const latency = Date.now() - t0;

	expect(removedId).toBe(id);
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(0);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('R → W (remove): removing a highlight in reader mode disappears in page view', async ({
	context,
	articleUrl,
	fakePlugin,
}) => {
	const id = 'rm-rw-' + Date.now();
	fakePlugin.injectHighlightFromObsidian(articleUrl, {
		id,
		exactText: 'Crazy Fredrick',
		prefixText: '',
		suffixText: ' bought',
	});

	const pageTab = await context.newPage();
	await pageTab.goto(articleUrl);
	await waitForMarkWithText(pageTab, 'Crazy Fredrick');

	const readerTab = await context.newPage();
	await readerTab.goto(articleUrl);
	await enterReaderMode(readerTab);
	await waitForMarkWithText(readerTab, 'Crazy Fredrick');

	const t0 = Date.now();
	await clickMarkById(readerTab, id);
	await waitForMarkGone(pageTab, 'Crazy Fredrick');
	const latency = Date.now() - t0;
	expect(fakePlugin.getHighlights(articleUrl)).toHaveLength(0);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('O → W (remove): plugin-side removal disappears in page view via SSE', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	const id = 'rm-ow-' + Date.now();
	fakePlugin.injectHighlightFromObsidian(articleUrl, {
		id,
		exactText: 'vexingly quick daft zebras',
		prefixText: 'How ',
		suffixText: ' jump',
	});

	await page.goto(articleUrl);
	await waitForMarkWithText(page, 'vexingly quick daft zebras');
	await page.waitForTimeout(200); // SSE settle

	const t0 = Date.now();
	fakePlugin.removeHighlightFromObsidian(articleUrl, id);
	await waitForMarkGone(page, 'vexingly quick daft zebras');
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('O → R (remove): plugin-side removal disappears in reader mode via SSE', async ({
	page,
	articleUrl,
	fakePlugin,
}) => {
	const id = 'rm-or-' + Date.now();
	fakePlugin.injectHighlightFromObsidian(articleUrl, {
		id,
		exactText: 'five boxing wizards',
		prefixText: 'The ',
		suffixText: ' jump',
	});

	await page.goto(articleUrl);
	await enterReaderMode(page);
	await waitForMarkWithText(page, 'five boxing wizards');
	await page.waitForTimeout(200); // SSE settle

	const t0 = Date.now();
	fakePlugin.removeHighlightFromObsidian(articleUrl, id);
	await waitForMarkGone(page, 'five boxing wizards');
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});
