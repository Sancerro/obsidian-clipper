import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { test as base, chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { FakePlugin } from './fake-plugin';
import { FixtureServer } from './fixture-server';

/**
 * Test fixture for Chromium-based e2e tests.
 *
 * Provides:
 *   - `context` — a persistent Chromium context with the dev/ extension loaded
 *     via native --load-extension. All requests to localhost:27124 are
 *     intercepted by context.route() and redirected to FAKE_PLUGIN_PORT, so
 *     the real Obsidian reading-selection-highlight plugin can remain running
 *     on 27124 without conflict. (This works on Chromium because
 *     context.route DOES intercept extension background/service-worker fetches
 *     — unlike Playwright's Firefox build.)
 *   - `page` — first page of the context
 *   - `fakePlugin` — a FakePlugin listening on 127.0.0.1:FAKE_PLUGIN_PORT
 *   - `fixtureServer` — a static server on :3100 serving e2e/fixtures/
 *   - `articleUrl` — the URL of the article fixture
 *
 * Tests run headless using `channel: 'chromium'`, which uses the full
 * Chromium binary in new-headless mode — the headless shell does NOT
 * support `--load-extension`, but new-headless does. No window is shown,
 * no workspace is stolen, ~9s per full run.
 *
 * Only one worker at a time (playwright.config.ts enforces this).
 */

const FAKE_PLUGIN_PORT = 27125;

type Fixtures = {
	context: BrowserContext;
	fakePlugin: FakePlugin;
	fixtureServer: FixtureServer;
	articleUrl: string;
};

export const test = base.extend<Fixtures>({
	fakePlugin: async ({}, use) => {
		const plugin = new FakePlugin();
		await plugin.start(FAKE_PLUGIN_PORT);
		await use(plugin);
		await plugin.stop();
	},

	context: async ({ fakePlugin }, use) => {
		void fakePlugin; // dependency: fake is up before extension wakes
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

		// Redirect all :27124 traffic to the fake plugin on :FAKE_PLUGIN_PORT.
		// Works for both fetch() and EventSource since route.continue streams
		// the upstream response through unchanged.
		await ctx.route('**/*', async (route) => {
			const url = route.request().url();
			if (url.startsWith('http://localhost:27124') || url.startsWith('http://127.0.0.1:27124')) {
				const rewritten = url.replace(/:27124/, `:${FAKE_PLUGIN_PORT}`);
				await route.continue({ url: rewritten });
			} else {
				await route.continue();
			}
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
		await use(fixtureServer.urlFor('/article.html'));
	},
});

export { expect } from '@playwright/test';
