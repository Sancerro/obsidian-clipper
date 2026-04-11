# Progress Log: Bidirectional Highlight Sync

## 2026-04-06

### Goal
Make highlights sync bidirectionally between the Obsidian Web Clipper (browser extension) and the Reading Selection Highlight Obsidian plugin. "They should never be not in sync."

### Discovery
- The **installed** plugin at `Grimoire/.obsidian/plugins/reading-selection-highlight/main.js` already had HTTP server code (port 27124) with `/health`, `/page`, `/highlights`, `/clip` endpoints — but this was never ported to the source repo at `/Users/baris/obsidian-plugin-repos/reading-selection-highlight/`.
- The clipper had uncommitted changes in `reader.ts` adding a `localPluginUrl` and a `GET /page?url=...` call.
- The two repos use completely different highlight anchoring: clipper uses XPath + character offsets, plugin uses exactText + section headings + fuzzy resolution.

### Plugin changes (`reading-selection-highlight`)
- **`esbuild.config.mjs`**: Added `"http"` to externals for Node.js http module in Electron.
- **`src/types.ts`**: Added `RemoteHighlight`, `PageHighlightEntry`, extended `PluginDataV2` with `pageNoteLinks` and `pageHighlights`.
- **`src/storage/migrateData.ts`**: Initialize new fields during migration.
- **`src/main.ts`**: Major additions:
  - HTTP server on `127.0.0.1:27124` with CORS headers
  - SSE endpoint at `/highlights/stream` for real-time push
  - Endpoints: `/health`, `/page`, `/highlights`, `/highlights/add`, `/highlights/remove`, `/clip`
  - Frontmatter URL index — scans vault `source` field, stays live via metadata/rename/delete events
  - `handleRemotePage` renders markdown → HTML via `MarkdownRenderer.render()` with highlights baked in
  - `toRemoteHighlight` / `fromRemoteHighlight` conversion
  - `notifySseClients(notePath)` pushes SSE events on highlight changes

### Clipper changes (`obsidian-clipper`)
- **`src/utils/reader.ts`**:
  - `extractContent()` returns `notePath` from plugin
  - Sets `data-obsidian-note-path` attribute for Obsidian note mode
  - `wireMarkClickHandlers()` — click a mark to remove (optimistic + POST)
  - SSE stream with polling fallback for Obsidian→clipper sync
  - `refreshObsidianContent()` — re-fetches `/page`, replaces article, lightweight re-init
  - Cooldown system with deferred refresh (not drop) to avoid SSE/optimistic conflicts
- **`src/utils/highlighter.ts`**:
  - `handleTextSelection()` redirects to `handleObsidianNoteHighlight()` on Obsidian notes
  - Optimistic mark insertion via `surroundContents` / `extractContents` fallback
  - Fire-and-forget POST with failure rollback
  - `loadHighlights()` / `saveHighlights()` skip browser storage for Obsidian notes
- **`src/utils/highlighter-overlays.ts`**: Merged overlapping client rects in selection preview to fix double-highlight on inline elements.
- **`src/reader.scss`**: Added `cursor: pointer` on marks.
- **`src/background.ts`**: Added then removed `pluginFetch` proxy (was needed for CSP bypass, then replaced by `localhost` URL).

### Issues encountered and resolved
1. **CSP blocking**: Firefox content script `fetch()` to `127.0.0.1` was blocked by Wikipedia's CSP. Tried background proxy approach (complex, fragile). Final fix: changed URL to `localhost` which Wikipedia's CSP explicitly allows.
2. **highlight.js spam**: `refreshObsidianContent` re-ran `initializeCodeHighlighting` on every refresh, spamming "unescaped HTML" warnings for frontmatter YAML. Fixed by skipping code highlighting on refresh (Obsidian already renders code blocks).
3. **Highlight disappearing then reappearing**: POST was awaited before showing the mark. Fixed with optimistic `surroundContents` + fire-and-forget POST.
4. **`surroundContents` failing on inline elements**: Selections ending on `<em>`, `<a>`, etc. threw because the range crossed element boundaries. Fixed with `extractContents` fallback.
5. **Double highlight preview on inline elements**: `getClientRects()` returns overlapping rects for inline elements. Fixed by merging adjacent rects on the same line.
6. **Deletion by pieces**: Plugin bakes highlights as multiple `<span>` elements per highlight. Click handler only removed the clicked span. Fixed by removing all spans with the same `data-highlight-id`.
7. **Cooldown dropping SSE refreshes**: Time-based cooldown silently dropped refreshes instead of deferring them. Fixed with `setTimeout` deferred refresh.
8. **Optimistic updates not rolled back on failure**: POST failures left stale UI. Fixed by clearing cooldown and forcing canonical refresh on failure.

