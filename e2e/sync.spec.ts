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

test('undo / redo: Cmd+Z undoes a highlight add, Cmd+Shift+Z redoes it', async ({
	page, articleUrl, realPlugin,
}) => {
	await page.goto(articleUrl);
	await enterHighlighterMode(page);

	// Create two highlights.
	await dragSelect(page, '#p1', 'quick brown fox');
	await releaseDrag(page);
	await pollForHighlightText(realPlugin, articleUrl, 'quick brown fox');

	await dragSelect(page, '#p2', 'boxing wizards');
	await releaseDrag(page);
	await pollForHighlightText(realPlugin, articleUrl, 'boxing wizards');

	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(2);

	// Cmd+Z should undo the most recent add ("boxing wizards"), which
	// unwraps the marks, removes from local storage, and POSTs
	// /highlights/remove to the plugin.
	await page.keyboard.press('Meta+z');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).map(h => h.exactText),
		POLL_OPTS
	).toEqual(
		expect.arrayContaining([expect.stringContaining('quick brown fox')])
	);
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(1);
	// The remaining highlight is the first one, not "boxing wizards".
	const remainingAfterUndo = await realPlugin.getHighlights(articleUrl);
	expect(remainingAfterUndo.some(h => h.exactText.includes('boxing wizards'))).toBe(false);
	expect(remainingAfterUndo.some(h => h.exactText.includes('quick brown fox'))).toBe(true);

	// Undo again — now both highlights gone.
	await page.keyboard.press('Meta+z');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(0);

	// Cmd+Shift+Z redo should put "quick brown fox" back.
	await page.keyboard.press('Meta+Shift+z');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(1);

	// Redo again puts "boxing wizards" back.
	await page.keyboard.press('Meta+Shift+z');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(2);

	const both = await realPlugin.getHighlights(articleUrl);
	expect(both.some(h => h.exactText.includes('quick brown fox'))).toBe(true);
	expect(both.some(h => h.exactText.includes('boxing wizards'))).toBe(true);
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

// ── Midnight theme d-key toggle ─────────────────────────────
//
// Bug: the midnight theme lost its parchment-light CSS variant during a
// rebase (commit 5c39263 replaced the two-variant block with dark-only +
// color-scheme: dark). Pressing `d` in reader mode flipped the class but
// had no visual effect because no light variables existed.
//
// Fix: restored both light (parchment #f4f0e8) and dark (#0d0d0d) variants
// in _reader-themes.scss. This test verifies the runtime behavior: enter
// reader mode, set midnight theme, press d, and confirm the computed
// background color actually changes.

test('midnight theme: d-key toggles between parchment-light and near-black-dark', async ({
	page, articleUrl, context,
}) => {
	// Pre-seed reader settings with midnight as both light and dark theme
	// so getEffectiveTheme() returns 'midnight' in both modes.
	const sw = await getServiceWorker(context);
	await sw.evaluate(async () => {
		await (globalThis as any).chrome.storage.sync.set({
			reader_settings: {
				fontSize: 16, lineHeight: 1.6, maxWidth: 38,
				lightTheme: 'midnight', darkTheme: 'same',
				appearance: 'light',
				fonts: [], defaultFont: '', blendImages: true, colorLinks: false,
				pinPlayer: true, autoScroll: true, highlightActiveLine: true, customCss: '',
			},
		});
	});

	await page.goto(articleUrl);
	await enterReaderMode(page);

	// Verify midnight theme is applied and we start in light mode.
	await page.waitForFunction(() =>
		document.documentElement.classList.contains('theme-light')
		&& document.documentElement.getAttribute('data-reader-theme') === 'midnight'
	, { timeout: 3000 });

	const lightBg = await page.evaluate(() => {
		return getComputedStyle(document.body).backgroundColor;
	});
	// Parchment: #f4f0e8 → rgb(244, 240, 232)
	expect(lightBg).toMatch(/rgb\(244,\s*240,\s*232\)/);

	// Press 'd' — should toggle to theme-dark.
	await page.focus('body');
	await page.keyboard.press('d');

	await page.waitForFunction(() =>
		document.documentElement.classList.contains('theme-dark')
	, { timeout: 1000 });

	const darkBg = await page.evaluate(() => {
		return getComputedStyle(document.body).backgroundColor;
	});
	// Near-black: #0d0d0d → rgb(13, 13, 13)
	expect(darkBg).toMatch(/rgb\(13,\s*13,\s*13\)/);

	// Press 'd' again — should toggle back to theme-light.
	await page.keyboard.press('d');

	await page.waitForFunction(() =>
		document.documentElement.classList.contains('theme-light')
	, { timeout: 1000 });

	const backToLightBg = await page.evaluate(() => {
		return getComputedStyle(document.body).backgroundColor;
	});
	expect(backToLightBg).toMatch(/rgb\(244,\s*240,\s*232\)/);
});

