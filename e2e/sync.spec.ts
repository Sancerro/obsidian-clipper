import { test, expect } from './test-fixture';
import type { Page, BrowserContext, Worker, Route } from '@playwright/test';
import type { Highlight } from './real-plugin';
import { TEST_TRANSCRIPT_URL } from './real-plugin';

// Budget for a single propagation cycle against the REAL plugin. Generous
// because the plugin writes highlight state to disk on every mutation, so
// sub-100ms (our original aim against the fake) isn't realistic.
const LATENCY_BUDGET_MS = 1500;
const POLL_OPTS = { intervals: [10, 10, 20, 30, 50, 100], timeout: 3000 };

// Context, fixtureServer, realPlugin are all worker-scoped for speed — so
// per-test isolation has to come from explicit hooks:
//   - clear highlight state for the test URL on the plugin
//   - clear the extension's own browser.storage.local so test A's
//     local highlights don't get reconciled onto the plugin when
//     test B loads a page (would look like leaked state)
//   - drop any routes a test installed (offline test uses context.route)
//   - close every extra page (multi-tab tests use context.newPage)

async function clearExtensionStorage(context: BrowserContext): Promise<void> {
	const [sw] = context.serviceWorkers();
	if (!sw) return;
	await sw.evaluate(async () => {
		const api = (globalThis as any).chrome;
		// Clearing only the highlight-related keys keeps user settings alive;
		// that's irrelevant here since it's a fresh profile per worker, but
		// it's also cheap and future-proof.
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
	// Close all pages that tests opened, keeping at least one alive so
	// Playwright's default `page` fixture can still be torn down cleanly.
	const pages = context.pages();
	for (let i = 1; i < pages.length; i++) {
		await pages[i].close().catch(() => {});
	}
});

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

	// Mirror what background.ts injectReaderScript() does in production:
	// reader.css first, then browser-polyfill, then reader-script.js. Without
	// reader.css, the transcript layout / sticky player CSS rules don't apply
	// — tests would pass `hasPinClass` but computed position would be static.
	await sw.evaluate(async (id) => {
		const chromeApi = (globalThis as any).chrome;
		await chromeApi.scripting.insertCSS({
			target: { tabId: id },
			files: ['reader.css'],
		});
		await chromeApi.scripting.executeScript({
			target: { tabId: id },
			files: ['browser-polyfill.min.js'],
		});
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

// ── Transcript auto-scroll ───────────────────────────────
//
// All transcript tests use a REAL linked note in the vault
// (E2E/e2e-transcript-fixture.md → TEST_TRANSCRIPT_URL). The note's
// markdown contains raw HTML for the transcript section and a <video>
// pointing at the silent.mp4 fixture; Obsidian's markdown renderer passes
// the HTML (classes, data-timestamp) through unchanged, and reader mode
// fetches it via the real /page endpoint. No mocks.

test('auto-scroll: transcript segment advance scrolls the page', async ({
	page,
}) => {
	await page.goto(TEST_TRANSCRIPT_URL);
	await enterReaderMode(page);
	await page.waitForSelector('.youtube.transcript .transcript-segment');

	const fixtureShape = await page.evaluate(() => ({
		readerActive: document.documentElement.classList.contains('obsidian-reader-active'),
		segmentCount: document.querySelectorAll('.transcript-segment').length,
		hasVideo: !!document.querySelector('.reader-video-wrapper video.reader-video-player'),
		hasPlayerContainer: !!document.querySelector('.player-container'),
		firstSegmentRestructured: !!document.querySelector('.transcript-segment .transcript-segment-text'),
		initialScrollY: window.scrollY,
	}));
	expect(fixtureShape.readerActive).toBe(true);
	expect(fixtureShape.segmentCount).toBe(30);
	expect(fixtureShape.hasVideo).toBe(true);
	expect(fixtureShape.hasPlayerContainer).toBe(true);
	expect(fixtureShape.firstSegmentRestructured).toBe(true);

	// Wait for the video to reach HAVE_METADATA so currentTime can be set.
	await page.waitForFunction(() => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement | null;
		return !!v && v.readyState >= 1 && v.duration > 60;
	}, { timeout: 5000 });

	// Seek to 60s. This is a REAL browser seek: the media pipeline advances
	// currentTime, fires a seeked + timeupdate event naturally, and
	// wireTranscript's listener reads the real value. No mocks, no synthetic
	// dispatch.
	await page.evaluate(async () => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement;
		await new Promise<void>(resolve => {
			v.addEventListener('seeked', () => resolve(), { once: true });
			v.currentTime = 60;
		});
	});

	// Wait for segment 12 (t=60) to become active.
	await page.waitForFunction(() => {
		const active = document.querySelector('.transcript-segment.is-active .timestamp');
		return active?.getAttribute('data-timestamp') === '60';
	}, { timeout: 3000 });

	// Auto-scroll animates via requestAnimationFrame (~200ms) then a 50ms
	// tail before the programmatic-scroll flag resets. Poll until scrollY
	// actually moves.
	await page.waitForFunction(
		() => window.scrollY > 0,
		{ timeout: 2000 }
	);

	const finalScrollY = await page.evaluate(() => window.scrollY);
	expect(finalScrollY).toBeGreaterThan(fixtureShape.initialScrollY);
});

test('auto-scroll: sustained across the AUTO_SCROLL_COOLDOWN window', async ({
	page,
}) => {
	// Regression test for the cooldown-lockup bug: after the first auto-scroll
	// a late scroll event could slip past the `programmaticScroll` flag,
	// bump `lastUserScroll = Date.now()`, and poison the next 2000ms cooldown.
	// Fix switched from a boolean flag + setTimeout to a
	// `programmaticScrollUntil` timestamp with a generous 500ms grace window.
	await page.goto(TEST_TRANSCRIPT_URL);
	await enterReaderMode(page);
	await page.waitForFunction(() => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement | null;
		return !!v && v.readyState >= 1 && v.duration > 120;
	}, { timeout: 5000 });

	// First advance: segment 12 at t=60.
	await page.evaluate(async () => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement;
		await new Promise<void>(resolve => {
			v.addEventListener('seeked', () => resolve(), { once: true });
			v.currentTime = 60;
		});
	});
	await page.waitForFunction(
		() => window.scrollY > 0,
		{ timeout: 2000 }
	);
	const firstScrollY = await page.evaluate(() => window.scrollY);

	// Wait past the AUTO_SCROLL_COOLDOWN (2000ms) so the next advance isn't
	// suppressed by the recent auto-scroll.
	await page.waitForTimeout(2100);

	// Second advance: segment 24 at t=120. If the cooldown is poisoned by a
	// late scroll event, this second auto-scroll will not fire and scrollY
	// stays at firstScrollY.
	await page.evaluate(async () => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement;
		await new Promise<void>(resolve => {
			v.addEventListener('seeked', () => resolve(), { once: true });
			v.currentTime = 120;
		});
	});
	await page.waitForFunction(
		(prev) => window.scrollY > (prev as number) + 10,
		firstScrollY,
		{ timeout: 3000 }
	);

	const secondScrollY = await page.evaluate(() => window.scrollY);
	expect(secondScrollY).toBeGreaterThan(firstScrollY);
});

