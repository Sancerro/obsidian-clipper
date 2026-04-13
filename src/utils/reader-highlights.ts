/**
 * Reader-mode highlight system.
 * Handles selection → mark wrapping, text anchoring, and local persistence.
 * Shared by both Obsidian-linked notes and regular reader-mode pages.
 */
import browser from './browser-polyfill';
import { getPluginErrorMessage, pluginFetch } from './plugin-url';
import { logHandledError } from './error-utils';
import Defuddle from 'defuddle';
import { createMarkdownContent as defuddleToMarkdown, wrapRawLatexDelimiters } from 'defuddle/full';

// ── Types ────────────────────────────────────────────────

export interface ReaderHighlightData {
	id: string;
	exactText: string;
	prefixText: string;
	suffixText: string;
}

interface MarkClickHandlerOptions {
	canRemove?: () => boolean;
	onRemove: (highlightId: string) => void;
	useCapture?: boolean;
}

const PENDING_REMOTE_REMOVALS_KEY = 'readerPendingRemoteRemovals';

// ── Content root detection ───────────────────────────────

// Order matters: most specific content containers first, generic wrappers last.
const CONTENT_SELECTORS = [
	'article',                    // reader mode + semantic HTML
	'.mw-parser-output',          // Wikipedia
	'#mw-content-text',           // Wikipedia fallback
	'.entry-content',             // WordPress standard
	'.wp-block-post-content',     // WordPress FSE themes
	'.post-content',              // common blog pattern
	'.article-content',           // news sites
	'.article-body',              // news sites
	'.post-body',                 // Blogger
	'#content .post',             // common pattern
	'main',                       // semantic main (broad — can include nav/footer in FSE)
	'[role="main"]',              // ARIA main
];

function findContentRoot(): Element {
	for (const sel of CONTENT_SELECTORS) {
		const el = document.querySelector(sel);
		if (el) return el;
	}
	return document.body;
}