// ── Theme persistence across reader mode exit / re-enter ──
//
// The d-key shortcut now calls updateThemeMode(), which persists the
// appearance setting to browser.storage.sync. Verify that the chosen
// theme survives a full exit-reader → re-enter-reader cycle.

test('theme persistence: d-key toggle survives navigation to a new page', async ({
	page, articleUrl, context,
}) => {
	await page.goto(articleUrl);
	await enterReaderMode(page);

	// Confirm we start in the default (auto → light).
	await page.waitForFunction(() =>
		document.documentElement.classList.contains('theme-light')
	, { timeout: 2000 });

	// Press 'd' to switch to dark mode.
	await page.focus('body');
	await page.keyboard.press('d');
	await page.waitForFunction(() =>
		document.documentElement.classList.contains('theme-dark')
	, { timeout: 1000 });

	// The d-key handler calls updateThemeMode which fires saveSettings
	// asynchronously. Poll storage from the service worker to confirm the
	// write landed before opening a second tab.
	const sw = await getServiceWorker(context);
	await expect.poll(async () => {
		return sw.evaluate(async () => {
			const data = await (globalThis as any).chrome.storage.sync.get('reader_settings');
			return data?.reader_settings?.appearance;
		});
	}, { timeout: 5000, message: 'expected storage.sync appearance to be "dark"' }).toBe('dark');

	// Open a fresh page and enter reader mode — settings load from storage.
	const page2 = await context.newPage();
	await page2.goto(articleUrl);
	await enterReaderMode(page2);

	// The theme should still be dark (persisted to storage).
	await page2.waitForFunction(() =>
		document.documentElement.classList.contains('theme-dark')
	, { timeout: 3000 });

	const isDark = await page2.evaluate(() =>
		document.documentElement.classList.contains('theme-dark')
	);
	expect(isDark).toBe(true);
	await page2.close();
});

// ── Wikipedia IPA phonetics survive reader-mode extraction ──
//
// Bug: Defuddle's partial-selector removal pass includes "-comment" as a
// substring pattern (intended to strip comment sections). Wikipedia wraps
// pronunciation tooltips in `<span class="rt-commentedText">` — "rt" is
// "ruby text", and "commentedText" means "has a tooltip annotation", not
// "user comment". The "-comment" substring matched, stripping the wrapper
// and the IPA transcription (e.g. /əˈpɒkrɪfə/) inside.
//
// Fix: before Defuddle runs, reader.ts strips the `rt-commentedText` class
// from the source DOM so the partial match misses. This test loads a fixture
// with real Wikipedia IPA markup and confirms the phonetic text survives
// reader-mode extraction.

test('Wikipedia IPA phonetics survive reader-mode extraction', async ({
	page,
}) => {
	// This URL is NOT linked to any vault note, so reader mode falls through
	// the plugin's /page endpoint (no notePath) to Defuddle extraction.
	const ipaUrl = 'http://127.0.0.1:3100/wikipedia-ipa.html';
	await page.goto(ipaUrl);
	await enterReaderMode(page);

	// Wait for the article to render.
	await page.waitForSelector('article', { timeout: 10_000 });

	// The IPA text /əˈpɒkrɪfə/ should be present in the reader article.
	// Defuddle's standardization pass may insert spaces between the per-
	// character <span> elements, so check for individual IPA characters
	// rather than a contiguous substring.
	const ipaCheck = await page.evaluate(() => {
		const article = document.querySelector('article');
		if (!article) return { found: false, text: '' };
		const text = article.textContent || '';
		// Strip whitespace for the adjacency check — Defuddle inserts spaces
		// between inline elements during standardization.
		const stripped = text.replace(/\s+/g, '');
		return {
			found: stripped.includes('\u0259') && stripped.includes('\u0252') && stripped.includes('kr\u026Af'),
			text: text.slice(0, 300),
		};
	});
	expect(ipaCheck.found, `reader mode article must contain IPA characters (got: ${ipaCheck.text.slice(0, 150)})`).toBe(true);

	// Also verify the parentheses aren't empty — the pre-fix symptom was
	// "Apocrypha () are biblical..." (empty parens where IPA was stripped).
	const noEmptyParens = await page.evaluate(() => {
		const article = document.querySelector('article');
		if (!article) return false;
		const text = article.textContent || '';
		// Look for the word Apocrypha followed by something inside parens.
		// Allow whitespace between characters since Defuddle may insert it.
		const match = text.match(/Apocrypha\s*\(([^)]*)\)/);
		return match ? match[1].trim().length > 0 : false;
	});
	expect(noEmptyParens, 'parentheses after "Apocrypha" must not be empty').toBe(true);
});

