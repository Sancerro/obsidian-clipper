import { test, expect } from './test-fixture';
import type { Page, BrowserContext, Worker, Route } from '@playwright/test';
import type { Highlight } from './real-plugin';

// Budget for a single propagation cycle against the REAL plugin. Generous
// because the plugin writes highlight state to disk on every mutation, so
// sub-100ms (our original aim against the fake) isn't realistic.
const LATENCY_BUDGET_MS = 1500;
const POLL_OPTS = { intervals: [10, 10, 20, 30, 50, 100], timeout: 3000 };

/**
 * All six ordered pairs of highlight propagation between
 * Web page (W), Reader mode (R), and Obsidian (O — the real
 * reading-selection-highlight plugin), for both add and remove.
 *
 * Every test talks to the real plugin on :27124. No mocks. Setup creates
 * a linked note in the vault (E2E/e2e-test-fixture.md), teardown clears
 * every highlight on the test URL but leaves the note in place.
 */

// ── Helpers ──────────────────────────────────────────────

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

async function programmaticSelectAndRelease(
	page: Page,
	selector: string,
	text: string
): Promise<void> {
	await page.evaluate(
		({ selector, text }) => {
			const root = document.querySelector(selector) as HTMLElement | null;
			if (!root) throw new Error(`root ${selector} not found`);
			// textContent gives the raw concatenation of all descendant Text
			// node data, so global offsets we compute here match the walker's
			// per-node offsets exactly. innerText collapses whitespace and would
			// drift from node offsets whenever the HTML has leading indentation.
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

async function enterHighlighterMode(page: Page): Promise<void> {
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

async function enterReaderMode(page: Page): Promise<void> {
	const ctx = page.context();
	const sw = await getServiceWorker(ctx);

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
		{ timeout: 3000 }
	);
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
		{ timeout: 3000 }
	);
}

async function clickMarkById(page: Page, highlightId: string): Promise<void> {
	await page.evaluate((id) => {
		const mark = document.querySelector(
			`.reading-selection-highlight-mark[data-highlight-id="${id}"]`
		);
		if (!mark) throw new Error(`mark ${id} not found`);
		mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	}, highlightId);
}

/**
 * Poll the real plugin until some highlight on `url` contains `substring`.
 * Handles the clipper's word-boundary expansion including trailing
 * punctuation (e.g. "opal jewels" becomes "opal jewels." in the stored text).
 */
async function pollForHighlightText(
	realPlugin: { getHighlights: (u: string) => Promise<Highlight[]> },
	url: string,
	substring: string
): Promise<void> {
	await expect.poll(
		async () => {
			const texts = (await realPlugin.getHighlights(url)).map(h => h.exactText);
			return texts.some(t => t.includes(substring));
		},
		POLL_OPTS
	).toBe(true);
}

// ── The 6 add pairs ──────────────────────────────────────

test('W → O: highlight in page view propagates to plugin', async ({
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	await dragSelect(page, '#p1', 'quick brown fox');
	const t0 = Date.now();
	await releaseDrag(page);
	await pollForHighlightText(realPlugin, articleUrl, 'quick brown fox');
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('W → R: highlight in page view appears in reader mode in another tab', async ({
	context, articleUrl, realPlugin,
}) => {
	const readerTab = await context.newPage();
	await readerTab.goto(articleUrl);
	await enterReaderMode(readerTab);

	const pageTab = await context.newPage();
	await pageTab.goto(articleUrl);
	await enterHighlighterMode(pageTab);

	await dragSelect(pageTab, '#p2', 'boxing wizards');
	const t0 = Date.now();
	await releaseDrag(pageTab);
	await waitForMarkWithText(readerTab, 'boxing wizards');
	const latency = Date.now() - t0;
	expect((await realPlugin.getHighlights(articleUrl)).length).toBeGreaterThan(0);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('R → O: highlight in reader mode propagates to plugin', async ({
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterReaderMode(page);
	await enterHighlighterMode(page);

	await dragSelect(page, 'article', 'opal jewels');
	const t0 = Date.now();
	await releaseDrag(page);
	await pollForHighlightText(realPlugin, articleUrl, 'opal jewels');
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('R → W: highlight in reader mode appears in page view in another tab', async ({
	context, articleUrl, realPlugin,
}) => {
	const pageTab = await context.newPage();
	await pageTab.goto(articleUrl);

	const readerTab = await context.newPage();
	await readerTab.goto(articleUrl);
	await enterReaderMode(readerTab);
	await enterHighlighterMode(readerTab);

	await dragSelect(readerTab, 'article', 'Crazy Fredrick');
	const t0 = Date.now();
	await releaseDrag(readerTab);
	await waitForMarkWithText(pageTab, 'Crazy Fredrick');
	const latency = Date.now() - t0;
	expect((await realPlugin.getHighlights(articleUrl)).length).toBeGreaterThan(0);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('O → W: plugin-side highlight appears in page view via SSE', async ({
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	// Let the clipper's initial load + SSE subscription settle.
	await page.waitForTimeout(300);

	const t0 = Date.now();
	await realPlugin.addHighlight(articleUrl, {
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
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterReaderMode(page);
	await page.waitForTimeout(300);

	const t0 = Date.now();
	await realPlugin.addHighlight(articleUrl, {
		id: 'obs-r-' + Date.now(),
		exactText: 'five boxing wizards',
		prefixText: 'The ',
		suffixText: ' jump',
	});
	await waitForMarkWithText(page, 'five boxing wizards');
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

// ── Link clicks inside highlights ────────────────────────

test('page+highlighter mode: clicking a highlighted link keeps the highlight (navigation blocked)', async ({
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	await programmaticSelectAndRelease(page, '#p4', 'about linked foxes');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBeGreaterThan(0);

	const linkHasMark = await page.evaluate(() => {
		const link = document.getElementById('test-link');
		return !!link?.querySelector('.reading-selection-highlight-mark');
	});
	expect(linkHasMark).toBe(true);

	await page.click('#test-link');

	// disableLinkClicks prevents navigation while highlighter mode is on.
	expect(page.url()).not.toContain('#link-target');

	const markStillThere = await page.evaluate(() =>
		!!document.querySelector('.reading-selection-highlight-mark')
	);
	expect(markStillThere).toBe(true);
	expect((await realPlugin.getHighlights(articleUrl)).length).toBe(1);
});

test('reader mode: clicking a highlighted link navigates and keeps the highlight', async ({
	page, articleUrl, realPlugin,
}) => {
	await realPlugin.addHighlight(articleUrl, {
		id: 'link-test-' + Date.now(),
		exactText: 'linked foxes',
		prefixText: 'about ',
		suffixText: ' at',
	});

	await page.goto(articleUrl);
	await enterReaderMode(page);
	await waitForMarkWithText(page, 'linked foxes');

	// Obsidian's markdown renderer annotates internal links with
	// target="_blank" — that'd open a new tab on click instead of navigating
	// the current page, defeating the navigation assertion. Strip it so the
	// hash navigation happens in-place.
	await page.evaluate(() => {
		const link = document.querySelector('article a[href*="link-target"]') as HTMLAnchorElement | null;
		link?.removeAttribute('target');
	});

	const linkHasMark = await page.evaluate(() => {
		const link = document.querySelector('article a[href*="link-target"]');
		return !!link?.querySelector('.reading-selection-highlight-mark');
	});
	expect(linkHasMark).toBe(true);

	await page.click('article a[href*="link-target"]');
	await expect(page).toHaveURL(/#link-target$/);

	const markStillThere = await page.evaluate(() =>
		!!document.querySelector('.reading-selection-highlight-mark')
	);
	expect(markStillThere).toBe(true);
	expect((await realPlugin.getHighlights(articleUrl)).length).toBe(1);
});

// ── The 6 remove pairs ───────────────────────────────────

test('W → O (remove): removing a highlight in page view propagates to plugin', async ({
	page, articleUrl, realPlugin,
}) => {
	const id = 'rm-wo-' + Date.now();
	await realPlugin.addHighlight(articleUrl, {
		id, exactText: 'quick brown fox', prefixText: 'The ', suffixText: ' jumps',
	});

	await page.goto(articleUrl);
	await enterHighlighterMode(page);
	await waitForMarkWithText(page, 'quick brown fox');

	const t0 = Date.now();
	await clickMarkById(page, id);
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(0);
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('W → R (remove): removing a highlight in page view disappears in reader mode', async ({
	context, articleUrl, realPlugin,
}) => {
	const id = 'rm-wr-' + Date.now();
	await realPlugin.addHighlight(articleUrl, {
		id, exactText: 'boxing wizards', prefixText: 'five ', suffixText: ' jump',
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
	expect((await realPlugin.getHighlights(articleUrl)).length).toBe(0);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('R → O (remove): removing a highlight in reader mode propagates to plugin', async ({
	page, articleUrl, realPlugin,
}) => {
	const id = 'rm-ro-' + Date.now();
	await realPlugin.addHighlight(articleUrl, {
		id, exactText: 'opal jewels', prefixText: 'exquisite ', suffixText: '.',
	});

	await page.goto(articleUrl);
	await enterReaderMode(page);
	await waitForMarkWithText(page, 'opal jewels');

	const t0 = Date.now();
	await clickMarkById(page, id);
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(0);
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('R → W (remove): removing a highlight in reader mode disappears in page view', async ({
	context, articleUrl, realPlugin,
}) => {
	const id = 'rm-rw-' + Date.now();
	await realPlugin.addHighlight(articleUrl, {
		id, exactText: 'Crazy Fredrick', prefixText: '', suffixText: ' bought',
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
	expect((await realPlugin.getHighlights(articleUrl)).length).toBe(0);
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('O → W (remove): plugin-side removal disappears in page view via SSE', async ({
	page, articleUrl, realPlugin,
}) => {
	const id = 'rm-ow-' + Date.now();
	await realPlugin.addHighlight(articleUrl, {
		id, exactText: 'vexingly quick daft zebras', prefixText: 'How ', suffixText: ' jump',
	});

	await page.goto(articleUrl);
	await waitForMarkWithText(page, 'vexingly quick daft zebras');
	await page.waitForTimeout(200);

	const t0 = Date.now();
	await realPlugin.removeHighlight(articleUrl, id);
	await waitForMarkGone(page, 'vexingly quick daft zebras');
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

test('O → R (remove): plugin-side removal disappears in reader mode via SSE', async ({
	page, articleUrl, realPlugin,
}) => {
	const id = 'rm-or-' + Date.now();
	await realPlugin.addHighlight(articleUrl, {
		id, exactText: 'five boxing wizards', prefixText: 'The ', suffixText: ' jump',
	});

	await page.goto(articleUrl);
	await enterReaderMode(page);
	await waitForMarkWithText(page, 'five boxing wizards');
	await page.waitForTimeout(200);

	const t0 = Date.now();
	await realPlugin.removeHighlight(articleUrl, id);
	await waitForMarkGone(page, 'five boxing wizards');
	const latency = Date.now() - t0;
	expect(latency).toBeLessThan(LATENCY_BUDGET_MS);
});

// ── Tier 2: persistence, merge, offline, multi-highlight ─

test('persistence: user-created highlight reappears after a full page reload', async ({
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	await dragSelect(page, '#p1', 'quick brown fox');
	await releaseDrag(page);
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(1);

	await page.reload();
	await waitForMarkWithText(page, 'quick brown fox');
	expect((await realPlugin.getHighlights(articleUrl)).length).toBe(1);
});

test('persistence: plugin-side highlight loads on fresh navigation', async ({
	page, articleUrl, realPlugin,
}) => {
	await realPlugin.addHighlight(articleUrl, {
		id: 'prehydrate-' + Date.now(),
		exactText: 'exquisite opal jewels',
		prefixText: 'many very ',
		suffixText: '.',
	});

	await page.goto(articleUrl);
	await waitForMarkWithText(page, 'exquisite opal jewels');
});

test('merge: overlapping highlights collapse into one combined highlight', async ({
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	await dragSelect(page, '#p1', 'The quick');
	await releaseDrag(page);
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(1);

	// The first highlight has split the text node, so dragSelect (which walks
	// a single text node) can't find "quick brown fox" as one substring.
	// programmaticSelectAndRelease walks the whole subtree and builds a range
	// across multiple text nodes via getSelection.
	await programmaticSelectAndRelease(page, '#p1', 'quick brown fox');

	// After merge: exactly one highlight covering the combined span.
	await expect.poll(
		async () => {
			const hs = await realPlugin.getHighlights(articleUrl);
			if (hs.length !== 1) return null;
			return hs[0].exactText;
		},
		POLL_OPTS
	).toMatch(/The quick brown fox/);
});

test('offline: highlight created while plugin is unreachable gets pushed on reload', async ({
	page, context, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	// Take the plugin offline (from the clipper's perspective) by intercepting
	// every outgoing request to :27124 and returning 503. The real plugin
	// itself keeps running — this is purely network-layer fault injection.
	const block = async (route: Route) => {
		await route.fulfill({ status: 503, body: 'offline' });
	};
	await context.route('**/localhost:27124/**', block);
	await context.route('**/127.0.0.1:27124/**', block);

	await dragSelect(page, '#p2', 'boxing wizards');
	await releaseDrag(page);
	// Local mark should appear regardless of plugin availability.
	await waitForMarkWithText(page, 'boxing wizards');
	// Plugin didn't receive it.
	expect((await realPlugin.getHighlights(articleUrl)).length).toBe(0);

	// Un-route → plugin is reachable again.
	await context.unroute('**/localhost:27124/**', block);
	await context.unroute('**/127.0.0.1:27124/**', block);

	// Reload → loadAndApplyPageHighlights reconciles local-only highlights
	// to the plugin.
	await page.reload();
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		{ intervals: [50, 100, 200, 500], timeout: 5000 }
	).toBe(1);
	expect((await realPlugin.getHighlights(articleUrl))[0].exactText)
		.toContain('boxing wizards');
});

test('multi-highlight: removing one highlight leaves the others intact', async ({
	page, articleUrl, realPlugin,
}) => {
	const ids = ['multi-a-' + Date.now(), 'multi-b-' + Date.now(), 'multi-c-' + Date.now()];
	const hs: Highlight[] = [
		{ id: ids[0], exactText: 'quick brown fox', prefixText: 'The ', suffixText: ' jumps' },
		{ id: ids[1], exactText: 'boxing wizards', prefixText: 'five ', suffixText: ' jump' },
		{ id: ids[2], exactText: 'opal jewels', prefixText: 'exquisite ', suffixText: '.' },
	];
	for (const h of hs) await realPlugin.addHighlight(articleUrl, h);

	await page.goto(articleUrl);
	await enterHighlighterMode(page);
	await waitForMarkWithText(page, 'quick brown fox');
	await waitForMarkWithText(page, 'boxing wizards');
	await waitForMarkWithText(page, 'opal jewels');

	await clickMarkById(page, ids[1]);
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(2);

	const remaining = (await realPlugin.getHighlights(articleUrl)).map(h => h.id).sort();
	expect(remaining).toEqual([ids[0], ids[2]].sort());
	await waitForMarkWithText(page, 'quick brown fox');
	await waitForMarkWithText(page, 'opal jewels');
	await waitForMarkGone(page, 'boxing wizards');
});