function normalizeCurrentUrl(): string {
	return window.location.href.replace(/#:~:text=[^&]+(&|$)/, '');
}

// ── Highlight data cache + undo/redo history ─────────────
//
// The legacy XPath system in highlighter.ts has its own history stack
// operating on the `highlights` array. That stack is now unreachable for
// text-anchor highlights, which are the only ones any user actually
// creates. This module owns a parallel stack + cache for the text-anchor
// flow: every time a highlight enters the DOM (user add, SSE load,
// reader-mode bake-in) we cache its data keyed by id; every add/remove
// records an op; undo/redo reverses the op through the same pipeline the
// original user action went through (DOM mutation + local storage +
// plugin POST).

const highlightCache = new Map<string, ReaderHighlightData>();

export function cacheHighlight(h: ReaderHighlightData): void {
	highlightCache.set(h.id, h);
}

export function cacheHighlights(list: ReaderHighlightData[]): void {
	for (const h of list) highlightCache.set(h.id, h);
}

export function getCachedHighlight(id: string): ReaderHighlightData | undefined {
	return highlightCache.get(id);
}

export function uncacheHighlight(id: string): void {
	highlightCache.delete(id);
}

interface HighlightOp {
	type: 'add' | 'remove';
	url: string;
	highlight: ReaderHighlightData;
}

const MAX_HIGHLIGHT_HISTORY = 50;
let highlightHistory: HighlightOp[] = [];
let highlightRedoStack: HighlightOp[] = [];

// IDs the UI has removed this session. Used by loadAndApplyPageHighlights
// to prevent the reconciliation path from re-uploading a local-only
// highlight that was just removed — browser.storage.local writes are
// async-enqueued, so there's a window where local storage still looks
// like it has the highlight even after removeReaderHighlight() returns.
const locallyRemovedIds = new Set<string>();

// IDs whose /highlights/add POST is in flight right now. During that
// window, local storage already has the highlight (via saveReaderHighlight)
// but the plugin doesn't yet. The reconciliation path would see it as
// local-only and double-POST it; this set tells reconciliation to skip.
const inFlightAddIds = new Set<string>();

function markLocallyRemoved(id: string): void {
	locallyRemovedIds.add(id);
}

function unmarkLocallyRemoved(id: string): void {
	locallyRemovedIds.delete(id);
}

/** Record an add/remove as an undoable op. Clears the redo stack. */
export function recordHighlightOp(op: HighlightOp): void {
	highlightHistory.push(op);
	if (highlightHistory.length > MAX_HIGHLIGHT_HISTORY) {
		highlightHistory.shift();
	}
	highlightRedoStack = [];
}

export function canUndoReaderHighlight(): boolean {
	return highlightHistory.length > 0;
}

export function canRedoReaderHighlight(): boolean {
	return highlightRedoStack.length > 0;
}

/** Re-apply an add: find the text anchor, wrap, save locally, POST. */
async function replayAdd(url: string, h: ReaderHighlightData): Promise<void> {
	// Clear any tombstone so reconciliation doesn't filter this out.
	unmarkLocallyRemoved(h.id);
	// Guard against the reconciliation double-POST: while this POST is
	// in flight, local storage has the highlight but the plugin doesn't,
	// so loadAndApplyPageHighlights would try to push it up again.
	inFlightAddIds.add(h.id);
	const root = findContentRoot();
	const fullText = getCleanTextContent(root);
	const range = findTextRange(root, fullText, h.exactText, h.prefixText, h.suffixText);
	if (range) {
		wrapRangeInMarks(range, 'reading-selection-highlight-mark', h.id);
	}
	saveReaderHighlight(url, h);
	cacheHighlight(h);
	try {
		const res = await pluginFetch('/highlights/add', {
			method: 'POST',
			body: { url, highlight: h },
		});
		if (!res.ok) {
			logHandledError('ReaderHighlightUndoAdd', res.error || 'Failed to re-add highlight', {
				url,
				highlightId: h.id,
				errorType: res.errorType,
			});
		}
	} catch (e) {
		logHandledError('ReaderHighlightUndoAdd', e, { url, highlightId: h.id });
	} finally {
		inFlightAddIds.delete(h.id);
	}
}

/** Replay a remove: unwrap marks, clear local, POST remove. */
async function replayRemove(url: string, h: ReaderHighlightData): Promise<void> {
	// Synchronously mark as removed so the async enqueue race doesn't
	// re-reconcile this highlight back to the plugin.
	markLocallyRemoved(h.id);
	document
		.querySelectorAll(`.reading-selection-highlight-mark[data-highlight-id="${h.id}"]`)
		.forEach(m => m.replaceWith(...Array.from(m.childNodes)));
	removeReaderHighlight(url, h.id);
	uncacheHighlight(h.id);
	try {
		const res = await pluginFetch('/highlights/remove', {
			method: 'POST',
			body: { url, highlightId: h.id },
		});
		if (!res.ok) {
			queueRemoteHighlightRemoval(url, h.id);
			logHandledError('ReaderHighlightUndoRemove', res.error || 'Failed to remove highlight', {
				url,
				highlightId: h.id,
				errorType: res.errorType,
			});
		}
	} catch (e) {
		logHandledError('ReaderHighlightUndoRemove', e, { url, highlightId: h.id });
	}
}

/** Undo the most recent highlight add/remove. Returns true if it did work. */
export async function undoReaderHighlight(): Promise<boolean> {
	const op = highlightHistory.pop();
	if (!op) return false;
	highlightRedoStack.push(op);
	if (op.type === 'add') {
		await replayRemove(op.url, op.highlight);
	} else {
		await replayAdd(op.url, op.highlight);
	}
	return true;
}

/** Redo the most recently undone highlight op. Returns true if it did work. */
export async function redoReaderHighlight(): Promise<boolean> {
	const op = highlightRedoStack.pop();
	if (!op) return false;
	highlightHistory.push(op);
	if (op.type === 'add') {
		await replayAdd(op.url, op.highlight);
	} else {
		await replayRemove(op.url, op.highlight);
	}
	return true;
}

// ── Selection → Highlight ────────────────────────────────

export function handleReaderModeHighlight(selection: Selection): void {
	const range = selection.getRangeAt(0);
	if (selection.toString().trim() === '') {
		selection.removeAllRanges();
		return;
	}

	const root = findContentRoot();
	if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
		selection.removeAllRanges();
		return;
	}

	clampRangeToBlock(range);
	expandRangeToWordBoundaries(range);

	const exactText = getRangeCleanText(range);
	if (!exactText) {
		selection.removeAllRanges();
		return;
	}

	const url = window.location.href.replace(/#:~:text=[^&]+(&|$)/, '');

	// Merge with any overlapping existing highlights.
	//
	// Three-step dance to keep the merged range valid across the unwrap:
	//   (1) Capture the *expanded* start/end as raw (text-node, offset) tuples,
	//       NOT as `range.setStart/setEnd` calls. The DOM Range mutation rules
	//       kick in during `replaceWith(...childNodes)` below: when the mark
	//       is removed, any range boundary whose container is an inclusive
	//       descendant of the removed node gets collapsed to (parent, index)
	//       — even though the descendant text node is being reparented
	//       immediately after, not actually destroyed. So we can't hold the
	//       boundaries on the live Range through the unwrap.
	//   (2) Unwrap the marks.
	//   (3) Reconstruct the range from the raw tuples, which still point at
	//       the (now-reparented) text nodes.
	const overlappingIds = findOverlappingHighlightIds(range);
	if (overlappingIds.length > 0) {
		// (1) Compute merged boundaries.
		let startNode: Node = range.startContainer;
		let startOffset: number = range.startOffset;
		let endNode: Node = range.endContainer;
		let endOffset: number = range.endOffset;

		for (const oid of overlappingIds) {
			const marks = root.querySelectorAll(`.reading-selection-highlight-mark[data-highlight-id="${oid}"]`);
			for (let i = 0; i < marks.length; i++) {
				const mark = marks[i];
				const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
				let firstText: Text | null = null;
				let lastText: Text | null = null;
				let textNode: Node | null;
				while ((textNode = walker.nextNode())) {
					if (!firstText) firstText = textNode as Text;
					lastText = textNode as Text;
				}
				if (!firstText || !lastText) continue;

				// Compare mark's text-level start to the current merged start
				// via a temporary range.
				const cmpStart = document.createRange();
				cmpStart.setStart(firstText, 0);
				cmpStart.setEnd(startNode, startOffset);
				// If (firstText, 0) < (startNode, startOffset), the mark's start
				// is earlier — expand our start to cover it.
				if (!cmpStart.collapsed) {
					startNode = firstText;
					startOffset = 0;
				}

				const cmpEnd = document.createRange();
				cmpEnd.setStart(endNode, endOffset);
				cmpEnd.setEnd(lastText, lastText.length);
				// If (endNode, endOffset) < (lastText, lastText.length), the
				// mark's end is later — expand our end to cover it.
				if (!cmpEnd.collapsed) {
					endNode = lastText;
					endOffset = lastText.length;
				}
			}
		}

		// (2) Remove old marks from DOM.
		for (const oid of overlappingIds) {
			root.querySelectorAll(`.reading-selection-highlight-mark[data-highlight-id="${oid}"]`).forEach(m => {
				m.replaceWith(...Array.from(m.childNodes));
			});
		}

		// (3) Rebuild the range from the captured tuples. The text nodes are
		// still valid — they were reparented, not destroyed — so setStart/setEnd
		// lands on the same characters we expanded to.
		range.setStart(startNode, startOffset);
		range.setEnd(endNode, endOffset);
		// Remove old highlights from storage + plugin
		for (const oid of overlappingIds) {
			removeReaderHighlight(url, oid);
			pluginFetch('/highlights/remove', {
				method: 'POST',
				body: { url, highlightId: oid }
			}).then(res => {
				if (!res.ok) {
					queueRemoteHighlightRemoval(url, oid);
					logHandledError('ReaderHighlightMergeRemove', res.error || 'Failed to remove merged highlight fragment', {
						url,
						highlightId: oid,
						errorType: res.errorType,
						status: res.status,
					});
				}
			});
		}
		// Re-expand to word boundaries after merge
		expandRangeToWordBoundaries(range);
	}

	const mergedText = getRangeCleanText(range);
	if (!mergedText) {
		selection.removeAllRanges();
		return;
	}

	const fullText = getCleanTextContent(root);
	const startOffset = getCleanTextOffset(root, range.startContainer, range.startOffset);
	const endOffset = getCleanTextOffset(root, range.endContainer, range.endOffset);
	const prefixText = fullText.slice(Math.max(0, startOffset - 40), startOffset);
	const suffixText = fullText.slice(endOffset, endOffset + 40);

	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	wrapRangeInMarks(range, 'reading-selection-highlight-mark', id);
	selection.removeAllRanges();

	document.dispatchEvent(new CustomEvent('obsidian-optimistic-add', { detail: { id } }));

	const highlightData = { id, exactText: mergedText, prefixText, suffixText };
	saveReaderHighlight(url, highlightData);
	cacheHighlight(highlightData);
	recordHighlightOp({ type: 'add', url, highlight: highlightData });

	// Guard against reconciliation-double-POST: local already has this
	// highlight, plugin doesn't yet. A SSE refresh triggered by an earlier
	// op could otherwise push it up before our POST lands.
	inFlightAddIds.add(id);
	pluginFetch('/highlights/add', {
		method: 'POST',
		body: { url, highlight: highlightData }
	}).then(res => {
		inFlightAddIds.delete(id);
		if (!res.ok) {
			logHandledError('ReaderHighlightAdd', res.error || 'Failed to sync highlight add', {
				url,
				errorType: res.errorType,
				status: res.status,
			});
			showPluginOfflineToast(getPluginErrorMessage('sync highlights', res));
			return;
		}
		// If this URL isn't linked to a note yet, auto-clip the page on first highlight
		const data = res.data as { notePath?: string | null };
		if (!data?.notePath) {
			autoClipPage(url).catch(err => {
				logHandledError('AutoClip', err, { url });
			});
		}
	}, () => {
		inFlightAddIds.delete(id);
	});
}

/**
 * Auto-clip the current page to Obsidian on the first highlight.
 *
 * Mirrors the S-key shortcut (`Reader.quickSaveToObsidian` in `reader.ts`)
 * exactly when reader mode is active: grabs the already-extracted `<article>`
 * element, runs its `innerHTML` through `createMarkdownContent` directly, and
 * POSTs to `/clip` with the same frontmatter shape (title / source / created /
 * tags: clippings). **No Defuddle parse call** — reader mode already cleaned
 * the article, re-parsing the whole document with Defuddle is redundant AND
 * can throw on pages where `parseAsync()` succeeded for reader mode but sync
 * `.parse()` fails (the ngrok.com/blog/* class of bug).
 *
 * On non-reader pages (no `<article>` available), fall back to the Defuddle
 * extract path via `extractPageMarkdown`, which itself uses the parseAsync +
 * sync fallback pattern.
 */
let autoClipInFlight = false;
export async function autoClipPage(url: string): Promise<void> {
	if (autoClipInFlight) return;
	// Already linked to a note — nothing to auto-clip.
	if (document.documentElement.dataset.obsidianNotePath) return;
	autoClipInFlight = true;
	try {
		// Strip any text-fragment directive so the note's `source` is a clean URL
		// and the plugin's URL index matches what reader mode stores.
		const cleanUrl = url.replace(/#:~:text=[^&]+(&|$)/, '');

		const isReaderActive = document.documentElement.classList.contains('obsidian-reader-active');
		const article = isReaderActive ? document.querySelector('article') : null;

		let title: string;
		let markdown: string;

		if (article) {
			// Reader-mode path: mirrors quickSaveToObsidian. Use pre-MathJax HTML
			// (has code[data-math-latex] placeholders) and prepend macro definitions.
			const rawTitle = document.querySelector('h1')?.textContent?.trim() || document.title || 'Untitled';
			title = rawTitle;
			const rawHtml = article.getAttribute('data-pre-mathjax-html') || article.innerHTML;
			const tempDoc = new DOMParser().parseFromString(`<article>${rawHtml}</article>`, 'text/html');
			const tempArt = tempDoc.querySelector('article');
			if (tempArt) wrapRawLatexDelimiters(tempArt, tempDoc);
			markdown = defuddleToMarkdown(tempArt?.innerHTML || rawHtml, cleanUrl);

			// Prepend \newcommand definitions for page-specific macros
			const macroAttr = document.documentElement.getAttribute('data-math-macros');
			if (macroAttr) {
				try {
					const macros = JSON.parse(macroAttr) as Record<string, string | [string, number]>;
					const defs = Object.entries(macros).map(([name, val]) => {
						const n = name.startsWith('\\') ? name : `\\${name}`;
						if (Array.isArray(val)) return `\\newcommand{${n}}[${val[1]}]{${val[0]}}`;
						return `\\newcommand{${n}}{${val}}`;
					}).join('\n');
					if (defs) markdown = `$$\n${defs}\n$$\n\n${markdown}`;
				} catch {}
			}
		} else {
			// Non-reader fallback: run Defuddle directly (we're already in the
			// content script context). Using runtime.sendMessage won't work —
			// it goes to the background script which has no handler for
			// extractPageMarkdown. Static imports are used instead of dynamic
			// to avoid code-split chunks that content scripts can't load.
			const defuddle = new Defuddle(document, { url: document.URL });
			let timerId: ReturnType<typeof setTimeout>;
			const parseTimeout = new Promise<never>((_, reject) => {
				timerId = setTimeout(() => reject(new Error('parseAsync timeout')), 8000);
			});
			const defuddled = await Promise.race([defuddle.parseAsync(), parseTimeout])
				.catch(() => defuddle.parse())
				.finally(() => clearTimeout(timerId!));
			markdown = defuddleToMarkdown(defuddled.content, cleanUrl);
			title = defuddled.title || document.title || 'Untitled';
		}

		// Read author/domain stored by reader mode for folder organization.
		// On raw pages (no reader mode), fall back to extracting domain from URL.
		const author = document.documentElement.dataset.readerAuthor || '';
		let domain = document.documentElement.dataset.readerDomain || '';
		if (!domain) {
			try { domain = new URL(cleanUrl).hostname.replace(/^www\./, ''); } catch {}
		}

		// Organize into subfolders: author if available, domain as fallback.
		const subfolder = (author || domain).replace(/[\\/:*?"<>|]/g, '-').trim();
		const savePath = subfolder ? `Clippings/${subfolder}` : 'Clippings';

		// Sanitize title the same way quickSave does (character set + 200-char cap).
		const sanitizedTitle = title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 200).trim() || 'Untitled';
		const created = new Date().toISOString().split('T')[0];
		const frontmatterLines = [
			'---',
			`title: "${sanitizedTitle.replace(/"/g, '\\"')}"`,
			`source: "${cleanUrl}"`,
		];
		if (author) frontmatterLines.push(`author: "${author.replace(/"/g, '\\"')}"`);
		frontmatterLines.push(
			`created: ${created}`,
			'tags:',
			'  - clippings',
			'---',
		);
		const fileContent = [...frontmatterLines, '', markdown].join('\n');

		const clipRes = await pluginFetch('/clip', {
			method: 'POST',
			body: {
				fileContent,
				noteName: sanitizedTitle,
				path: savePath,
				sourceUrl: cleanUrl,
				behavior: 'create',
			}
		});
		if (!clipRes.ok) {
			logHandledError('AutoClip', clipRes.error || 'Plugin /clip failed', { url: cleanUrl, status: clipRes.status });
			showReaderToast('Could not save to Obsidian', true);
			return;
		}
		// Mirror quickSave: mark the document as linked so subsequent highlight
		// posts don't re-trigger auto-clip, and the S-key's "already saved"
		// guard fires if the user presses it after the auto-clip landed.
		const data = clipRes.data as { filePath?: string };
		if (data?.filePath) {
			document.documentElement.setAttribute('data-obsidian-note-path', data.filePath);
		}
		showReaderToast('Saved to Obsidian');
	} finally {
		autoClipInFlight = false;
	}
}

// ── Text extraction (skipping <sup> citation noise) ─────

/** Get textContent of an element, skipping citation <sup> descendants. */
export function getCleanTextContent(el: Element): string {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			return isInsideCitationSup(node, el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
		}
	});
	let text = '';
	while (walker.nextNode()) {
		text += walker.currentNode.textContent || '';
	}
	return text;
}

/** Get text content of a range, skipping citation <sup> descendants only. */
function getRangeCleanText(range: Range): string {
	const frag = range.cloneContents();
	const sups = frag.querySelectorAll('sup');
	for (let i = 0; i < sups.length; i++) {
		const s = sups[i];
		if (s.classList.contains('reference') || s.classList.contains('footnote-ref') ||
			(s.id && (s.id.startsWith('fnref') || s.id.startsWith('cite_ref')))) {
			s.remove();
		}
	}
	return (frag.textContent || '').trim();
}

/** Calculate text offset within a container, skipping <sup> descendants. */
function getCleanTextOffset(container: Element, targetNode: Node, targetOffset: number): number {
	// Resolve element nodes to text nodes
	if (targetNode.nodeType === Node.ELEMENT_NODE) {
		const children = targetNode.childNodes;
		if (targetOffset < children.length) {
			targetNode = children[targetOffset];
			targetOffset = 0;
			if (targetNode.nodeType !== Node.TEXT_NODE) {
				const w = document.createTreeWalker(targetNode, NodeFilter.SHOW_TEXT);
				const first = w.nextNode();
				if (first) { targetNode = first; targetOffset = 0; }
			}
		} else {
			const w = document.createTreeWalker(targetNode, NodeFilter.SHOW_TEXT);
			let last: Node | null = null;
			while (w.nextNode()) { last = w.currentNode; }
			if (last) { targetNode = last; targetOffset = last.textContent?.length || 0; }
		}
	}

	// If target is inside a citation sup, snap offset to boundary
	const insideCite = isInsideCitationSup(targetNode, container);

	let offset = 0;
	const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	let n: Node | null;
	while ((n = tw.nextNode())) {
		if (isInsideCitationSup(n, container)) {
			if (insideCite && n === targetNode) return offset;
			continue;
		}
		if (n === targetNode) return offset + targetOffset;
		offset += (n.textContent?.length || 0);
	}
	return offset;
}

// ── Overlap detection ───────────────────────────────────

function findOverlappingHighlightIds(range: Range): string[] {
	const ids = new Set<string>();
	const marks = document.querySelectorAll('.reading-selection-highlight-mark');
	for (let i = 0; i < marks.length; i++) {
		const mark = marks[i] as HTMLElement;
		if (range.intersectsNode(mark) && mark.dataset.highlightId) {
			ids.add(mark.dataset.highlightId);
		}
	}
	return Array.from(ids);
}

// ── Range manipulation ───────────────────────────────────

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'FIGCAPTION', 'DT', 'DD']);

