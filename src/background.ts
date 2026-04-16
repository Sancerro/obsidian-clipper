import browser from 'webextension-polyfill';
import { detectBrowser } from './utils/browser-detection';
import { updateCurrentActiveTab, isValidUrl, isBlankPage } from './utils/active-tab-manager';
import { TextHighlightData } from './utils/highlighter';
import { debounce } from './utils/debounce';

const YOUTUBE_EMBED_RULE_ID = 9001;

// Tabs that should auto-activate reader mode on next page load
const pendingReaderTabs = new Set<number>();

// ── Highlight SSE management ─────────────────────────────
// Background holds EventSource connections (bypasses page CSP) and forwards
// highlight-changed events to content scripts via long-lived ports.
// Port lifetime = page/document lifetime; auto-cleanup on disconnect.

interface HighlightSSESession {
	es: EventSource | null;
	url: string;
	port: browser.Runtime.Port;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	backoffMs: number;
	closed: boolean;
}

type MathJaxMacroMap = Record<string, string | [string, number]>;
type MathJaxConfig = Record<string, unknown>;

const EVENT_SOURCE_AVAILABLE = typeof EventSource !== 'undefined';

function sanitizeMathJaxMacros(raw: unknown): MathJaxMacroMap {
	const sanitized: MathJaxMacroMap = {};
	if (!raw || typeof raw !== 'object') return sanitized;

	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === 'string') {
			sanitized[name] = value;
			continue;
		}

		if (Array.isArray(value) && typeof value[0] === 'string') {
			const argc = typeof value[1] === 'number' ? value[1] : Number(value[1]);
			sanitized[name] = Number.isFinite(argc) ? [value[0], argc] : value[0];
		}
	}

	return sanitized;
}

async function extractMathJaxMacrosFromTab(tabId: number): Promise<MathJaxMacroMap> {
	if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
		return {};
	}

	const [injection] = await chrome.scripting.executeScript({
		target: { tabId },
		world: 'MAIN',
		func: () => {
			const mathJax = (window as Window & { MathJax?: any }).MathJax;
			const liveMacros =
				mathJax?.startup?.document?.inputJax?.[0]?.parseOptions?.options?.macros
				|| mathJax?.startup?.input?.[0]?.parseOptions?.options?.macros
				|| mathJax?.startup?.getComponents?.()?.input?.[0]?.parseOptions?.options?.macros
				|| {};
			const raw =
				mathJax?.config?.tex?.macros
				|| mathJax?.tex?.macros
				|| mathJax?.config?.TeX?.Macros
				|| liveMacros
				|| {};

			if (!raw || typeof raw !== 'object') return {};

			const sources = [raw, liveMacros];
			const macros: Record<string, string | [string, number]> = {};
			for (const source of sources) {
				if (!source || typeof source !== 'object') continue;
				for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
					if (typeof value === 'string') {
						macros[name] = value;
						continue;
					}

					if (Array.isArray(value) && typeof value[0] === 'string') {
						const argc = typeof value[1] === 'number' ? value[1] : Number(value[1]);
						macros[name] = Number.isFinite(argc) ? [value[0], argc] : value[0];
					}
				}
			}

			return macros;
		},
	});

	return sanitizeMathJaxMacros(injection?.result);
}

