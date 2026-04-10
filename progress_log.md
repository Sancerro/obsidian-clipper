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