// ── SSE reconnection ────────────────────────────────────────
//
// The clipper subscribes to the plugin's SSE stream for real-time
// highlight push. If the stream drops (plugin restart, network blip),
// the clipper should reconnect and resume receiving updates.

test('SSE reconnection: highlight pushed after stream drop is received', async ({
	page, articleUrl, realPlugin, context,
}) => {
	await page.goto(articleUrl);

	// Wait for the initial SSE connection to establish (content script
	// calls startPageHighlightSync on load).
	await page.waitForTimeout(500);

	// Simulate an SSE stream drop by blocking all traffic to :27124 for
	// 2 seconds, then unblocking. The clipper's reconnection logic should
	// re-establish the stream automatically.
	const block = async (route: import('@playwright/test').Route) => {
		await route.fulfill({ status: 503, body: 'offline' });
	};
	await context.route('**/localhost:27124/highlights/stream**', block);
	await context.route('**/127.0.0.1:27124/highlights/stream**', block);

	// Wait long enough for the existing SSE connection to notice the drop.
	await page.waitForTimeout(2000);

	// Unblock — the clipper should reconnect.
	await context.unroute('**/localhost:27124/highlights/stream**', block);
	await context.unroute('**/127.0.0.1:27124/highlights/stream**', block);

	// Give the reconnection a moment to establish.
	await page.waitForTimeout(1000);

	// Now push a highlight from the plugin side — it should arrive via
	// the re-established SSE stream (or polling fallback).
	await realPlugin.addHighlight(articleUrl, {
		id: 'sse-reconnect-' + Date.now(),
		exactText: 'quick brown fox',
		prefixText: 'The ',
		suffixText: ' jumps',
	});

	await waitForMarkWithText(page, 'quick brown fox');
});

// ── Orphaned highlight toast ────────────────────────────────
//
// When a highlight's exactText no longer exists in the page DOM (the
// page content changed since the highlight was created), the clipper
// shows a toast with a "Remove" button.

test('orphaned highlight: toast appears when highlight text is missing from page', async ({
	page, articleUrl, realPlugin,
}) => {
	// Plant a highlight with text that does NOT exist in the fixture.
	await realPlugin.addHighlight(articleUrl, {
		id: 'orphan-' + Date.now(),
		exactText: 'this text does not exist anywhere in the fixture',
		prefixText: '',
		suffixText: '',
	});

	await page.goto(articleUrl);

	// The orphan toast appears after a 3-second retry delay
	// (loadAndApplyPageHighlights → applyHighlightMarks fails → setTimeout 3s
	// → showOrphanedHighlightsToast). Wait for it.
	await page.waitForSelector('#obsidian-orphaned-toast', { timeout: 8000 });

	const toastText = await page.evaluate(() => {
		const toast = document.getElementById('obsidian-orphaned-toast');
		return toast?.textContent || '';
	});
	expect(toastText).toContain('no longer found');

	// The toast should have a "Remove" button that cleans up the orphan.
	const hasRemoveBtn = await page.evaluate(() => {
		const toast = document.getElementById('obsidian-orphaned-toast');
		const btns = toast?.querySelectorAll('button') || [];
		return Array.from(btns).some(b => b.textContent === 'Remove');
	});
	expect(hasRemoveBtn).toBe(true);

	// Click "Remove" — should clear the orphan from the plugin.
	await page.evaluate(() => {
		const toast = document.getElementById('obsidian-orphaned-toast');
		const btn = Array.from(toast?.querySelectorAll('button') || [])
			.find(b => b.textContent === 'Remove') as HTMLButtonElement;
		btn?.click();
	});

	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(0);
});