test('pin player: no ancestor breaks sticky, and the player stays pinned during auto-scroll', async ({
	page,
}) => {
	await page.goto(TEST_TRANSCRIPT_URL);
	await enterReaderMode(page);
	await page.waitForSelector('.player-container');
	await page.waitForFunction(() => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement | null;
		return !!v && v.readyState >= 1 && v.duration > 60;
	}, { timeout: 5000 });

	// 1. Class + computed position.
	const pinned = await page.evaluate(() => {
		const pc = document.querySelector('.player-container') as HTMLElement | null;
		return {
			hasPinClass: pc?.classList.contains('pin-player') ?? false,
			computedPosition: pc ? getComputedStyle(pc).position : null,
			computedTop: pc ? getComputedStyle(pc).top : null,
		};
	});
	expect(pinned.hasPinClass).toBe(true);
	expect(pinned.computedPosition).toBe('sticky');
	expect(pinned.computedTop).toBe('0px');

	// 2. No ancestor between .player-container and <html> creates a scroll
	// container. `overflow: hidden|scroll|auto` on any ancestor swallows
	// sticky. This is the root cause of the original pinning bug — the
	// `.obsidian-reader-content` container had `overflow: hidden` which
	// is why the video scrolled out of view.
	const ancestors = await page.evaluate(() => {
		const pc = document.querySelector('.player-container') as HTMLElement;
		const bad: Array<{ tag: string; cls: string; overflow: string }> = [];
		let el: HTMLElement | null = pc.parentElement;
		while (el && el !== document.documentElement) {
			const ov = getComputedStyle(el).overflow;
			if (/(hidden|scroll|auto)/.test(ov) && ov !== 'visible') {
				bad.push({ tag: el.tagName, cls: el.className.slice(0, 50), overflow: ov });
			}
			el = el.parentElement;
		}
		return bad;
	});
	expect(ancestors).toEqual([]);

	// 3. Functional check: drive auto-scroll to segment 24 (t=120) and
	// verify the player-container's bounding rect stays at top: 0 (pinned)
	// throughout. Using the real video seek so updateActiveSegment fires
	// naturally.
	await page.evaluate(async () => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement;
		await new Promise<void>(resolve => {
			v.addEventListener('seeked', () => resolve(), { once: true });
			v.currentTime = 120;
		});
	});
	// Wait for the auto-scroll to finish.
	await page.waitForFunction(
		() => window.scrollY > 500,
		{ timeout: 3000 }
	);

	const playerAfterScroll = await page.evaluate(() => {
		const pc = document.querySelector('.player-container') as HTMLElement;
		const r = pc.getBoundingClientRect();
		return { top: r.top, bottom: r.bottom, scrollY: window.scrollY };
	});
	// Pinned: top is at 0 (or very close), and bottom is in the viewport.
	expect(playerAfterScroll.top).toBeGreaterThanOrEqual(-1);
	expect(playerAfterScroll.top).toBeLessThan(20);
	expect(playerAfterScroll.bottom).toBeGreaterThan(0);
});