async function injectMathJaxIntoTab(tabId: number, config: MathJaxConfig): Promise<void> {
	if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript || !chrome.runtime?.getURL) {
		throw new Error('MathJax injection is not available in this browser context');
	}

	// Check if MathJax is already initialized before overwriting.
	// If it has typesetPromise, merge our config (macros) into it.
	// Otherwise set a fresh config and load the bundled script.
	const [hasMathJax] = await chrome.scripting.executeScript({
		target: { tabId },
		world: 'MAIN',
		func: (cfg: MathJaxConfig) => {
			const scope = globalThis as typeof globalThis & {
				MathJax?: MathJaxConfig & {
					typesetPromise?: (elements?: Element[]) => Promise<unknown>;
					config?: { tex?: { macros?: Record<string, unknown> } };
				};
			};
			if (scope.MathJax?.typesetPromise) {
				// Merge macros into existing instance
				const texCfg = (cfg as Record<string, any>)?.tex;
				if (texCfg?.macros && scope.MathJax.config?.tex) {
					scope.MathJax.config.tex.macros = Object.assign(
						scope.MathJax.config.tex.macros || {}, texCfg.macros
					);
				}
				return true;
			}
			scope.MathJax = cfg;
			return false;
		},
		args: [config],
	});

	if (!hasMathJax?.result) {
		await chrome.scripting.executeScript({
			target: { tabId },
			world: 'MAIN',
			files: ['mathjax-tex-svg.js'],
		});
	}

	const [typesetResult] = await chrome.scripting.executeScript({
		target: { tabId },
		world: 'MAIN',
		func: () => {
			const scope = globalThis as typeof globalThis & {
				MathJax?: {
					startup?: { promise?: Promise<unknown> };
					typesetPromise?: (elements?: Element[]) => Promise<unknown>;
					texReset?: () => void;
					typesetClear?: (elements?: Element[]) => void;
				};
			};
			const article = document.querySelector('article');
			if (!article) {
				throw new Error('No article element found for MathJax typesetting');
			}
			const mathJax = scope.MathJax;
			if (!mathJax?.typesetPromise) {
				throw new Error('MathJax did not initialize in the extension world');
			}
			const beforeText = article.textContent || '';
			return Promise.resolve(mathJax.startup?.promise).then(() => {
				mathJax.texReset?.();
				mathJax.typesetClear?.([article]);
				return mathJax.typesetPromise?.([article]);
			}).then(() => ({
				beforeHasInline: beforeText.includes('\\('),
				beforeHasDisplay: beforeText.includes('\\['),
				mjxCount: article.querySelectorAll('mjx-container').length,
			}));
			},
		});
	void typesetResult;
}

function openHighlightSSE(session: HighlightSSESession): void {
	if (session.closed || !EVENT_SOURCE_AVAILABLE) return;
	try {
		const sseUrl = `http://localhost:27124/highlights/stream?url=${encodeURIComponent(session.url)}`;
		const es = new EventSource(sseUrl);
		session.es = es;

		es.onopen = () => {
			session.backoffMs = 1000; // reset backoff on successful connection
			// Tell content script to do a catch-up fetch now that we're subscribed
			try { session.port.postMessage({ action: 'pageHighlightsChanged' }); } catch { /* port closed */ }
		};
		es.onmessage = (event) => {
			let payload: Record<string, unknown> = {};
			try { payload = JSON.parse(event.data); } catch { /* not JSON */ }
			try {
				if (payload.type === 'progress') {
					session.port.postMessage({ action: 'progressChanged', progress: payload.progress });
				} else {
					session.port.postMessage({ action: 'pageHighlightsChanged' });
				}
			} catch { /* port closed */ }
		};
		es.onerror = () => {
			es.close();
			session.es = null;
			if (session.closed) return;
			// Reconnect with exponential backoff (capped at 30s)
			session.reconnectTimer = setTimeout(() => {
				session.reconnectTimer = null;
				openHighlightSSE(session);
			}, session.backoffMs);
			session.backoffMs = Math.min(session.backoffMs * 2, 30_000);
		};
	} catch { /* EventSource construction failed */ }
}

browser.runtime.onConnect.addListener((port: browser.Runtime.Port) => {
	if (port.name !== 'highlight-sse') return;

	const session: HighlightSSESession = {
		es: null,
		url: '',
		port,
		reconnectTimer: null,
		backoffMs: 1000,
		closed: false,
	};

	port.onMessage.addListener((msg: unknown) => {
		const m = msg as { action?: string; url?: string };
		if (m.action === 'subscribe' && m.url) {
			session.url = m.url;
			openHighlightSSE(session);
		}
	});

	port.onDisconnect.addListener(() => {
		session.closed = true;
		if (session.es) { session.es.close(); session.es = null; }
		if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
	});
});