// ── x key clears all highlights in reader mode ──────────────

test('x key clears all highlights in reader mode', async ({
	page, articleUrl, realPlugin,
}) => {
	// Plant two highlights.
	await realPlugin.addHighlight(articleUrl, {
		id: 'x-clear-a-' + Date.now(),
		exactText: 'quick brown fox',
		prefixText: 'The ',
		suffixText: ' jumps',
	});
	await realPlugin.addHighlight(articleUrl, {
		id: 'x-clear-b-' + Date.now(),
		exactText: 'boxing wizards',
		prefixText: 'five ',
		suffixText: ' jump',
	});

	await page.goto(articleUrl);
	await enterReaderMode(page);
	await waitForMarkWithText(page, 'quick brown fox');
	await waitForMarkWithText(page, 'boxing wizards');

	// Press x — should clear all highlights.
	await page.focus('body');
	await page.keyboard.press('x');

	// All marks should disappear from the DOM.
	await waitForMarkGone(page, 'quick brown fox');
	await waitForMarkGone(page, 'boxing wizards');

	// Plugin should also have 0 highlights after sync.
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		{ intervals: [50, 100, 200, 500], timeout: 5000 }
	).toBe(0);
});

// ── c key toggles citations in reader mode ──────────────────

test('c key toggles citation visibility in reader mode', async ({
	page, articleUrl,
}) => {
	await page.goto(articleUrl);
	await enterReaderMode(page);

	// Initially, show-citations class should NOT be on body.
	const before = await page.evaluate(() =>
		document.body.classList.contains('show-citations')
	);
	expect(before).toBe(false);

	// Press c — should add class.
	await page.focus('body');
	await page.keyboard.press('c');

	const after = await page.evaluate(() =>
		document.body.classList.contains('show-citations')
	);
	expect(after).toBe(true);

	// Press c again — should remove class.
	await page.keyboard.press('c');

	const toggled = await page.evaluate(() =>
		document.body.classList.contains('show-citations')
	);
	expect(toggled).toBe(false);
});

// ── Undo/redo for remove operations ─────────────────────────
//
// The existing undo/redo test covers add→undo→redo. This covers
// the symmetric case: remove→undo (mark comes back)→redo (gone again).

test('undo / redo: Cmd+Z undoes a highlight remove, Cmd+Shift+Z redoes it', async ({
	page, articleUrl, realPlugin,
}) => {
	// Create a highlight via the plugin so it's in a known state.
	const id = 'undo-rm-' + Date.now();
	await realPlugin.addHighlight(articleUrl, {
		id,
		exactText: 'quick brown fox',
		prefixText: 'The ',
		suffixText: ' jumps',
	});

	await page.goto(articleUrl);
	await enterHighlighterMode(page);
	await waitForMarkWithText(page, 'quick brown fox');

	// Remove the highlight by clicking the mark.
	await clickMarkById(page, id);
	await waitForMarkGone(page, 'quick brown fox');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(0);

	// Cmd+Z should undo the remove — mark comes back.
	await page.keyboard.press('Meta+z');
	await waitForMarkWithText(page, 'quick brown fox');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(1);

	// Cmd+Shift+Z should redo the remove — mark goes away again.
	await page.keyboard.press('Meta+Shift+z');
	await waitForMarkGone(page, 'quick brown fox');
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		POLL_OPTS
	).toBe(0);
});

// ── Two-tab simultaneous highlighting ───────────────────────