// ── Tier 1: transcript interaction + exit reader + undo/redo ──

test('transcript segment click seeks the video to that timestamp', async ({
	page,
}) => {
	await page.goto(TEST_TRANSCRIPT_URL);
	await enterReaderMode(page);
	await page.waitForFunction(() => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement | null;
		return !!v && v.readyState >= 1 && v.duration > 60;
	}, { timeout: 5000 });

	// Reader mode auto-enables highlighter (`reader.ts:2327`), and the
	// transcript's click handler early-returns when `obsidian-highlighter-active`
	// is on body — click-to-seek only works when the user isn't mid-highlight.
	// Drop the class directly so the click lands in the seek path.
	await page.evaluate(() => {
		document.body.classList.remove('obsidian-highlighter-active');
	});

	// wireTranscript's delegated click handler computes the target time from
	// the segment's startTime. For a single click at the start of a segment
	// with no caret position, caret offset falls back to totalLen, mapping
	// to progress=1 and a seek close to the segment's END. Click BEFORE the
	// segment at t=60 (segment 12) to land near t=60 itself: the segment
	// with data-timestamp="55" has end=60, so clicking it with no caret seeks
	// to 60.
	await page.evaluate(async () => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement;
		const target = Array.from(document.querySelectorAll('.transcript-segment'))
			.find(seg => seg.querySelector('.timestamp')?.getAttribute('data-timestamp') === '55') as HTMLElement;
		if (!target) throw new Error('segment at t=55 not found');
		const seeked = new Promise<void>(resolve => {
			v.addEventListener('seeked', () => resolve(), { once: true });
		});
		target.click();
		await seeked;
	});

	const currentTime = await page.evaluate(() => {
		const v = document.querySelector('.reader-video-wrapper video.reader-video-player') as HTMLVideoElement;
		return v.currentTime;
	});
	// Target was segment start=55, end=60. A click without a caret hits
	// progress=1 → seekTo(60). Allow a small rounding tolerance.
	expect(currentTime).toBeGreaterThanOrEqual(59);
	expect(currentTime).toBeLessThanOrEqual(61);
});