// Firefox: always-active webRequest listener to rewrite Referer on YouTube embeds.
// Chrome MV3 doesn't support blocking webRequest, so this is a no-op there.
// Safari can't modify headers at all; reader.ts shows a thumbnail fallback instead.
if (browser.webRequest?.onBeforeSendHeaders) {
	browser.webRequest.onBeforeSendHeaders.addListener(
		(details) => {
			const headers = (details.requestHeaders || []).filter(
				h => h.name.toLowerCase() !== 'referer'
			);
			headers.push({ name: 'Referer', value: 'https://obsidian.md/' });
			return { requestHeaders: headers };
		},
		{
			urls: ['*://*.youtube.com/embed/*'],
			types: ['sub_frame' as browser.WebRequest.ResourceType]
		},
		['blocking', 'requestHeaders']
	);
}

// Chrome: declarativeNetRequest to rewrite Referer on YouTube embeds.
async function enableYouTubeEmbedRule(tabId: number): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID],
		addRules: [{
			id: YOUTUBE_EMBED_RULE_ID,
			priority: 1,
			action: {
				type: 'modifyHeaders' as any,
				requestHeaders: [{
					header: 'Referer',
					operation: 'set' as any,
					value: 'https://obsidian.md/'
				}]
			},
			condition: {
				urlFilter: '||youtube.com/embed/',
				resourceTypes: ['sub_frame' as any],
				tabIds: [tabId]
			}
		}]
	});
}

async function disableYouTubeEmbedRule(): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID]
	});
}

let sidePanelOpenWindows: Set<number> = new Set();
let highlighterModeState: { [tabId: number]: boolean } = {};
let hasHighlights = false;
let isContextMenuCreating = false;
let popupPorts: { [tabId: number]: browser.Runtime.Port } = {};