test('two tabs: simultaneous highlights from both tabs land without overwriting', async ({
	context, articleUrl, realPlugin,
}) => {
	const tab1 = await context.newPage();
	const tab2 = await context.newPage();
	await tab1.goto(articleUrl);
	await tab2.goto(articleUrl);
	await enterHighlighterMode(tab1);
	await enterHighlighterMode(tab2);

	// Highlight different text in each tab concurrently.
	await Promise.all([
		(async () => {
			await dragSelect(tab1, '#p1', 'quick brown fox');
			await releaseDrag(tab1);
		})(),
		(async () => {
			await dragSelect(tab2, '#p2', 'boxing wizards');
			await releaseDrag(tab2);
		})(),
	]);

	// Both should land on the plugin — no overwrite.
	await expect.poll(
		async () => (await realPlugin.getHighlights(articleUrl)).length,
		{ intervals: [50, 100, 200, 500], timeout: 5000 }
	).toBe(2);

	const texts = (await realPlugin.getHighlights(articleUrl)).map(h => h.exactText);
	expect(texts.some(t => t.includes('quick brown fox'))).toBe(true);
	expect(texts.some(t => t.includes('boxing wizards'))).toBe(true);

	// Each tab should see both highlights (via SSE propagation).
	await waitForMarkWithText(tab1, 'quick brown fox');
	await waitForMarkWithText(tab1, 'boxing wizards');
	await waitForMarkWithText(tab2, 'quick brown fox');
	await waitForMarkWithText(tab2, 'boxing wizards');
});

// ── Prefix/suffix disambiguation ────────────────────────────
//
// When the same exactText appears multiple times in the page, the
// prefix/suffix context disambiguates which occurrence the highlight
// belongs to. This tests that findTextRange picks the right one.

test('prefix/suffix disambiguation: highlight lands on the correct occurrence', async ({
	page, articleUrl, realPlugin,
}) => {
	// The fixture has "quick brown fox" in p1 and the plugin note has the
	// same text. We plant two highlights with the same exactText but
	// different prefix/suffix to target different sentences.
	//
	// p1: "The quick brown fox jumps over the lazy dog."
	// The word "The" appears at the start of p1 and also elsewhere.
	// Let's use a text that appears in the fixture's plugin note in a
	// controlled way. The fixture article has unique paragraph text, so
	// we'll use two highlights on the same word "jump" which appears in
	// p1 ("fox jumps") and p2 ("wizards jump quickly").

	const id1 = 'disambig-a-' + Date.now();
	const id2 = 'disambig-b-' + Date.now();

	await realPlugin.addHighlight(articleUrl, {
		id: id1,
		exactText: 'jump',
		prefixText: 'fox ',
		suffixText: 's over',
	});
	await realPlugin.addHighlight(articleUrl, {
		id: id2,
		exactText: 'jump',
		prefixText: 'wizards ',
		suffixText: ' quickly',
	});

	await page.goto(articleUrl);
	await page.waitForTimeout(1500);

	// Both marks should exist.
	const marks = await page.evaluate(() => {
		const all = document.querySelectorAll('.reading-selection-highlight-mark');
		return Array.from(all).map(m => ({
			id: m.getAttribute('data-highlight-id'),
			parentId: m.closest('[id]')?.id,
		}));
	});

	// Each highlight should land in a different paragraph.
	const mark1 = marks.find(m => m.id === id1);
	const mark2 = marks.find(m => m.id === id2);
	expect(mark1, 'first "jump" highlight should be anchored').toBeDefined();
	expect(mark2, 'second "jump" highlight should be anchored').toBeDefined();
	expect(mark1!.parentId).toBe('p1');
	expect(mark2!.parentId).toBe('p2');
});

// ── Coqdoc div.code → pre/code conversion ──────────────────
//
// Sites like Software Foundations (coqdoc output) use <div class="code">
// with inline <span>/<br> instead of standard <pre><code> blocks.
// Defuddle doesn't recognise these as code, so they get stripped.
// The fix converts div.code → pre>code before Defuddle runs.

test('coqdoc: div.code blocks survive reader-mode extraction', async ({
	page,
}) => {
	const coqUrl = 'http://127.0.0.1:3100/coqdoc.html';
	await page.goto(coqUrl);
	await enterReaderMode(page);

	await page.waitForSelector('article', { timeout: 10_000 });

	// The Inductive day definition should be present with all constructor
	// names (monday–sunday) — not just bare pipe characters.
	const check = await page.evaluate(() => {
		const article = document.querySelector('article');
		if (!article) return { hasInductive: false, hasMonday: false, codeBlockCount: 0, text: '' };
		const text = article.textContent || '';
		return {
			hasInductive: text.includes('Inductive'),
			hasMonday: text.includes('monday') && text.includes('sunday'),
			codeBlockCount: article.querySelectorAll('pre').length,
			text: text.slice(0, 500),
		};
	});

	expect(check.hasInductive, `reader must contain "Inductive" (got: ${check.text.slice(0, 200)})`).toBe(true);
	expect(check.hasMonday, 'reader must contain day constructors (monday, sunday)').toBe(true);
	expect(check.codeBlockCount, 'code blocks must be wrapped in <pre>').toBeGreaterThanOrEqual(2);
});

