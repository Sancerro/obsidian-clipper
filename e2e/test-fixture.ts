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
 * Preconditions:
 *   - Obsidian is running with the reading-selection-highlight plugin enabled.
 *   - The plugin's HTTP server is listening on 127.0.0.1:27124.
 * The preflight check below fails fast with a clear message otherwise.
 *
 * Provides:
 *   - `context` — persistent Chromium context with the dev/ extension loaded
 *   - `page` — first page
 *   - `realPlugin` — a RealPluginClient for setup/assertions/teardown
 *   - `fixtureServer` — static HTTP server on :3100 (content_scripts need http)
 *   - `articleUrl` — the URL the test note is linked to (= TEST_ARTICLE_URL)
 *
 * Each test runs with a clean highlight state for the test URL — cleared
 * both before `use` and after teardown. The test note in E2E/ is created
 * once and left in the vault.
 *
 * Runs headless via `channel: 'chromium'` + `headless: true` (the full
 * Chromium binary in new-headless mode supports --load-extension). One
 * worker — the plugin is global shared state.
 */

type Fixtures = {
	context: BrowserContext;
	realPlugin: RealPluginClient;
	fixtureServer: FixtureServer;
	articleUrl: string;
};

// One-time preflight shared across the suite.
let preflighted = false;
async function preflight(plugin: RealPluginClient): Promise<void> {
	if (preflighted) return;
	preflighted = true;
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
}

export const test = base.extend<Fixtures>({
	realPlugin: async ({}, use) => {
		const plugin = new RealPluginClient();
		await preflight(plugin);
		// Clean slate for the test URL
		await plugin.clearHighlightsForUrl(TEST_ARTICLE_URL);
		await use(plugin);
		// Tear down: remove every highlight this test added
		await plugin.clearHighlightsForUrl(TEST_ARTICLE_URL);
	},

	context: async ({ realPlugin }, use) => {
		void realPlugin; // ensures plugin preflight ran before the browser starts
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
	},

	fixtureServer: async ({}, use) => {
		const server = new FixtureServer(path.resolve(__dirname, 'fixtures'));
		await server.start(3100);
		await use(server);
		await server.stop();
	},

	articleUrl: async ({ fixtureServer }, use) => {
		void fixtureServer; // ensure the static server is up
		await use(TEST_ARTICLE_URL);
	},
});

export { expect } from '@playwright/test';