function clampRangeToBlock(range: Range): void {
	let block: HTMLElement | null = null;
	let node: Node | null = range.startContainer;
	while (node && node !== document.body) {
		if (node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName)) {
			block = node;
			break;
		}
		node = node.parentNode;
	}
	if (!block) return;

	if (!block.contains(range.endContainer)) {
		const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
		let lastText: Text | null = null;
		let current: Node | null;
		while ((current = walker.nextNode())) {
			lastText = current as Text;
		}
		if (lastText) {
			range.setEnd(lastText, lastText.length);
		}
	}
}

function expandRangeToWordBoundaries(range: Range): void {
	const startNode = range.startContainer;
	if (startNode.nodeType === Node.TEXT_NODE) {
		const text = startNode.textContent || '';
		let offset = range.startOffset;
		while (offset < text.length && /\s/.test(text[offset])) offset++;
		while (offset > 0 && !/\s/.test(text[offset - 1])) offset--;
		range.setStart(startNode, offset);
	}

	const endNode = range.endContainer;
	if (endNode.nodeType === Node.TEXT_NODE) {
		const text = endNode.textContent || '';
		let offset = range.endOffset;
		while (offset > 0 && /\s/.test(text[offset - 1])) offset--;
		while (offset < text.length && !/\s/.test(text[offset])) offset++;
		range.setEnd(endNode, offset);

		// If we hit the end of this text node, check if the next sibling
		// text node starts with sentence-ending punctuation (e.g. the period
		// is outside a <span>: "<span>sunday</span>.").
		if (offset === text.length) {
			let next: Node | null = endNode.nextSibling;
			// Skip empty text nodes and inline elements to find punctuation
			while (next && next.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has((next as Element).tagName)) {
				next = next.firstChild;
			}
			if (next && next.nodeType === Node.TEXT_NODE) {
				const nextText = next.textContent || '';
				let puncEnd = 0;
				while (puncEnd < nextText.length && /[.!?;:,)}\]'"""''–—]/.test(nextText[puncEnd])) puncEnd++;
				if (puncEnd > 0) {
					range.setEnd(next, puncEnd);
				}
			}
		}
	}
}