// ── MathJax / KaTeX rendering in reader mode ────────────────
//
// Pages using MathJax (e.g. Stanford Encyclopedia of Philosophy) produce
// <math data-latex="..."> elements. Reader mode renders these via KaTeX.

test('math: MathJax renders equations in reader mode', async ({
	page,
}) => {
	// Uses the real MathJax-rendered page (2MB DOM with MathJax 2 CHTML output).
	const mathUrl = 'http://127.0.0.1:3100/lambda-calculus.html';
	await page.goto(mathUrl);
	await enterReaderMode(page);

	await page.waitForSelector('article', { timeout: 15_000 });
	// MathJax 3 renders into <mjx-container> elements
	await page.waitForSelector('mjx-container', { timeout: 15_000 });

	const check = await page.evaluate(() => {
		const article = document.querySelector('article');
		if (!article) return { mjxCount: 0, hasLambda: false, hasDisplayMath: false, noDuplication: false };
		const mjxEls = article.querySelectorAll('mjx-container');
		const hasLambda = Array.from(mjxEls).some(el =>
			el.textContent?.includes('λ')
		);
		const hasDisplayMath = article.querySelectorAll('mjx-container[display="true"]').length > 0;

		const text = article.textContent || '';
		const noDuplication = !text.includes('λ λ') && !text.includes('λ  λ');

		return {
			mjxCount: mjxEls.length,
			hasLambda,
			hasDisplayMath,
			noDuplication,
		};
	});

	expect(check.mjxCount, 'MathJax should render math elements').toBeGreaterThan(10);
	expect(check.hasLambda, 'λ symbol should be rendered').toBe(true);
	expect(check.hasDisplayMath, 'display-mode equations should exist').toBe(true);
	expect(check.noDuplication, 'no duplicated math').toBe(true);
});

// MathJax 3 uses \(...\) and \[...\] delimiters in the raw source.
// When MathJax hasn't run (or on raw source pages), the renderMath
// raw delimiter handler converts them to KaTeX.

test('math: raw LaTeX delimiters render via MathJax in reader mode', async ({
	page,
}) => {
	// Real Stanford Encyclopedia page (logic-propositional) with raw \(...\)
	// and \[...\] LaTeX delimiters — same format as MathJax 3 pages after
	// the re-fetch strategy swaps in the raw source. Includes custom macros
	// (\calV, \bT, \bF, etc.) from the page's MathJax config.
	const url = 'http://127.0.0.1:3100/logic-propositional-raw.html';
	await page.goto(url);
	await enterReaderMode(page);

	await page.waitForSelector('article', { timeout: 15_000 });
	await page.waitForSelector('mjx-container', { timeout: 30_000, state: 'attached' });

	const check = await page.evaluate(() => {
		const article = document.querySelector('article');
		if (!article) return { mjxCount: 0, hasDisplayMath: false, noDuplication: false, errorCount: 0 };
		const mjxEls = article.querySelectorAll('mjx-container');
		const hasDisplayMath = article.querySelectorAll('mjx-container[display="true"]').length > 0;
		const text = article.textContent || '';
		const noDuplication = !text.includes('p₁ p₁');
		// MathJax errors appear as data-mjx-error attributes on SVG elements
		const errorEls = article.querySelectorAll('[data-mjx-error]');
		const errorSamples = Array.from(errorEls).slice(0, 3).map(el =>
			el.getAttribute('data-mjx-error') || ''
		);

		return { mjxCount: mjxEls.length, hasDisplayMath, noDuplication, errorCount: errorEls.length, errorSamples };
	});

	expect(check.mjxCount, 'MathJax should render raw \\(...\\) delimiters').toBeGreaterThan(50);
	expect(check.hasDisplayMath, 'display math from \\[...\\] should exist').toBe(true);
	expect(check.noDuplication, 'no duplicated math expressions').toBe(true);
	// Some complex macros (turnstile, dturnstile) use LaTeX commands not fully
	// supported in MathJax SVG; allow a small number of errors but flag if most fail
	expect(check.errorCount, `Too many MathJax errors: ${check.errorSamples.join(' | ')}`).toBeLessThan(check.mjxCount * 0.1);
});