async function injectContentScript(tabId: number): Promise<void> {
	if (browser.scripting) {
		console.log('[Obsidian Clipper] Using scripting API');
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['content.js']
		});
	} else {
		console.log('[Obsidian Clipper] Using tabs.executeScript fallback');
		await browser.tabs.executeScript(tabId, { file: 'content.js' });
	}
	console.log('[Obsidian Clipper] Injection completed, waiting for init...');

	// Poll until the content script responds, rather than a fixed delay.
	// Try immediately after injection, then back off with 50ms sleeps.
	let ready = false;
	for (let i = 0; i < 8; i++) {
		try {
			await browser.tabs.sendMessage(tabId, { action: "ping" });
			ready = true;
			break;
		} catch {
			// Not ready yet
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	if (!ready) {
		throw new Error('Content script did not respond after injection');
	}
	console.log('[Obsidian Clipper] Post-injection ping succeeded');
}

async function ensureContentScriptLoadedInBackground(tabId: number): Promise<void> {
	try {
		// First, get the tab information
		const tab = await browser.tabs.get(tabId);

		// Check if the URL is valid before proceeding
		if (!tab.url || !isValidUrl(tab.url)) {
			throw new Error('Invalid URL for content script injection');
		}

		// Attempt to send a message to the content script
		await browser.tabs.sendMessage(tabId, { action: "ping" });
		console.log('[Obsidian Clipper] Content script ping succeeded');
	} catch (error) {
		// If the error is about invalid URL, re-throw it
		if (error instanceof Error && error.message.includes('invalid URL')) {
			throw error;
		}

		// If the message fails, the content script is not loaded, so inject it
		console.log('[Obsidian Clipper] Ping failed, injecting content script...', error);
		await injectContentScript(tabId);
	}
}

function getHighlighterModeForTab(tabId: number): boolean {
	return highlighterModeState[tabId] ?? false;
}

async function initialize() {
	try {
		// Set up tab listeners
		await setupTabListeners();

		browser.tabs.onRemoved.addListener((tabId) => {
			delete highlighterModeState[tabId];
		});
		
		// Initialize context menu
		await debouncedUpdateContextMenu(-1);
		
		console.log('Background script initialized successfully');
	} catch (error) {
		console.error('Error initializing background script:', error);
	}
}

// Check if a popup is open for a given tab
function isPopupOpen(tabId: number): boolean {
	return popupPorts.hasOwnProperty(tabId);
}

browser.runtime.onConnect.addListener((port) => {
	if (port.name === 'popup') {
		const tabId = port.sender?.tab?.id;
		if (tabId) {
			popupPorts[tabId] = port;
			port.onDisconnect.addListener(() => {
				delete popupPorts[tabId];
			});
		}
	}
});

async function sendMessageToPopup(tabId: number, message: any): Promise<void> {
	if (isPopupOpen(tabId)) {
		try {
			await popupPorts[tabId].postMessage(message);
		} catch (error) {
			console.warn(`Error sending message to popup for tab ${tabId}:`, error);
		}
	}
}



browser.runtime.onMessage.addListener((request: unknown, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void): true | undefined => {
	if (typeof request === 'object' && request !== null) {
		const typedRequest = request as { action: string; isActive?: boolean; hasHighlights?: boolean; tabId?: number; text?: string; section?: string; url?: string };
		
		if (typedRequest.action === 'saveReaderSettings') {
			const { settings } = typedRequest as any;
			browser.storage.sync.set({ reader_settings: settings }).then(() => {
				sendResponse({ success: true });
			}).catch((e: Error) => {
				sendResponse({ success: false, error: e.message });
			});
			return true;
		}

		if (typedRequest.action === 'pluginFetch') {
			const { url, method, body, timeoutMs } = typedRequest as any;
			const isLocalPluginUrl = typeof url === 'string'
				&& (url.startsWith('http://localhost:27124') || url.startsWith('http://127.0.0.1:27124'));
			const maxRetries = isLocalPluginUrl ? 2 : 0;
			const retryDelay = 600; // ms

			const doFetch = (attempt: number) => {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), typeof timeoutMs === 'number' ? timeoutMs : 5000);

				fetch(url, {
					method: method || 'GET',
					headers: body ? { 'Content-Type': 'application/json' } : undefined,
					body: body ? JSON.stringify(body) : undefined,
					signal: controller.signal,
				}).then(async res => {
					clearTimeout(timer);
					const text = await res.text();
					let data;
					try { data = JSON.parse(text); } catch { data = text; }

					let error: string | undefined;
					if (!res.ok) {
						if (typeof data === 'string' && data.trim()) {
							error = data.trim();
						} else if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
							error = (data as { error: string }).error;
						} else {
							error = res.statusText || `HTTP ${res.status}`;
						}
					}

					sendResponse({
						ok: res.ok,
						status: res.status,
						statusText: res.statusText,
						data,
						error,
						errorType: res.ok ? undefined : 'http',
					});
				}).catch(err => {
					clearTimeout(timer);
					if (err instanceof DOMException && err.name === 'AbortError') {
						sendResponse({
							ok: false,
							status: 0,
							error: 'Request timed out',
							errorType: 'timeout',
						});
						return;
					}

					// Retry on connection errors for local plugin
					if (attempt < maxRetries) {
						setTimeout(() => doFetch(attempt + 1), retryDelay);
						return;
					}

					sendResponse({
						ok: false,
						status: 0,
						error: err instanceof Error ? err.message : String(err),
						errorType: isLocalPluginUrl ? 'offline' : 'network',
					});
				});
			};

			doFetch(0);
			return true;
		}

		if (typedRequest.action === 'copy-to-clipboard' && typedRequest.text) {
			// Use content script to copy to clipboard
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						const response = await browser.tabs.sendMessage(currentTab.id, {
							action: 'copy-text-to-clipboard',
							text: typedRequest.text
						});
						if ((response as any) && (response as any).success) {
							sendResponse({success: true});
						} else {
							sendResponse({success: false, error: 'Failed to copy from content script'});
						}
					} catch (err) {
						sendResponse({ success: false, error: (err as Error).message });
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === 'injectMathJax') {
			const tabId = typedRequest.tabId || sender.tab?.id;
			const { config } = typedRequest as { config?: MathJaxConfig };
			if (!tabId) { sendResponse({ success: false }); return true; }

			(async () => {
				try {
					await injectMathJaxIntoTab(tabId, config || {});
					sendResponse({ success: true });
				} catch (e) {
					console.error('[Obsidian Clipper] injectMathJax failed', e);
					sendResponse({ success: false, error: (e as Error).message });
				}
			})();
			return true;
		}

		if (typedRequest.action === 'getMathJaxMacros') {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (!tabId) {
				sendResponse({ success: false, macros: {}, error: 'No tab ID provided' });
				return true;
			}

			extractMathJaxMacrosFromTab(tabId)
				.then((macros) => sendResponse({ success: true, macros }))
				.catch((error) => sendResponse({
					success: false,
					macros: {},
					error: error instanceof Error ? error.message : String(error),
				}));
			return true;
		}

		if (typedRequest.action === "extractContent" && sender.tab && sender.tab.id) {
			browser.tabs.sendMessage(sender.tab.id, request).then(sendResponse);
			return true;
		}

		if (typedRequest.action === "ensureContentScriptLoaded") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				ensureContentScriptLoadedInBackground(tabId)
					.then(() => sendResponse({ success: true }))
					.catch((error) => sendResponse({ 
						success: false, 
						error: error instanceof Error ? error.message : String(error) 
					}));
				return true;
			} else {
				sendResponse({ success: false, error: 'No tab ID provided' });
				return true;
			}
		}

		if (typedRequest.action === "enableYouTubeEmbedRule") {
			const tabId = sender.tab?.id;
			if (tabId) {
				enableYouTubeEmbedRule(tabId).then(() => {
					sendResponse({ success: true });
				}).catch(() => {
					sendResponse({ success: true });
				});
			} else {
				sendResponse({ success: true });
			}
			return true;
		}

		if (typedRequest.action === "disableYouTubeEmbedRule") {
			disableYouTubeEmbedRule().then(() => {
				sendResponse({ success: true });
			}).catch(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (typedRequest.action === "sidePanelOpened") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.add(sender.tab.windowId);
				updateCurrentActiveTab(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "sidePanelClosed") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.delete(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "highlighterModeChanged" && sender.tab && typedRequest.isActive !== undefined) {
			const tabId = sender.tab.id;
			if (tabId) {
				highlighterModeState[tabId] = typedRequest.isActive;
				sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: typedRequest.isActive });
				debouncedUpdateContextMenu(tabId);
			}
		}

		if (typedRequest.action === "highlightsCleared" && sender.tab) {
			hasHighlights = false;
			debouncedUpdateContextMenu(sender.tab.id!);
		}

		if (typedRequest.action === "updateHasHighlights" && sender.tab && typedRequest.hasHighlights !== undefined) {
			hasHighlights = typedRequest.hasHighlights;
			debouncedUpdateContextMenu(sender.tab.id!);
		}

		if (typedRequest.action === "getHighlighterMode") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				sendResponse({ isActive: getHighlighterModeForTab(tabId) });
			} else {
				sendResponse({ isActive: false });
			}
			return true;
		}

		if (typedRequest.action === "toggleHighlighterMode" && typedRequest.tabId) {
			toggleHighlighterMode(typedRequest.tabId)
				.then(newMode => sendResponse({ success: true, isActive: newMode }))
				.catch(error => sendResponse({ success: false, error: error.message }));
			return true;
		}

		if (typedRequest.action === "openPopup") {
			browser.action.openPopup()
				.then(() => {
					sendResponse({ success: true });
				})
				.catch((error: unknown) => {
					console.error('Error opening popup in background script:', error);
					sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
				});
			return true;
		}

		if (typedRequest.action === "toggleReaderMode" && typedRequest.tabId) {
			injectReaderScript(typedRequest.tabId).then(() => {
				browser.tabs.sendMessage(typedRequest.tabId!, { action: "toggleReaderMode" })
					.then(sendResponse);
			});
			return true;
		}

		if (typedRequest.action === "openInReaderMode" && typedRequest.url) {
			const tabId = sender.tab?.id;
			if (tabId) {
				pendingReaderTabs.add(tabId);
				browser.tabs.update(tabId, { url: typedRequest.url });
			}
			sendResponse({ success: true });
			return;
		}

		if (typedRequest.action === "getActiveTabAndToggleIframe") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						// Check if the URL is valid before trying to inject content script
						if (!currentTab.url || !isValidUrl(currentTab.url) || isBlankPage(currentTab.url)) {
							sendResponse({success: false, error: 'Cannot open iframe on this page'});
							return;
						}

						// Ensure content script is loaded first
						await ensureContentScriptLoadedInBackground(currentTab.id);
						await browser.tabs.sendMessage(currentTab.id, { action: "toggle-iframe" });
						sendResponse({success: true});
					} catch (error) {
						console.error('Error sending toggle-iframe message:', error);
						sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "getActiveTab") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				let currentTab = tabs[0];
				// Fallback for when currentWindow has no tabs (e.g., debugging popup in DevTools)
				if (!currentTab || !currentTab.id) {
					const allActiveTabs = await browser.tabs.query({active: true});
					currentTab = allActiveTabs.find(tab =>
						tab.id && tab.url && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('moz-extension://')
					) || allActiveTabs[0];
				}
				if (currentTab && currentTab.id) {
					sendResponse({tabId: currentTab.id});
				} else {
					sendResponse({error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "openOptionsPage") {
			try {
				if (typeof browser.runtime.openOptionsPage === 'function') {
					// Chrome way
					browser.runtime.openOptionsPage();
				} else {
					// Firefox way
					browser.tabs.create({
						url: browser.runtime.getURL('settings.html')
					});
				}
				sendResponse({success: true});
			} catch (error) {
				console.error('Error opening options page:', error);
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "openSettings") {
			try {
				const section = typedRequest.section ? `?section=${typedRequest.section}` : '';
				browser.tabs.create({
					url: browser.runtime.getURL(`settings.html${section}`)
				});
				sendResponse({success: true});
			} catch (error) {
				console.error('Error opening settings:', error);
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "openPopup") {
			try {
				browser.action.openPopup();
				sendResponse({success: true});
			} catch (error) {
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "copyMarkdownToClipboard" || typedRequest.action === "saveMarkdownToFile") {
			if (sender.tab?.id) {
				(async () => {
					try {
						await ensureContentScriptLoadedInBackground(sender.tab!.id!);
						await browser.tabs.sendMessage(sender.tab!.id!, { action: typedRequest.action });
						sendResponse({success: true});
					} catch (error) {
						sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
					}
				})();
				return true;
			}
		}

		if (typedRequest.action === "getTabInfo") {
			browser.tabs.get(typedRequest.tabId as number).then((tab) => {
				sendResponse({
					success: true,
					tab: {
						id: tab.id,
						url: tab.url
					}
				});
			}).catch((error) => {
				console.error('Error getting tab info:', error);
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		if (typedRequest.action === "forceInjectContentScript") {
			const tabId = typedRequest.tabId;
			if (tabId) {
				injectContentScript(tabId)
					.then(() => sendResponse({ success: true }))
					.catch((error) => {
						console.error('[Obsidian Clipper] forceInjectContentScript failed:', error);
						sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
					});
				return true;
			} else {
				sendResponse({ success: false, error: 'Missing tabId' });
				return true;
			}
		}

		if (typedRequest.action === "sendMessageToTab") {
			const tabId = (typedRequest as any).tabId;
			const message = (typedRequest as any).message;
			if (tabId && message) {
				// Ensure content script is loaded before sending message
				ensureContentScriptLoadedInBackground(tabId).then(() => {
					console.log('[Obsidian Clipper] Sending message to tab:', message.action);
					return browser.tabs.sendMessage(tabId, message);
				}).then((response) => {
					console.log('[Obsidian Clipper] Tab response:', response ? 'has content=' + !!((response as any).content) : response);
					sendResponse(response);
				}).catch((error) => {
					console.error('[Obsidian Clipper] Error sending message to tab:', error);
					sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					});
				});
				return true;
			} else {
				sendResponse({
					success: false,
					error: 'Missing tabId or message'
				});
				return true;
			}
		}

		if (typedRequest.action === "openObsidianUrl") {
			const url = (typedRequest as any).url;
			if (url) {
				browser.tabs.query({active: true, currentWindow: true}).then((tabs) => {
					const currentTab = tabs[0];
					if (currentTab && currentTab.id) {
						browser.tabs.update(currentTab.id, { url: url }).then(() => {
							sendResponse({ success: true });
						}).catch((error) => {
							console.error('Error opening Obsidian URL:', error);
							sendResponse({
								success: false,
								error: error instanceof Error ? error.message : String(error)
							});
						});
					} else {
						sendResponse({
							success: false,
							error: 'No active tab found'
						});
					}
				}).catch((error) => {
					console.error('Error querying tabs:', error);
					sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					});
				});
				return true;
			} else {
				sendResponse({
					success: false,
					error: 'Missing URL'
				});
				return true;
			}
		}

		// For other actions that use sendResponse
		if (typedRequest.action === "extractContent" || 
			typedRequest.action === "ensureContentScriptLoaded" ||
			typedRequest.action === "getHighlighterMode" ||
			typedRequest.action === "toggleHighlighterMode" ||
			typedRequest.action === "openObsidianUrl") {
			return true;
		}
	}
	return undefined;
});

browser.commands.onCommand.addListener(async (command, tab) => {
	if (command === 'quick_clip') {
		browser.tabs.query({active: true, currentWindow: true}).then((tabs) => {
			if (tabs[0]?.id) {
				browser.action.openPopup();
				setTimeout(() => {
					browser.runtime.sendMessage({action: "triggerQuickClip"})
						.catch(error => console.error("Failed to send quick clip message:", error));
				}, 500);
			}
		});
	}
	if (command === "toggle_highlighter" && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		toggleHighlighterMode(tab.id);
	}
	if (command === "copy_to_clipboard" && tab && tab.id) {
		await browser.tabs.sendMessage(tab.id, { action: "copyToClipboard" });
	}
	if (command === "toggle_reader" && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await injectReaderScript(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "toggleReaderMode" });
	}
});

