import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { test as base, chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { FixtureServer } from './fixture-server';
import { RealPluginClient, TEST_ARTICLE_URL } from './real-plugin';

/**
 * Test fixture for the clipper e2e suite. No mocks — every test talks to the
 * real reading-selection-highlight plugin running in Obsidian on :27124.
 *
 * All expensive setup is worker-scoped and reused across every test:
 *   - `context`  — a persistent Chromium with the dev/ extension loaded,
 *                  launched once per worker. Per-test isolation comes from
 *                  a fresh `page` and a plugin-state reset in beforeEach.
 *   - `fixtureServer` — static HTTP server on :3100, started once.
 *   - `realPlugin`    — preflights /health once, ensures the test note
 *                       exists once, then hands out a plain HTTP client.
 *
 * Per-test hygiene lives in `beforeEach`/`afterEach` at the top of
 * sync.spec.ts — they clear highlights on the test URL and drop any
 * routes the test installed, so shared-context doesn't leak state.
 *
 * Preconditions:
 *   - Obsidian is running with the reading-selection-highlight plugin enabled.
 *   - Plugin HTTP server listening on 127.0.0.1:27124.
 * Preflight check fails fast with a clear message otherwise.
 *
 * Runs headless via `channel: 'chromium'` + `headless: true` (the full
 * Chromium binary in new-headless mode supports --load-extension). One
 * worker — the plugin is global shared state.
 */

type WorkerFixtures = {
	realPlugin: RealPluginClient;
	fixtureServer: FixtureServer;
	workerContext: BrowserContext;
	articleUrl: string;
};

type TestFixtures = {
	// override the default test-scoped context/page so they delegate to
	// the worker-scoped extension context
	context: BrowserContext;
	page: import('@playwright/test').Page;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
	realPlugin: [async ({}, use) => {
		const plugin = new RealPluginClient();
		const ok = await plugin.health();
		if (!ok) {
			throw new Error(
				'\n\nReal reading-selection-highlight plugin is not reachable on localhost:27124.\n' +
				'These tests talk to the real plugin — no mocks. To run them:\n' +
				'  1. Open Obsidian with the reading-selection-highlight plugin enabled.\n' +
				'  2. Verify `curl http://localhost:27124/health` returns 200.\n' +
				'  3. Rerun the tests.\n'
			);
		}
		await plugin.ensureTestNote();
		await use(plugin);
	}, { scope: 'worker' }],

	// The actual persistent Chromium with the extension loaded — worker-scoped,
	// launched ONCE per worker. Don't depend on it directly from tests; use the
	// `context` fixture below which re-exposes it as test-scoped.
	workerContext: [async ({ realPlugin }, use) => {
		void realPlugin; // dependency forces preflight before the browser opens
		const extPath = path.resolve(__dirname, '..', 'dev');
		const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-e2e-'));
		const ctx = await chromium.launchPersistentContext(profileDir, {
			headless: true,
			channel: 'chromium',
			args: [
				`--disable-extensions-except=${extPath}`,
				`--load-extension=${extPath}`,
			],
		});
		await use(ctx);
		await ctx.close();
	}, { scope: 'worker' }],

	fixtureServer: [async ({}, use) => {
		const server = new FixtureServer(path.resolve(__dirname, 'fixtures'));
		await server.start(3100);
		await use(server);
		await server.stop();
	}, { scope: 'worker' }],

	articleUrl: [async ({ fixtureServer }, use) => {
		void fixtureServer; // ensure the static server is up
		await use(TEST_ARTICLE_URL);
	}, { scope: 'worker' }],

	// Test-scoped context just re-exposes the worker context. Playwright's
	// built-in `page` fixture depends on `context` so overriding here makes
	// `page` also use the shared Chromium under the hood.
	context: async ({ workerContext }, use) => {
		await use(workerContext);
	},

	// Fresh page per test, created from the shared context and closed at
	// the end. Keeps per-test DOM isolation without relaunching the browser.
	page: async ({ context }, use) => {
		const page = await context.newPage();
		await use(page);
		await page.close();
	},
});

export { expect } from '@playwright/test';