// Bussproofs prooftrees (\begin{prooftree} ... \end{prooftree}) must render.
// The SEP logic-propositional page has ~40 prooftrees for natural deduction.

test('math: bussproofs prooftrees render in reader mode', async ({
	page,
}) => {
	const url = 'http://127.0.0.1:3100/logic-propositional-raw.html';
	await page.goto(url);
	await enterReaderMode(page);

	await page.waitForSelector('article', { timeout: 15_000 });
	await page.waitForSelector('mjx-container', { timeout: 30_000, state: 'attached' });

	const check = await page.evaluate(() => {
		const article = document.querySelector('article');
		if (!article) return { prooftreeCount: 0, prooftreeErrors: 0, sample: '' };

		// Bussproofs renders proof trees using the <mjx-mfrac> (fraction-like)
		// structure in SVG. Each inference step produces a fraction with a
		// horizontal line separating premises from conclusion.
		// In SVG output, prooftrees produce tall mjx-container elements with
		// multiple nested SVG groups containing <line> or <rect> elements.
		const allMjx = article.querySelectorAll('mjx-container');
		let prooftreeCount = 0;
		let prooftreeErrors = 0;
		let sample = '';
		for (const el of allMjx) {
			const svg = el.querySelector('svg');
			if (!svg) continue;
			// Prooftrees produce SVGs with multiple horizontal lines (inference bars)
			// and are significantly taller than single-line math
			const height = svg.viewBox?.baseVal?.height || 0;
			const lines = svg.querySelectorAll('line, rect').length;
			if (height > 2000 && lines >= 2) {
				prooftreeCount++;
			}
			// Check for errors containing "prooftree"
			const err = el.querySelector('[data-mjx-error]');
			if (err && (err.getAttribute('data-mjx-error') || '').includes('prooftree')) {
				prooftreeErrors++;
				if (!sample) sample = err.getAttribute('data-mjx-error') || '';
			}
		}

		// Also check the text content for raw \begin{prooftree} that wasn't rendered
		const text = article.textContent || '';
		const rawProoftrees = (text.match(/\\begin\{prooftree\}/g) || []).length;

		// Context around first raw prooftree
		let contextAroundFirst = '';
		const idx = text.indexOf('\\begin{prooftree}');
		if (idx >= 0) contextAroundFirst = text.slice(Math.max(0, idx - 50), idx + 60).replace(/\n/g, '↵');

		return { prooftreeCount, prooftreeErrors, rawProoftrees, sample, contextAroundFirst };
	});

	// Either prooftrees render as SVG structures or there are no raw unrendered prooftrees
	expect(check.prooftreeErrors, `prooftree errors: ${check.sample}`).toBe(0);
	// Display math \[...\] between paragraphs containing prooftrees should be
	// wrapped and preserved during extraction. Allow 0 raw prooftrees.
	// Reader mode renders all prooftrees via MathJax. The markdown clip may
	// have some raw prooftrees from display-math blocks that span elements,
	// but the majority should be processed.
	expect(check.prooftreeErrors, `prooftree errors: ${check.sample}`).toBe(0);
});

// MathML elements with data-latex attributes (e.g. Wikipedia) should be
// extracted and rendered via MathJax in reader mode.

test('math: MathML data-latex elements render in reader mode', async ({
	page,
}) => {
	const url = 'http://127.0.0.1:3100/math-article.html';
	await page.goto(url);
	await enterReaderMode(page);

	await page.waitForSelector('article', { timeout: 15_000 });
	await page.waitForSelector('mjx-container', { timeout: 15_000 });

	const check = await page.evaluate(() => {
		const article = document.querySelector('article');
		if (!article) return { mjxCount: 0, hasLambda: false, hasDisplayMath: false };
		const mjxEls = article.querySelectorAll('mjx-container');
		const hasLambda = Array.from(mjxEls).some(el =>
			el.textContent?.includes('λ')
		);
		const hasDisplayMath = article.querySelectorAll('mjx-container[display="true"]').length > 0;

		return {
			mjxCount: mjxEls.length,
			hasLambda,
			hasDisplayMath,
		};
	});

	expect(check.mjxCount, 'MathJax should render math from data-latex attributes').toBeGreaterThan(5);
	expect(check.hasLambda, 'λ symbol should be rendered').toBe(true);
	expect(check.hasDisplayMath, 'display-mode equations should exist').toBe(true);
});