const debouncedUpdateContextMenu = debounce(async (tabId: number) => {
	if (isContextMenuCreating) {
		return;
	}
	isContextMenuCreating = true;

	try {
		await browser.contextMenus.removeAll();

		let currentTabId = tabId;
		if (currentTabId === -1) {
			const tabs = await browser.tabs.query({ active: true, currentWindow: true });
			if (tabs.length > 0) {
				currentTabId = tabs[0].id!;
			}
		}

		const isHighlighterMode = getHighlighterModeForTab(currentTabId);

		const menuItems: {
			id: string;
			title: string;
			contexts: browser.Menus.ContextType[];
		}[] = [
				{
					id: "open-obsidian-clipper",
					title: "Save this page",
					contexts: ["page", "selection", "image", "video", "audio"]
				},
				{
					id: 'copy-markdown-to-clipboard',
					title: browser.i18n.getMessage('copyToClipboard'),
					contexts: ["page", "selection"]
				},
				{
					id: "toggle-reader",
					title: browser.i18n.getMessage('commandToggleReader'),
					contexts: ["page", "selection"]
				},
				{
					id: isHighlighterMode ? "exit-highlighter" : "enter-highlighter",
					title: isHighlighterMode ? "Exit highlighter" : "Highlight this page",
					contexts: ["page","image", "video", "audio"]
				},
				{
					id: "highlight-selection",
					title: "Add to highlights",
					contexts: ["selection"]
				},
				{
					id: 'open-embedded',
					title: browser.i18n.getMessage('openEmbedded'),
					contexts: ["page", "selection"]
				}
			];

		const browserType = await detectBrowser();
		if (browserType === 'chrome') {
			menuItems.push({
				id: 'open-side-panel',
				title: browser.i18n.getMessage('openSidePanel'),
				contexts: ["page", "selection"]
			});
		}

		for (const item of menuItems) {
			await browser.contextMenus.create(item);
		}
	} catch (error) {
		console.error('Error updating context menu:', error);
	} finally {
		isContextMenuCreating = false;
	}
}, 100); // 100ms debounce time