test('player toggles: clicking pin/auto-scroll/highlight-line flips state live', async ({
	page,
}) => {
	await page.goto(TEST_TRANSCRIPT_URL);
	await enterReaderMode(page);
	await page.waitForSelector('.player-toggles .player-toggle');

	// Initial state: all three toggles are on (default settings).
	const initial = await page.evaluate(() => {
		const toggles = Array.from(document.querySelectorAll('.player-toggle')) as HTMLElement[];
		return toggles.map(t => ({
			label: t.querySelector('span')?.textContent,
			enabled: t.classList.contains('is-enabled'),
		}));
	});
	expect(initial).toHaveLength(3);
	expect(initial.every(t => t.enabled)).toBe(true);
	// Player container has pin-player class by default.
	const pinnedInitially = await page.evaluate(() =>
		document.querySelector('.player-container')?.classList.contains('pin-player')
	);
	expect(pinnedInitially).toBe(true);

	// Click the pin toggle — should remove pin-player class from container.
	await page.evaluate(() => {
		const toggles = Array.from(document.querySelectorAll('.player-toggle')) as HTMLElement[];
		const pinToggle = toggles.find(t => t.querySelector('span')?.textContent?.toLowerCase().includes('pin'));
		pinToggle?.click();
	});
	await page.waitForFunction(() =>
		!document.querySelector('.player-container')?.classList.contains('pin-player')
	, { timeout: 1000 });
	const pinnedAfterClick = await page.evaluate(() =>
		document.querySelector('.player-container')?.classList.contains('pin-player')
	);
	expect(pinnedAfterClick).toBe(false);

	// Toggle it back on.
	await page.evaluate(() => {
		const toggles = Array.from(document.querySelectorAll('.player-toggle')) as HTMLElement[];
		const pinToggle = toggles.find(t => t.querySelector('span')?.textContent?.toLowerCase().includes('pin'));
		pinToggle?.click();
	});
	await page.waitForFunction(() =>
		document.querySelector('.player-container')?.classList.contains('pin-player')
	, { timeout: 1000 });

	// Click auto-scroll toggle — should remove is-enabled from that toggle.
	// (The effect is internal to wireTranscript's autoScrollEnabled closure;
	// the `.is-enabled` class reflection is the only externally visible hint.)
	const autoScrollState = await page.evaluate(() => {
		const toggles = Array.from(document.querySelectorAll('.player-toggle')) as HTMLElement[];
		const autoScrollToggle = toggles.find(t => t.querySelector('span')?.textContent?.toLowerCase().includes('auto'));
		autoScrollToggle?.click();
		return autoScrollToggle?.classList.contains('is-enabled');
	});
	expect(autoScrollState).toBe(false);

	// Click highlight-line toggle — same pattern.
	const highlightState = await page.evaluate(() => {
		const toggles = Array.from(document.querySelectorAll('.player-toggle')) as HTMLElement[];
		const highlightToggle = toggles.find(t => t.querySelector('span')?.textContent?.toLowerCase().includes('highlight'));
		highlightToggle?.click();
		return highlightToggle?.classList.contains('is-enabled');
	});
	expect(highlightState).toBe(false);
});

test('exit reader mode: restores the original page DOM and removes reader chrome', async ({
	page, articleUrl,
}) => {
	await page.goto(articleUrl);

	// Sanity: the original fixture page has #p1 / #p2 / #p3 paragraphs.
	const beforeReader = await page.evaluate(() => ({
		hasP1: !!document.getElementById('p1'),
		hasP2: !!document.getElementById('p2'),
		readerClass: document.documentElement.classList.contains('obsidian-reader-active'),
	}));
	expect(beforeReader.hasP1).toBe(true);
	expect(beforeReader.readerClass).toBe(false);

	await enterReaderMode(page);
	const duringReader = await page.evaluate(() => ({
		readerClass: document.documentElement.classList.contains('obsidian-reader-active'),
		hasReaderContainer: !!document.querySelector('.obsidian-reader-container'),
		hasArticle: !!document.querySelector('article'),
	}));
	expect(duringReader.readerClass).toBe(true);
	expect(duringReader.hasReaderContainer).toBe(true);

	// Toggle reader mode off via the same service-worker path reader uses.
	const sw = await getServiceWorker(page.context());
	const tabId = await sw.evaluate(async () => {
		const tabs = await (globalThis as any).chrome.tabs.query({ active: true, currentWindow: true });
		return tabs[0]?.id ?? null;
	});
	await sw.evaluate(async (id) => {
		await (globalThis as any).chrome.tabs.sendMessage(id, { action: 'toggleReaderMode' });
	}, tabId);

	// Reader.restore replaces doc.documentElement with the original HTML via
	// doc.replaceChild, then navigation is needed to re-run scripts. Wait for
	// the reader class to go away AND the original #p1 paragraph to reappear.
	await page.waitForFunction(() => {
		return !document.documentElement.classList.contains('obsidian-reader-active')
			&& !!document.getElementById('p1');
	}, { timeout: 5000 });

	const afterReader = await page.evaluate(() => ({
		readerClass: document.documentElement.classList.contains('obsidian-reader-active'),
		hasReaderContainer: !!document.querySelector('.obsidian-reader-container'),
		hasP1: !!document.getElementById('p1'),
		hasP2: !!document.getElementById('p2'),
	}));
	expect(afterReader.readerClass).toBe(false);
	expect(afterReader.hasReaderContainer).toBe(false);
	expect(afterReader.hasP1).toBe(true);
	expect(afterReader.hasP2).toBe(true);
});

// Undo / redo (Cmd+Z / Cmd+Shift+Z) intentionally NOT tested:
// `highlighter.ts#handleKeyDown` binds these to `undo()` / `redo()` in the
// LEGACY XPath highlight system. The text-anchor mark flow used by everything
// real (reader-highlights.ts) has no history stack, so Cmd+Z is a silent
// no-op for any highlight created in the current architecture. Writing a
// test against behavior that doesn't exist would just codify the gap.

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