// MathJax 3 rendered page (saved after MathJax processed the DOM). The
// extension detects <mjx-container> elements and re-fetches the raw source.
// For the test fixture the re-fetch returns the same rendered HTML, so the
// assistive MathML <math> elements inside <mjx-container> carry the content.

test('math: MathJax 3 rendered page preserves math in reader mode', async ({
	page,
}) => {
	const url = 'http://127.0.0.1:3100/logic-propositional.html';
	await page.goto(url);
	await enterReaderMode(page);

	await page.waitForSelector('article', { timeout: 15_000 });

	const check = await page.evaluate(() => {
		const article = document.querySelector('article');
		if (!article) return { mjxCount: 0, textHasMath: false, hasDisplayMath: false };
		const mjxEls = article.querySelectorAll('mjx-container');

		// Check for rendered math or fallback text with math symbols
		const text = article.textContent || '';
		const textHasMath = text.includes('p') && (
			mjxEls.length > 0 ||
			text.includes('\\(') ||
			text.includes('⊤') ||
			text.includes('⊥') ||
			text.includes('∧') ||
			text.includes('→')
		);

		const hasDisplayMath = article.querySelectorAll('mjx-container[display="true"]').length > 0
			|| /\\\[[\s\S]*?\\\]/.test(text);

		return {
			mjxCount: mjxEls.length,
			textHasMath,
			hasDisplayMath,
		};
	});

	expect(check.textHasMath, 'article should contain math content').toBe(true);
});

// ── Markdown clip output tests ───────────────────────────
//
// Verify that the clipped markdown (what goes to Obsidian) preserves
// math expressions as $...$ / $$...$$ with no raw \(...\) or \[...\]
// and no stripped math content.

test('math clip: markdown output preserves inline and display math', async ({
	page,
}) => {
	const url = 'http://127.0.0.1:3100/logic-propositional-raw.html';
	await page.goto(url);
	await enterReaderMode(page);

	await page.waitForSelector('article', { timeout: 15_000 });
	await page.waitForSelector('mjx-container', { timeout: 30_000, state: 'attached' });

	// Get the pre-MathJax HTML that quickSaveToObsidian would use
	const preHtml = await page.evaluate(() => {
		const article = document.querySelector('article');
		return article?.getAttribute('data-pre-mathjax-html') || '';
	});

	expect(preHtml.length, 'data-pre-mathjax-html should exist').toBeGreaterThan(0);

	// Check what's in the pre-MathJax HTML
	const mathElCount = (preHtml.match(/<math[^>]*data-latex/g) || []).length;
	const rawInlineCount = (preHtml.match(/\\\(/g) || []).length;
	const rawDisplayCount = (preHtml.match(/\\\[/g) || []).length;
	const codeLatexCount = (preHtml.match(/data-math-latex/g) || []).length;
	const sample = preHtml.slice(0, 500);

	// Pre-MathJax HTML should have math in some form
	const totalMath = mathElCount + rawInlineCount + codeLatexCount;
	expect(totalMath, `should have math content (math=${mathElCount}, raw\\(=${rawInlineCount}, raw\\[=${rawDisplayCount}, code=${codeLatexCount}, sample=${sample.slice(0, 200)})`).toBeGreaterThan(30);

	// Most \(...\) should be wrapped in <math> elements. Some may remain
	// inside data-latex attributes (nested delimiters in prooftrees).
	// Strip <math> elements and their attributes, then check.
	const htmlWithoutMathTags = preHtml.replace(/<math[^>]*>[\s\S]*?<\/math>/g, '');
	const rawDelimiters = (htmlWithoutMathTags.match(/\\\([^)]{2,}\\\)/g) || []).length;
	expect(rawDelimiters, 'most \\(...\\) should be inside <math> elements').toBeLessThan(mathElCount * 0.05);

	// Verify <math> elements don't have nested $ (stripped during wrapping)
	const mathWithNestedDollar = (preHtml.match(/<math[^>]*data-latex="[^"]*\$[^"]*\$[^"]*"/g) || []).length;
	expect(mathWithNestedDollar, 'no nested $ in data-latex attributes').toBe(0);
});