browser.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId === "open-obsidian-clipper") {
		browser.action.openPopup();
	} else if (info.menuItemId === "enter-highlighter" && tab && tab.id) {
		await setHighlighterMode(tab.id, true);
	} else if (info.menuItemId === "exit-highlighter" && tab && tab.id) {
		await setHighlighterMode(tab.id, false);
	} else if (info.menuItemId === "highlight-selection" && tab && tab.id) {
		await highlightSelection(tab.id, info);
	} else if (info.menuItemId === "toggle-reader" && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await injectReaderScript(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "toggleReaderMode" });
	} else if (info.menuItemId === 'open-embedded' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "toggle-iframe" });
	} else if (info.menuItemId === 'open-side-panel' && tab && tab.id && tab.windowId) {
		chrome.sidePanel.open({ tabId: tab.id });
		sidePanelOpenWindows.add(tab.windowId);
		await ensureContentScriptLoadedInBackground(tab.id);
	} else if (info.menuItemId === 'copy-markdown-to-clipboard' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "copyMarkdownToClipboard" });
	}
});

browser.runtime.onInstalled.addListener(() => {
	debouncedUpdateContextMenu(-1); // Use a dummy tabId for initial creation
});

// Auto-activate reader mode on tabs that were navigated via reader mode links
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
	if (changeInfo.status === 'complete' && pendingReaderTabs.has(tabId)) {
		pendingReaderTabs.delete(tabId);
		try {
			await ensureContentScriptLoadedInBackground(tabId);
			await injectReaderScript(tabId);
			await browser.tabs.sendMessage(tabId, { action: "toggleReaderMode" });
		} catch (error) {
			console.error('Error activating reader mode after navigation:', error);
		}
	}
});