// ── Mark wrapping ────────────────────────────────────────

const INLINE_TAGS = new Set(['EM', 'I', 'STRONG', 'B', 'A', 'SPAN', 'CODE', 'SUB', 'SUP', 'MARK', 'U', 'S', 'SMALL', 'ABBR', 'CITE', 'DFN', 'KBD', 'SAMP', 'VAR', 'TIME', 'Q']);
function isInlineElement(el: HTMLElement): boolean {
	return INLINE_TAGS.has(el.tagName);
}

export function wrapRangeInMarks(range: Range, className: string, id: string): void {
	const walker = document.createTreeWalker(
		range.commonAncestorContainer.nodeType === Node.TEXT_NODE
			? range.commonAncestorContainer.parentElement!
			: range.commonAncestorContainer,
		NodeFilter.SHOW_TEXT
	);
	const textNodes: Text[] = [];
	let node: Node | null;
	const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
		? range.commonAncestorContainer.parentElement!
		: range.commonAncestorContainer;
	while ((node = walker.nextNode())) {
		if (range.intersectsNode(node) && !isInsideCitationSup(node, root as Element)) {
			textNodes.push(node as Text);
		}
	}

	for (let i = textNodes.length - 1; i >= 0; i--) {
		const textNode = textNodes[i];
		const nodeRange = document.createRange();
		const start = textNode === range.startContainer ? range.startOffset : 0;
		const end = textNode === range.endContainer ? range.endOffset : textNode.length;
		if (start >= end) continue;

		nodeRange.setStart(textNode, start);
		nodeRange.setEnd(textNode, end);
		if (!nodeRange.toString()) continue;

		const mark = document.createElement('span');
		mark.className = className;
		mark.dataset.highlightId = id;
		nodeRange.surroundContents(mark);
	}

	// Coalesce adjacent marks. Three merge rules, applied repeatedly until stable:
	//   1. Absorb whitespace-only text nodes sitting between marks.
	//   2. Merge adjacent mark spans with the same highlight id.
	//   3. Absorb fully-marked inline elements (e.g. <code>, <strong>) into
	//      the preceding mark. Without this, a selection that crosses an inline
	//      element like "result of <code>2.0 * 0.5</code>. Every" renders as
	//      three disconnected rounded marks with a gap at each code-padding
	//      edge. The absorbed inline element becomes a child of the mark span,
	//      which is legal HTML and preserves the element's own styling.
	//
	//   Rule 3 on the original page (not reader mode) specifically EXCLUDES
	//   <a>: the rest of the clipper treats `.mark inside <a>` as the canonical
	//   structure for highlighted links — click-to-remove delegates to `target
	//   closest '.mark'`, and `disableLinkClicks` watches for anchor clicks.
	//   Moving the <a> inside the mark flips the parent/child relationship and
	//   breaks the existing "click a highlighted link keeps the highlight" flow.
	//   Reader mode doesn't care because it reparses the whole document anyway,
	//   so full absorption (including <a>) stays on there.
	const isReaderMode = document.documentElement.classList.contains('obsidian-reader-active');
	const coalRoot = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
		? range.commonAncestorContainer.parentElement!
		: range.commonAncestorContainer as HTMLElement;
	let changed = true;
	while (changed) {
		changed = false;
		const marks = Array.from(coalRoot.querySelectorAll<HTMLElement>(`.${className}[data-highlight-id="${id}"]`));
		for (const mark of marks) {
			let next = mark.nextSibling;
			while (next) {
				// Rule 1: absorb whitespace between marks
				if (next instanceof Text && next.nodeValue?.trim() === '') {
					const ws = next;
					next = ws.nextSibling;
					mark.appendChild(ws);
					changed = true;
					continue;
				}
				// Rule 2: merge adjacent marks with same ID
				if (next instanceof HTMLElement && next.classList.contains(className) && next.dataset.highlightId === id) {
					while (next.firstChild) mark.appendChild(next.firstChild);
					const current = next;
					next = current.nextSibling;
					current.remove();
					changed = true;
					continue;
				}
				// Rule 3: absorb inline elements whose text is all marked
				if (
					next instanceof HTMLElement
					&& isInlineElement(next)
					&& (isReaderMode || next.tagName !== 'A')
				) {
					const innerMarks = next.querySelectorAll(`.${className}[data-highlight-id="${id}"]`);
					if (innerMarks.length > 0 && next.textContent?.trim() === Array.from(innerMarks).map(m => m.textContent).join('').trim()) {
						const el = next;
						next = el.nextSibling;
						innerMarks.forEach(m => {
							while (m.firstChild) m.parentNode!.insertBefore(m.firstChild, m);
							m.remove();
						});
						mark.appendChild(el);
						changed = true;
						continue;
					}
				}
				break;
			}
		}
	}
}