### Decisions
- Plugin is the single source of truth for highlights on linked notes
- Clipper never stores Obsidian note highlights in `browser.storage.local`
- URL → note mapping built from vault frontmatter `source` field + `/clip` endpoint
- SSE for instant sync, polling fallback for when SSE fails (CSP, etc.)
- Optimistic UI with failure rollback rather than await-then-render

## 2026-04-07

### Codex review
- Ran codex review, found 8 issues (2 high, 3 medium, 3 low)
- Fixed: cooldown deferred refresh, POST failure rollback, dead code removal, async→sync conversion
- Not yet fixed: URL normalization brittleness, SSE reconnection, listener cleanup in restore()

## 2026-04-08

### Midnight theme for Obsidian
- Created CSS snippet at `Grimoire/.obsidian/snippets/midnight.css` matching the clipper's Midnight reader theme
- Light mode = parchment (#f4f0e8), dark mode = near-black (#0d0d0d)
- Sidebar/chrome uses warm stone tones (analogous warmth gradient: spine → cover → page)
- Had to fight Obsidian's translucent mode (`is-translucent`) which forces `transparent !important` on ribbon/tabs — required matching `.is-translucent:not(.is-fullscreen).theme-light` selectors
- Direct element targeting needed for sidebar text (`.tree-item-self`) since CSS variables were overridden by Obsidian's specificity chain

### Unified reader mode highlights (states 1 & 2)
- Previously: Obsidian-linked notes used plugin sync, non-linked pages used XPath overlays — two incompatible systems
- Now: all reader mode pages use the same mark-based highlighting with dual persistence (browser.storage.local + plugin HTTP)
- On highlight creation: wraps text in marks → saves to local storage → POSTs to plugin
- On reader entry: tries plugin first, merges with local by ID (not all-or-nothing fallback)
- Mark click handlers and X key shortcut work uniformly for all reader pages

### Codex review fixes (14 issues found, 8 fixed)
1. **Critical: Migration deletes without checking res.ok** — Now checks every POST response before clearing local data
2. **Critical: Storage write race conditions** — Added async queue serialization for all `readerHighlights` mutations
3. **Critical: Empty highlights cache** — `applyHighlights()` now clears overlays and updates cache when highlights array is empty
4. **Important: Optimistic sync add/remove confusion** — Changed `pendingOptimisticIds: Set<string>` to `pendingOptimisticOps: Map<string, 'add' | 'remove'>` with typed op tracking
5. **Important: Plugin-first loading all-or-nothing** — Now merges remote + local highlights by ID so local-only highlights survive failed POSTs
6. **Important: getTextOffset breaks on element nodes** — Added element→text node normalization before walking
7. **Important: Links disabled in reader mode** — `toggleHighlighterMenu()` now skips `disableLinkClicks()` when in reader mode
8. **Moderate: Listener leaks across open/close cycles** — Stored bound handler references, removed in `stopHighlightStream()`

### Architectural refactoring (GRASP/GoF review)
Codex identified responsibility and coupling issues. Refactored:

1. **Extracted `src/utils/reader-highlights.ts`** — reader-mode selection handling, mark wrapping, text anchoring, local persistence (serialized queue), and plugin offline toast. Removed ~300 lines from `highlighter.ts`.
2. **Extracted `src/utils/plugin-url.ts`** — centralized `PLUGIN_URL` constant (was duplicated in `highlighter.ts` and `reader.ts`).
3. **Fixed overlay observer lifecycle** — `highlighter-overlays.ts` no longer has import-time side effects. Moved `window.addEventListener('resize/scroll')` and `MutationObserver.observe()` into `attachOverlayObservers()` / `detachOverlayObservers()`, called from `toggleHighlighterMenu()`.
4. **Fixed always-show path** — `attachOverlayObservers()` also called when `alwaysShowHighlights` is enabled, so overlays track scroll/resize.
5. **Cleaned up stale type** — `content-extractor.ts` had inline `ElementHighlightData` with stale "not exported" comment; now imports from `highlighter.ts`.
6. **reader.ts** imports from `reader-highlights.ts` directly. `highlighter.ts` re-exports reader functions for backward compat.

### Still known (lower priority)
- Circular dependency between `highlighter.ts` ↔ `highlighter-overlays.ts` (builds fine, architectural debt)
- Highlight deduplication (overlapping selections create nested marks)
- Migration is lossy (no prefix/suffix context reconstructed from DOM)
- Legacy highlight ID collisions (Date.now() based, sub-ms risk)

## 2026-04-09

### Page-level highlights synced with reader mode
- Previously: page highlighting used XPath-based overlay system (completely different from reader mode marks)
- Now: page and reader mode share the same text-anchor mark system, same storage, same plugin sync
- Changes:
  - **`reader-highlights.ts`**: `handleReaderModeHighlight()` now falls back to `document.body` when no `<article>` exists (works on original page). Added `loadAndApplyPageHighlights()` (loads from `readerHighlights` storage, applies marks via `findTextRange`). Added `wirePageMarkClickHandlers()` (delegated click-to-remove, only active when highlighter is on).
  - **`highlighter.ts`**: `handleTextSelection()` now always routes to `handleReaderModeHighlight()` (removed entire XPath branch). `loadHighlights()` also calls `loadAndApplyPageHighlights()` + `wirePageMarkClickHandlers()` so marks appear on page load.
  - **`reader.ts`**: `restore()` calls `loadAndApplyPageHighlights()` + `wirePageMarkClickHandlers()` after restoring original HTML, so reader-mode highlights appear on the page.
  - **`highlighter.scss`**: Added `.reading-selection-highlight-mark` styles at global scope (not just inside reader container).
- Cross-mode matching: prefix/suffix computed relative to different roots (body vs article) may not match, but `findTextRange` falls back to `exactText` which works for typical highlights.
- XPath overlay system stays dormant (code remains for backward compat, but `highlights` array stays empty since all selections now create marks).

## 2026-04-10

### Reader-mode highlight sync performance fix
- Replaced Obsidian reader SSE refresh in `src/utils/reader.ts` so linked notes no longer re-fetch `/page` on every highlight add/remove.
- `refreshObsidianContent()` now calls `/highlights?url=...`, diffs current `.reading-selection-highlight-mark` nodes by `data-highlight-id`, unwraps deleted highlights, and applies only new highlights with `findTextRange()` + `wrapRangeInMarks()`.
- Initial reader entry still uses the existing rendered note HTML path, so Obsidian-linked notes continue to load from `/page` first with baked markup.
- Preserved optimistic sync behavior by keeping unsettled pending adds in the DOM and suppressing re-adding unsettled pending removals until the plugin state catches up.
- Skipped orphaned highlights when text anchoring fails during incremental sync instead of forcing a full article re-render.

## 2026-04-11

### E2E test suite for highlight sync
- Added Playwright-based e2e infrastructure in `e2e/` covering all six ordered pairs of highlight propagation between Web page (W), Reader mode (R), and Obsidian (O):
  - `e2e/fake-plugin.ts` — HTTP+SSE server mimicking the real plugin contract (`/health`, `/page`, `/highlights`, `/highlights/add`, `/highlights/remove`, `/highlights/stream`) with test hooks (`registerNote`, `injectHighlightFromObsidian`, `waitForClipperAdd`).
  - `e2e/fixture-server.ts` + `e2e/fixtures/article.html` — static HTTP server on `:3100` so content_scripts can inject (file:// not matched by manifest).
  - `e2e/test-fixture.ts` — Playwright test fixture that launches Chromium headed with the `dev/` extension via `--load-extension`, and uses `context.route('**/*')` to redirect all `:27124` traffic to the fake plugin on `:27125` so the real Obsidian plugin can keep running on `:27124` during tests.
  - `e2e/sync.spec.ts` — the six tests. Latency measured from `page.mouse.up()` (for source actions) / `injectHighlightFromObsidian` (for Obsidian-origin) to the destination surface observing the change. All six complete in ~11s with every latency under the 100ms budget.
- Decisions and abandoned paths:
  - **Firefox first**: tried Playwright + `playwright-webextext` for Firefox extension loading. Worked for installing the extension, but `context.route()` does NOT intercept extension background-page fetches on Firefox, so transparent `:27124` → fake-plugin redirection wasn't possible. Would have required either (a) the user quitting Obsidian for every test run, or (b) hard-coding the fake plugin on 27124 which required a preflight and was fragile. Switched to Chrome.
  - **Chrome routing**: `context.route()` DOES intercept extension service-worker fetches on Chromium, so the fake plugin lives on `:27125` and the real Obsidian plugin can stay up on `:27124`. Dropped the `playwright-webextext` dep.
  - **Reader mode toggle**: `page.keyboard.press('Alt+Shift+R')` doesn't reliably trigger the browser-level extension command. Instead the test helper evaluates inside the extension service worker (`context.serviceWorkers()`) to call `chrome.scripting.executeScript` + `chrome.tabs.sendMessage` — replicating what the background's `toggle_reader` command handler does. Uses `page.bringToFront()` before querying `chrome.tabs.query({ active: true })` so the correct tab is targeted when multiple tabs share the same URL (R→W, W→R).
  - **Highlighter toggle**: `page.keyboard.press('h')` works fine because `content.ts` has a plain-`h` keydown listener (not a browser-level command).
  - **Latency measurement**: initial runs failed at 447ms because `dragSelect` timed the entire mouse-drag animation. Refactored so `dragSelect` stops before the mouseup and a separate `releaseDrag(page)` fires it; timer starts just before the release. This measures the actual propagation (mouseup → content script → pluginFetch → background → HTTP POST → fake plugin state), which is well under 100ms.
  - **Headless**: initially ran headed because `--load-extension` is not supported by Playwright's bundled Chromium **headless shell**. Later switched to `channel: 'chromium'` + `headless: true`, which uses the full Chromium binary in new-headless mode and DOES support extensions. No more window popping up and stealing focus.
- Added `build:chrome:dev` and `test:e2e` scripts. `test:e2e` builds the unminified `dev/` bundle and runs Playwright. No CI yet — run locally before touching highlight code.

### Tier 1 e2e expansion: link-click regression tests + remove propagation
- **Two production bugs found by the new tests** (both in `src/utils/reader-highlights.ts`):
  1. **Link-guard direction was wrong** in `attachMarkClickHandler`. Existing code checked `mark.contains(clickedLink)` — only true when the mark wraps the link. But `wrapRangeInMarks` wraps individual text nodes, so selecting text inside a single `<a>` puts the mark INSIDE the link, not wrapping it, and the guard failed silently. Clicking a highlighted link deleted the highlight. Fix: replaced with `if (target.closest('a[href]')) return;` — covers all containment directions.
  2. **Hash-only navigation wiped highlights**. `handleUrlChange` fired on any URL change (including in-page anchor clicks like `#section`), called `pageSync.update(newUrl)` with the hashed URL, and `loadAndApplyPageHighlights()` then fetched `/highlights?url=...#section` from the plugin. The plugin keys by base URL so it returned empty; the diff step in `loadAndApplyPageHighlights` saw "desired = {}, existing = {marks}" and removed all marks. Any internal anchor click killed every highlight on the page. Fix: added `lastSyncedPath` + `stripHash()` so `handleUrlChange` is a no-op when only the hash portion changed.
- **Expanded e2e suite from 6 to 14 tests** — add and remove propagation for all six W/R/O ordered pairs, plus two link-click regression guards:
  - `page+highlighter mode: clicking a highlighted link keeps the highlight (navigation blocked)` — validates both that `disableLinkClicks()` prevents navigation while highlighter is active AND the new link guard preserves the highlight.
  - `reader mode: clicking a highlighted link navigates and keeps the highlight` — validates that reader mode (no disableLinkClicks) navigates normally, that the hash-nav fix keeps the highlight, and that the link guard fires in reader mode's `wireMarkClickHandlers` path too.
- **New test helpers**:
  - `programmaticSelectAndRelease()` — creates a selection spanning multiple text nodes (e.g. text that straddles an `<a>` boundary) via `window.getSelection()` + `document.dispatchEvent(mouseup)`. Needed for selections `dragSelect` can't handle with its single-text-node walker.
  - `clickMarkById()` — dispatches a synthetic `click` event via `page.evaluate()` instead of `locator.click()`. The full locator click sequence (scroll, stability, hover, mousedown, mouseup) eats 300+ ms of CDP round-trips and blew the 100ms latency budget on remove tests. Synthetic dispatch is instant.
  - `waitForMarkGone()` — mirror of `waitForMarkWithText` for the remove tests.
- **Full suite runs in ~18s headless**, all 14 tests under the 100ms per-pair latency budget.
- `.gitignore` now excludes `test-results/` and `playwright-report/`.

### Ripped out the fake plugin: all e2e tests now hit the real plugin

- User flagged the fake plugin as a drift risk: "will that not drift, making the tests useless". Correct — the fake was re-implementing the plugin contract by hand, and would silently diverge from reality over time.
- Deleted `e2e/fake-plugin.ts` (~250 lines) entirely. Replaced with `e2e/real-plugin.ts` — a thin 100-line HTTP client that talks to the actual `reading-selection-highlight` plugin running in Obsidian on `http://localhost:27124`.
- Test fixture now preflights `GET /health` before every test run and fails loudly with setup instructions if Obsidian isn't running. `realPlugin.ensureTestNote()` runs once per session and idempotently clips a linked note at `E2E/e2e-test-fixture.md` with `source: "http://127.0.0.1:3100/article.html"`, so the `/page` endpoint returns rich content in reader-mode tests. The note stays in the vault permanently — one note in `E2E/` that you see once and ignore forever. Each test clears plugin state for the test URL in `beforeEach` and `afterEach`.
- **No more `context.route()` redirect.** With the fake gone, traffic goes directly to the real plugin on `:27124`. `context.route()` only shows up in the offline test, where it's used for fault injection (`route.fulfill({ status: 503 })`) to simulate the plugin being unreachable.
- **Waiters → `expect.poll`.** `fakePlugin.waitForClipperAdd()` / `waitForClipperRemove()` are gone; tests poll `realPlugin.getHighlights(url)` with short intervals (`[10, 10, 20, 30, 50, 100]`) until the expected state is reached. Adds ~10-50ms of bias to latency measurements but wall-clock fine.
- **Latency budget bumped from 100ms to 1500ms.** The real plugin writes the per-URL highlight state to disk on every mutation, so the remove path especially takes ~800-1100ms against the real plugin where the fake was ~20ms. Honest numbers from the new run: add paths ~30-200ms, remove paths ~900-1100ms, reader-mode crosses ~1200-1500ms. The aspirational sub-100ms number was an artifact of how fast in-memory fakes can be — not how fast Obsidian+disk can be.
- **Bugs and rough edges shaken out during the migration:**
  - `fixture-server.ts` hung on teardown because Chrome's HTTP keep-alive connections blocked `server.close()` indefinitely. Added `server.closeAllConnections()` before close to force-drop them. Every test was failing with `Tearing down "fixtureServer" exceeded the test timeout` until this fix.
  - `programmaticSelectAndRelease` was using `root.innerText` for substring search but walking text nodes with `Text.data.length` for offsets — innerText collapses leading indentation whitespace, raw data does not, so the computed range drifted by a few chars on paragraphs with HTML indentation. Caught by the merge test. Switched to `root.textContent` which is the raw concatenation and matches node offsets exactly.
  - The clipper's word-boundary expansion at `src/utils/reader-highlights.ts:322` includes trailing punctuation, so selecting `"opal jewels"` ends up stored as `"opal jewels."`. Tests originally did `expect(array).toContain('opal jewels')` which is an exact-element match. Added a `pollForHighlightText` helper that does substring-containment instead.
  - Obsidian's markdown renderer annotates internal links with `target="_blank"` — clicking one would open a new tab instead of navigating the current page. The reader-mode link test strips the `target` attribute before clicking.
  - Reader mode is toggled via a service-worker `evaluate` that calls `chrome.scripting.executeScript('reader-script.js')` + `chrome.tabs.sendMessage('toggleReaderMode')` — same plumbing as before, still works with the real plugin.
- **Full suite runs in ~28s against the real plugin**, all 19 tests passing. Run with `bun run test:e2e`. Requires Obsidian running with the plugin enabled on `:27124`; preflight fails fast otherwise.
- The test note in `E2E/e2e-test-fixture.md` is the one intentional side effect of running the suite — it lives in the vault forever. If you ever delete it, the next test run will re-create it via `/clip`.