async function isSidePanelOpen(windowId: number): Promise<boolean> {
	return sidePanelOpenWindows.has(windowId);
}

async function setupTabListeners() {
	const browserType = await detectBrowser();
	if (['chrome', 'brave', 'edge'].includes(browserType)) {
		browser.tabs.onActivated.addListener(handleTabChange);
		browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.status === 'complete') {
				handleTabChange({ tabId, windowId: tab.windowId });
			}
		});
	}
}

const debouncedPaintHighlights = debounce(async (tabId: number) => {
	if (!getHighlighterModeForTab(tabId)) {
		await setHighlighterMode(tabId, false);
	}
	await paintHighlights(tabId);
}, 250);

async function handleTabChange(activeInfo: { tabId: number; windowId?: number }) {
	if (activeInfo.windowId && await isSidePanelOpen(activeInfo.windowId)) {
		updateCurrentActiveTab(activeInfo.windowId);
		await debouncedPaintHighlights(activeInfo.tabId);
	}
}

async function paintHighlights(tabId: number) {
	try {
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url || !isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		await ensureContentScriptLoadedInBackground(tabId);
		await browser.tabs.sendMessage(tabId, { action: "paintHighlights" });

	} catch (error) {
		console.error('Error painting highlights:', error);
	}
}

async function setHighlighterMode(tabId: number, activate: boolean) {
	try {
		// First, check if the tab exists
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url) {
			return;
		}

		// Check if the URL is valid and not a blank page
		if (!isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		// Then, ensure the content script is loaded
		await ensureContentScriptLoadedInBackground(tabId);

		// Now try to send the message
		highlighterModeState[tabId] = activate;
		await browser.tabs.sendMessage(tabId, { action: "setHighlighterMode", isActive: activate });
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: activate });

	} catch (error) {
		console.error('Error setting highlighter mode:', error);
		// If there's an error, assume highlighter mode should be off
		highlighterModeState[tabId] = false;
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: false });
	}
}