// ── Text range finding (for re-applying stored highlights) ──

export function findTextRange(
	root: Element, fullText: string,
	exactText: string, prefixText: string, suffixText: string
): Range | null {
	// 1. Try full context match (prefix + exact + suffix)
	const searchStr = prefixText + exactText + suffixText;
	let idx = fullText.indexOf(searchStr);
	if (idx !== -1) {
		return buildRangeFromOffset(root, idx + prefixText.length, idx + prefixText.length + exactText.length);
	}

	// 2. Try exact text match
	idx = fullText.indexOf(exactText);
	if (idx !== -1) {
		return buildRangeFromOffset(root, idx, idx + exactText.length);
	}

	// 3. Try matching a suffix of exactText, then extend backward to cover the full range.
	//    Reader mode (Defuddle) strips IPA, citations, etc. so the beginning of the stored
	//    text may not exist on the original page, but the content portion usually does.
	//    Also try with trailing bare citation digits stripped (Defuddle keeps "5" but page has "[5]").
	if (exactText.length > 40) {
		const cleaned = exactText.replace(/\d+$/g, '').trimEnd();
		const candidates = cleaned !== exactText ? [exactText, cleaned] : [exactText];

		for (const candidate of candidates) {
			if (candidate.length < 40) continue;
			for (let cut = Math.floor(candidate.length * 0.3); cut < candidate.length - 20; cut++) {
				const suffix = candidate.slice(cut);
				const suffixIdx = fullText.indexOf(suffix);
				if (suffixIdx !== -1) {
					const endIdx = suffixIdx + suffix.length;
					// Find the first word of exactText before the suffix match to extend the range
					const firstWord = exactText.match(/\w[\w\u00C0-\u024F'-]+/)?.[0];
					if (firstWord && firstWord.length >= 3) {
						const searchRegion = fullText.slice(0, suffixIdx);
						const firstWordIdx = searchRegion.lastIndexOf(firstWord);
						if (firstWordIdx !== -1 && suffixIdx - firstWordIdx < exactText.length * 3) {
							return buildRangeFromOffset(root, firstWordIdx, endIdx);
						}
					}
					return buildRangeFromOffset(root, suffixIdx, endIdx);
				}
			}
		}
	}

	return null;
}

/** Check if a node is inside a citation <sup> (not math/content superscripts). */
function isInsideCitationSup(node: Node, root: Element): boolean {
	let p = node.parentElement;
	while (p && p !== root) {
		if (p.tagName === 'SUP') {
			// Citation refs: sup.reference (Wikipedia), sup.footnote-ref, sup[id^="fnref"] (Defuddle)
			if (p.classList.contains('reference') || p.classList.contains('footnote-ref') ||
				(p.id && p.id.startsWith('fnref')) || (p.id && p.id.startsWith('cite_ref'))) {
				return true;
			}
		}
		p = p.parentElement;
	}
	return false;
}

function buildRangeFromOffset(root: Element, idx: number, endIdx: number): Range | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let charCount = 0;
	let startNode: Text | null = null, startOff = 0;
	let endNode: Text | null = null, endOff = 0;

	while (walker.nextNode()) {
		const tn = walker.currentNode as Text;
		// Skip text inside <sup> (citations) — consistent with getCleanTextContent
		if (isInsideCitationSup(tn, root)) continue;
		const len = tn.length;
		if (!startNode && charCount + len > idx) {
			startNode = tn;
			startOff = idx - charCount;
		}
		if (charCount + len >= endIdx) {
			endNode = tn;
			endOff = endIdx - charCount;
			break;
		}
		charCount += len;
	}

	if (!startNode || !endNode) return null;
	const r = document.createRange();
	r.setStart(startNode, startOff);
	r.setEnd(endNode, endOff);
	return r;
}

// ── Local persistence (serialized queue) ─────────────────

let storageQueue: Promise<void> = Promise.resolve();
let pendingRemovalFlushQueue: Promise<void> = Promise.resolve();

function enqueue(fn: () => Promise<void>): void {
	storageQueue = storageQueue.then(fn, fn);
}

function saveReaderHighlight(url: string, highlight: ReaderHighlightData): void {
	enqueue(async () => {
		const result = await browser.storage.local.get('readerHighlights') as Record<string, unknown>;
		const all = (result.readerHighlights || {}) as Record<string, ReaderHighlightData[]>;
		const existing = all[url] || [];
		if (!existing.some(h => h.id === highlight.id)) existing.push(highlight);
		all[url] = existing;
		await browser.storage.local.set({ readerHighlights: all });
	});
}

export function removeReaderHighlight(url: string, highlightId: string): void {
	enqueue(async () => {
		const result = await browser.storage.local.get('readerHighlights') as Record<string, unknown>;
		const all = (result.readerHighlights || {}) as Record<string, ReaderHighlightData[]>;
		const existing = all[url] || [];
		all[url] = existing.filter(h => h.id !== highlightId);
		if (all[url].length === 0) delete all[url];
		await browser.storage.local.set({ readerHighlights: all });
	});
}

export function clearReaderHighlights(url: string): void {
	enqueue(async () => {
		const result = await browser.storage.local.get('readerHighlights') as Record<string, unknown>;
		const all = (result.readerHighlights || {}) as Record<string, ReaderHighlightData[]>;
		delete all[url];
		await browser.storage.local.set({ readerHighlights: all });
	});
}

/** Wait for any pending writes to complete before reading. */
export function drainStorageQueue(): Promise<void> {
	return storageQueue;
}

export async function loadReaderHighlights(url: string): Promise<ReaderHighlightData[]> {
	await drainStorageQueue();
	const result = await browser.storage.local.get('readerHighlights') as Record<string, unknown>;
	const all = (result.readerHighlights || {}) as Record<string, ReaderHighlightData[]>;
	return all[url] || [];
}

function enqueuePendingRemovalWrite(
	mutate: (pending: Record<string, string[]>) => void
): void {
	enqueue(async () => {
		const result = await browser.storage.local.get(PENDING_REMOTE_REMOVALS_KEY) as Record<string, unknown>;
		const pending = (result[PENDING_REMOTE_REMOVALS_KEY] || {}) as Record<string, string[]>;
		mutate(pending);
		await browser.storage.local.set({ [PENDING_REMOTE_REMOVALS_KEY]: pending });
	});
}

export function queueRemoteHighlightRemoval(url: string, highlightId: string): void {
	enqueuePendingRemovalWrite((pending) => {
		const existing = pending[url] || [];
		if (!existing.includes(highlightId)) {
			existing.push(highlightId);
			pending[url] = existing;
		}
	});
}

export async function flushPendingRemoteHighlightRemovals(url: string): Promise<void> {
	pendingRemovalFlushQueue = pendingRemovalFlushQueue.then(async () => {
		await drainStorageQueue();
		const result = await browser.storage.local.get(PENDING_REMOTE_REMOVALS_KEY) as Record<string, unknown>;
		const pending = (result[PENDING_REMOTE_REMOVALS_KEY] || {}) as Record<string, string[]>;
		const queued = pending[url] || [];
		if (queued.length === 0) return;

		const remaining: string[] = [];
		for (let i = 0; i < queued.length; i++) {
			const highlightId = queued[i];
			const res = await pluginFetch('/highlights/remove', {
				method: 'POST',
				body: { url, highlightId }
			});
			if (!res.ok) {
				logHandledError('PendingHighlightRemoval', res.error || 'Failed to flush queued highlight removal', {
					url,
					highlightId,
					errorType: res.errorType,
					status: res.status,
				});
				remaining.push(...queued.slice(i));
				break;
			}
		}

		if (remaining.length > 0) {
			pending[url] = remaining;
		} else {
			delete pending[url];
		}
		await browser.storage.local.set({ [PENDING_REMOTE_REMOVALS_KEY]: pending });
	});

	await pendingRemovalFlushQueue;
}

// ── Page-level highlight loading ─────────────────────────

let orphanRetryTimer: ReturnType<typeof setTimeout> | null = null;

// ── Shared SSE helper ────────────────────────────────────
// Opens a long-lived Port to the background, which holds the actual EventSource
// connection to the plugin (bypasses page CSP). Port lifetime = page lifetime.

export interface HighlightSync {
	stop: () => void;
	update: (newUrl: string) => void;
}

/** Subscribe to highlight changes for a URL via background SSE. Callback fires on change. */
export function subscribeHighlightChanges(url: string, onChange: () => void): HighlightSync {
	let port: browser.Runtime.Port | null = null;
	let currentUrl = url;

	const connect = (subUrl: string) => {
		try {
			port = browser.runtime.connect({ name: 'highlight-sse' });
			port.onMessage.addListener((msg: unknown) => {
				if ((msg as any)?.action === 'pageHighlightsChanged') onChange();
			});
			port.onDisconnect.addListener(() => { port = null; });
			port.postMessage({ action: 'subscribe', url: subUrl });
		} catch { /* background unavailable */ }
	};

	connect(url);

	return {
		stop: () => {
			if (port) {
				try { port.disconnect(); } catch { /* already closed */ }
				port = null;
			}
		},
		update: (newUrl: string) => {
			if (newUrl === currentUrl) return;
			currentUrl = newUrl;
			if (port) {
				try { port.disconnect(); } catch { /* already closed */ }
				port = null;
			}
			connect(newUrl);
		},
	};
}

// ── Page-level sync ──────────────────────────────────────

let pageSync: HighlightSync | null = null;
let spaNavListenersInstalled = false;
let lastSyncedPath = '';

function normalizeUrl(): string {
	// Strip all hash fragments — same page, same document, same highlights.
	// Previously only stripped #:~:text= fragments, but anchors like #monday
	// caused highlights to be stored under different keys for the same page.
	return window.location.href.replace(/#.*$/, '');
}

function stripHash(url: string): string {
	const i = url.indexOf('#');
	return i === -1 ? url : url.slice(0, i);
}

function handleUrlChange(): void {
	if (!pageSync) return;
	const newUrl = normalizeUrl();
	const newPath = stripHash(newUrl);
	// Hash-only navigation (footnote link, in-page anchor) shouldn't re-sync —
	// same document identity, plugin keys by base URL, and a pointless re-sync
	// would diff against an empty result and wipe existing marks.
	if (newPath === lastSyncedPath) return;
	lastSyncedPath = newPath;
	pageSync.update(newUrl);
	loadAndApplyPageHighlights();
}

/** Start SSE sync with the plugin for the current page. */
export function startPageHighlightSync(): void {
	if (pageSync) return;
	lastSyncedPath = stripHash(normalizeUrl());
	pageSync = subscribeHighlightChanges(normalizeUrl(), () => loadAndApplyPageHighlights());

	// Watch for SPA navigation (pushState/replaceState/popstate)
	if (!spaNavListenersInstalled) {
		spaNavListenersInstalled = true;
		window.addEventListener('popstate', handleUrlChange);
		const origPushState = history.pushState;
		const origReplaceState = history.replaceState;
		history.pushState = function (...args) {
			const result = origPushState.apply(this, args);
			handleUrlChange();
			return result;
		};
		history.replaceState = function (...args) {
			const result = origReplaceState.apply(this, args);
			handleUrlChange();
			return result;
		};
	}
}

export function stopPageHighlightSync(): void {
	if (pageSync) {
		pageSync.stop();
		pageSync = null;
	}
}

/** Load text-anchor highlights from storage and apply as marks. */
export async function loadAndApplyPageHighlights(): Promise<void> {
	// Cancel any pending retry from a previous call
	if (orphanRetryTimer !== null) {
		clearTimeout(orphanRetryTimer);
		orphanRetryTimer = null;
	}
	const url = window.location.href.replace(/#:~:text=[^&]+(&|$)/, '');
	const root = findContentRoot();
	await flushPendingRemoteHighlightRemovals(url);

	// Merge plugin highlights (including highlights from linked Obsidian notes) with local ones
	let pluginHighlights: ReaderHighlightData[] = [];
	let pluginOnline = false;
	try {
		const res = await pluginFetch(`/highlights?url=${encodeURIComponent(url)}`);
		if (res.ok) {
			pluginOnline = true;
			const data = res.data as { entry?: { highlights?: ReaderHighlightData[] } };
			pluginHighlights = data.entry?.highlights ?? [];
		} else {
			logHandledError('PageHighlightLoad', res.error || 'Failed to load synced page highlights', {
				url,
				errorType: res.errorType,
				status: res.status,
			});
		}
	} catch (error) {
		logHandledError('PageHighlightLoad', error, { url });
	}

	const localHighlights = await loadReaderHighlights(url);
	const seenIds = new Set(pluginHighlights.map(h => h.id));
	const highlights: ReaderHighlightData[] = [];
	// Filter out anything the plugin is serving back that we've locally
	// removed — it means our /highlights/remove POST hasn't landed yet.
	// Re-applying it would fight the in-flight remove.
	for (const h of pluginHighlights) {
		if (!locallyRemovedIds.has(h.id)) highlights.push(h);
	}
	const localOnlyHighlights: ReaderHighlightData[] = [];
	for (const lh of localHighlights) {
		if (seenIds.has(lh.id)) continue;
		// Same filter for the local-only → reconcile path: if we just
		// removed this, don't push it back up to the plugin.
		if (locallyRemovedIds.has(lh.id)) continue;
		// And if we're in the middle of ADD-ing this (POST in flight),
		// local already has it but plugin doesn't yet — the in-flight
		// POST will finish the reconciliation itself, don't double-post.
		if (inFlightAddIds.has(lh.id)) continue;
		highlights.push(lh);
		localOnlyHighlights.push(lh);
	}
	// Keep the in-memory highlight cache in sync with what's currently
	// known for this URL so the undo system can look up the full text-
	// anchor data when the user removes a highlight.
	cacheHighlights(highlights);

	// Reconcile: if plugin is online, push any local-only highlights to the plugin
	// (covers the case where plugin was offline when highlights were created).
	if (pluginOnline && localOnlyHighlights.length > 0) {
		for (const lh of localOnlyHighlights) {
				pluginFetch('/highlights/add', {
					method: 'POST',
					body: { url, highlight: lh }
				}).then(res => {
					if (!res.ok) {
						logHandledError('PageHighlightReconcile', res.error || 'Failed to sync local-only highlight', {
							url,
							highlightId: lh.id,
							errorType: res.errorType,
						});
					}
				});
			}
		}

	// Diff existing marks against desired set — only remove deleted, only add new.
	// Avoids flickering when an unrelated highlight is added elsewhere on the page.
	const desiredIds = new Set(highlights.map(h => h.id));
	const existingIds = new Set<string>();
	root.querySelectorAll<HTMLElement>('.reading-selection-highlight-mark').forEach(m => {
		const id = m.dataset.highlightId;
		if (!id) return;
		if (desiredIds.has(id)) {
			existingIds.add(id);
		} else {
			m.replaceWith(...Array.from(m.childNodes));
		}
	});

	const toAdd = highlights.filter(h => !existingIds.has(h.id));
	if (toAdd.length === 0) return;

	const applied = applyHighlightMarks(root, toAdd);
	const orphaned = toAdd.filter(h => !applied.has(h.id));

	if (orphaned.length > 0) {
		// Retry once after a delay — page content may still be loading
		orphanRetryTimer = setTimeout(() => {
			orphanRetryTimer = null;
			const retryRoot = findContentRoot();
			const retryText = getCleanTextContent(retryRoot);
			const stillOrphaned: ReaderHighlightData[] = [];
			for (const h of orphaned) {
				// Skip if already applied by the first pass (shouldn't happen, but safe)
				if (retryRoot.querySelector(`.reading-selection-highlight-mark[data-highlight-id="${h.id}"]`)) continue;
				const range = findTextRange(retryRoot, retryText, h.exactText, h.prefixText, h.suffixText);
				if (range) {
					wrapRangeInMarks(range, 'reading-selection-highlight-mark', h.id);
				} else {
					stillOrphaned.push(h);
				}
			}
			if (stillOrphaned.length > 0) {
				showOrphanedHighlightsToast(stillOrphaned, url);
			}
		}, 3000);
	}
}

function applyHighlightMarks(root: Element, highlights: ReaderHighlightData[]): Set<string> {
	const fullText = getCleanTextContent(root);
	const applied = new Set<string>();
	for (const h of highlights) {
		const range = findTextRange(root, fullText, h.exactText, h.prefixText, h.suffixText);
		if (range) {
			wrapRangeInMarks(range, 'reading-selection-highlight-mark', h.id);
			applied.add(h.id);
		}
	}
	return applied;
}

export function attachMarkClickHandler(root: Document | Element, options: MarkClickHandlerOptions): () => void {
	const handleClick = (e: Event) => {
		if (options.canRemove && !options.canRemove()) return;

		const target = e.target as Element | null;
		if (!target) return;

		const mark = target.closest?.('.reading-selection-highlight-mark');
		if (!mark) return;

		// Let link clicks through. Any click whose target is inside <a[href]>
		// should navigate (or, if highlighter mode blocks navigation via
		// disableLinkClicks, do nothing) — it must never delete the highlight.
		// Covers all containment directions: mark inside link, link inside
		// mark, or range crossing element boundaries.
		if (target.closest?.('a[href]')) return;

		const highlightId = (mark as HTMLElement).dataset.highlightId;
		if (!highlightId) return;

		options.onRemove(highlightId);
	};

	root.addEventListener('click', handleClick, options.useCapture);
	return () => root.removeEventListener('click', handleClick, options.useCapture);
}

/** Wire delegated click-to-remove on page marks (call once). */
let pageMarkClickWired = false;
export function wirePageMarkClickHandlers(): void {
	if (pageMarkClickWired) return;
	pageMarkClickWired = true;

	// Use capturing phase so clicks reach us even when disableLinkClicks() uses stopPropagation
	attachMarkClickHandler(document, {
		canRemove: () => document.body.classList.contains('obsidian-highlighter-active'),
		useCapture: true,
		onRemove: (highlightId) => {
		// Record the op for undo BEFORE unwrapping, while we can still look
		// up the full text-anchor data from the cache.
		const url = window.location.href.replace(/#:~:text=[^&]+(&|$)/, '');
		const cached = highlightCache.get(highlightId);
		if (cached) {
			recordHighlightOp({ type: 'remove', url, highlight: cached });
		}
		markLocallyRemoved(highlightId);

		// Remove all spans with this highlight ID
		document.querySelectorAll(`.reading-selection-highlight-mark[data-highlight-id="${highlightId}"]`).forEach(m => {
			m.replaceWith(...Array.from(m.childNodes));
		});
		uncacheHighlight(highlightId);

		removeReaderHighlight(url, highlightId);

		// Notify plugin
		pluginFetch('/highlights/remove', {
			method: 'POST',
			body: { url, highlightId }
		}).then(res => {
			if (!res.ok) {
				queueRemoteHighlightRemoval(url, highlightId);
				logHandledError('PageHighlightRemove', res.error || 'Failed to remove highlight from plugin', {
					url,
					highlightId,
					errorType: res.errorType,
				});
			}
		});
		}
	});
}

// ── Orphaned highlights notification ─────────────────────

function showOrphanedHighlightsToast(orphaned: ReaderHighlightData[], url: string): void {
	const existing = document.getElementById('obsidian-orphaned-toast');
	if (existing) existing.remove();

	const count = orphaned.length;
	const preview = orphaned.map(h =>
		h.exactText.length > 50 ? h.exactText.slice(0, 50) + '…' : h.exactText
	).join('\n');

	const toast = document.createElement('div');
	toast.id = 'obsidian-orphaned-toast';
	toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#3a2a0a;color:#e0d8c8;padding:10px 16px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;z-index:999999999;opacity:0;transition:opacity 0.3s;display:flex;align-items:center;gap:12px;max-width:500px;';

	const text = document.createElement('span');
	text.textContent = `${count} highlight${count > 1 ? 's' : ''} no longer found on this page`;
	text.title = preview;
	toast.appendChild(text);

	const removeBtn = document.createElement('button');
	removeBtn.textContent = 'Remove';
	removeBtn.style.cssText = 'background:#5a3a0a;color:#e0d8c8;border:1px solid #7a5a2a;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit;white-space:nowrap;';
	removeBtn.addEventListener('click', () => {
		for (const h of orphaned) {
			removeReaderHighlight(url, h.id);
			pluginFetch('/highlights/remove', {
				method: 'POST',
				body: { url, highlightId: h.id }
			}).then(res => {
				if (!res.ok) {
					queueRemoteHighlightRemoval(url, h.id);
					logHandledError('OrphanHighlightRemove', res.error || 'Failed to remove orphaned highlight from plugin', {
						url,
						highlightId: h.id,
						errorType: res.errorType,
					});
				}
			});
		}
		toast.style.opacity = '0';
		setTimeout(() => toast.remove(), 300);
	});
	toast.appendChild(removeBtn);

	const dismissBtn = document.createElement('button');
	dismissBtn.textContent = '✕';
	dismissBtn.style.cssText = 'background:none;color:#e0d8c8;border:none;cursor:pointer;font:16px system-ui;padding:0 2px;opacity:0.6;';
	dismissBtn.addEventListener('click', () => {
		toast.style.opacity = '0';
		setTimeout(() => toast.remove(), 300);
	});
	toast.appendChild(dismissBtn);

	document.body.appendChild(toast);
	requestAnimationFrame(() => { toast.style.opacity = '1'; });
}

// ── Toast ────────────────────────────────────────────────

/** Green reader toast — same style as Reader.showToast (S-key "Saved to Obsidian"). */
export function showReaderToast(message: string, isError = false): void {
	const existing = document.getElementById('obsidian-reader-toast');
	if (existing) existing.remove();
	const toast = document.createElement('div');
	toast.id = 'obsidian-reader-toast';
	toast.textContent = message;
	const bg = isError ? '#4a2a2a' : '#2a4a2a';
	toast.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:${bg};color:#e0e0e0;padding:8px 16px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;z-index:999999999;opacity:0;transition:opacity 0.3s;pointer-events:none;`;
	document.body.appendChild(toast);
	requestAnimationFrame(() => { toast.style.opacity = '1'; });
	setTimeout(() => {
		toast.style.opacity = '0';
		setTimeout(() => toast.remove(), 300);
	}, 2000);
}

function showPluginOfflineToast(message = 'Obsidian plugin not running — highlights won\'t sync'): void {
	const existing = document.getElementById('obsidian-plugin-toast');
	if (existing) return;

	const toast = document.createElement('div');
	toast.id = 'obsidian-plugin-toast';
	toast.textContent = message;
	toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#e0e0e0;padding:8px 16px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;z-index:999999999;opacity:0;transition:opacity 0.3s;pointer-events:none;';
	document.body.appendChild(toast);
	requestAnimationFrame(() => { toast.style.opacity = '1'; });
	setTimeout(() => {
		toast.style.opacity = '0';
		setTimeout(() => toast.remove(), 300);
	}, 3000);
}
