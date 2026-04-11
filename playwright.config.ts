import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.spec.ts',
	// Firefox extensions require a persistent context + headed browser, and the
	// playwright-webextext wrapper installs the extension per-worker. Keep workers
	// at 1 to avoid two browsers fighting over :27124.
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		// Playwright-webextext requires headed; we inherit that from its fixture.
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'off',
	},
	timeout: 30_000,
	expect: {
		timeout: 5_000,
	},
});