async function toggleHighlighterMode(tabId: number): Promise<boolean> {
	try {
		const currentMode = getHighlighterModeForTab(tabId);
		const newMode = !currentMode;
		highlighterModeState[tabId] = newMode;
		await browser.tabs.sendMessage(tabId, { action: "setHighlighterMode", isActive: newMode });
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: newMode });
		return newMode;
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		throw error;
	}
}

async function highlightSelection(tabId: number, info: browser.Menus.OnClickData) {
	highlighterModeState[tabId] = true;
	
	const highlightData: Partial<TextHighlightData> = {
		id: Date.now().toString(),
		type: 'text',
		content: info.selectionText || '',
	};

	await browser.tabs.sendMessage(tabId, { 
		action: "highlightSelection", 
		isActive: true,
		highlightData,
	});
	hasHighlights = true;
	debouncedUpdateContextMenu(tabId);
}

async function injectReaderScript(tabId: number) {
	try {
		await browser.scripting.insertCSS({
			target: { tabId },
			files: ['reader.css']
		});

		// Inject scripts in sequence for all browsers
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['browser-polyfill.min.js']
		});
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['reader-script.js']
		});

		return true;
	} catch (error) {
		console.error('Error injecting reader script:', error);
		return false;
	}
}

// Initialize the extension
initialize().catch(error => {
	console.error('Failed to initialize background script:', error);
});
