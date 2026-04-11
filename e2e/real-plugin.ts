/**
 * Thin client for the real reading-selection-highlight plugin running at
 * http://localhost:27124. No mocks — every e2e test hits this during setup,
 * assertions, and teardown.
 *
 * The plugin must be running inside Obsidian before tests start. The
 * preflight check in test-fixture.ts fails loudly if /health doesn't answer.
 *
 * Test state lives on a dedicated URL (TEST_ARTICLE_URL below) and a
 * dedicated vault folder (E2E/e2e-test-fixture.md). Tests clear the plugin's
 * highlight state for the test URL before and after each case, so runs are
 * independent. The test note itself is created once via /clip on first run
 * and left in the vault permanently — one note in E2E/ that you see once
 * and ignore forever.
 */

export interface Highlight {
	id: string;
	exactText: string;
	prefixText: string;
	suffixText: string;
}

interface HighlightsResponse {
	ok: boolean;
	entry?: {
		url: string;
		title?: string;
		highlights: Highlight[];
	};
	notePath?: string | null;
}

interface PageResponse {
	ok: boolean;
	notePath: string | null;
	title?: string;
	content?: string;
	noteModified?: number;
}

export const PLUGIN_BASE_URL = 'http://localhost:27124';

/** The article URL our fixture server serves the test HTML on. */
export const TEST_ARTICLE_URL = 'http://127.0.0.1:3100/article.html';

/** A second linked note for transcript / video / player UI tests. */
export const TEST_TRANSCRIPT_URL = 'http://127.0.0.1:3100/transcript.html';

/** Vault path of the main article note. */
export const TEST_NOTE_PATH = 'E2E/e2e-test-fixture.md';

/** Vault path of the transcript fixture note. */
export const TEST_TRANSCRIPT_NOTE_PATH = 'E2E/e2e-transcript-fixture.md';

const TEST_NOTE_MARKDOWN =
	'# The fixture article\n\n' +
	'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump. Sphinx of black quartz, judge my vow.\n\n' +
	'Bright vixens jump; dozy fowl quack. The five boxing wizards jump quickly. Jackdaws love my big sphinx of quartz. Waltz, bad nymph, for quick jigs vex.\n\n' +
	'Crazy Fredrick bought many very exquisite opal jewels. A mad boxer shot a quick, gloved jab to the jaw of his dizzy opponent.\n\n' +
	'Read more about [linked foxes](#link-target) at the end of this article.\n\n' +
	'This is where the link points to.\n';

// Transcript note: raw HTML passes through Obsidian's markdown renderer
// unchanged (verified: classes + data-timestamp + attrs all preserved).
// 30 segments every 5 seconds; video points at the silent.mp4 fixture.
function buildTranscriptMarkdown(): string {
	const segments: string[] = [];
	for (let i = 0; i < 30; i++) {
		const time = i * 5;
		const mm = Math.floor(time / 60);
		const ss = (time % 60).toString().padStart(2, '0');
		const pad = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
			'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
		segments.push(
			`<div class="transcript-segment">` +
				`<strong><span class="timestamp" data-timestamp="${time}">${mm}:${ss}</span></strong>` +
				` · Segment ${i} — ${pad}` +
			`</div>`
		);
	}
	return (
		'# Transcript Fixture\n\n' +
		'<div class="reader-video-wrapper">' +
			'<video class="reader-video-player" muted playsinline preload="auto" ' +
				'src="http://127.0.0.1:3100/silent.mp4"></video>' +
		'</div>\n\n' +
		'<section class="youtube transcript">\n' +
			segments.join('\n') + '\n' +
		'</section>\n'
	);
}

export class RealPluginClient {
	constructor(private baseUrl: string = PLUGIN_BASE_URL) {}

	async health(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/health`);
			return res.ok;
		} catch {
			return false;
		}
	}

	async getHighlights(url: string): Promise<Highlight[]> {
		const res = await fetch(`${this.baseUrl}/highlights?url=${encodeURIComponent(url)}`);
		const data = (await res.json()) as HighlightsResponse;
		return data.entry?.highlights ?? [];
	}

	async addHighlight(url: string, highlight: Highlight): Promise<void> {
		const res = await fetch(`${this.baseUrl}/highlights/add`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url, highlight }),
		});
		if (!res.ok) throw new Error(`addHighlight failed: ${res.status} ${await res.text()}`);
	}

	async removeHighlight(url: string, highlightId: string): Promise<void> {
		const res = await fetch(`${this.baseUrl}/highlights/remove`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url, highlightId }),
		});
		if (!res.ok) throw new Error(`removeHighlight failed: ${res.status} ${await res.text()}`);
	}

	async clearHighlightsForUrl(url: string): Promise<void> {
		const highlights = await this.getHighlights(url);
		for (const h of highlights) {
			await this.removeHighlight(url, h.id);
		}
	}

	async page(url: string): Promise<PageResponse> {
		const res = await fetch(`${this.baseUrl}/page?url=${encodeURIComponent(url)}`);
		return (await res.json()) as PageResponse;
	}

	/** Ensure the main article note and the transcript note both exist. */
	async ensureTestNote(): Promise<void> {
		const [article, transcript] = await Promise.all([
			this.page(TEST_ARTICLE_URL),
			this.page(TEST_TRANSCRIPT_URL),
		]);
		const jobs: Array<Promise<unknown>> = [];
		if (!article.notePath) {
			jobs.push(fetch(`${this.baseUrl}/clip`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					fileContent:
						`---\nsource: "${TEST_ARTICLE_URL}"\ntitle: "E2E Fixture"\n---\n\n` +
						TEST_NOTE_MARKDOWN,
					noteName: 'e2e-test-fixture',
					path: 'E2E',
					sourceUrl: TEST_ARTICLE_URL,
					behavior: 'create',
				}),
			}));
		}
		if (!transcript.notePath) {
			jobs.push(fetch(`${this.baseUrl}/clip`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					fileContent:
						`---\nsource: "${TEST_TRANSCRIPT_URL}"\ntitle: "E2E Transcript Fixture"\n---\n\n` +
						buildTranscriptMarkdown(),
					noteName: 'e2e-transcript-fixture',
					path: 'E2E',
					sourceUrl: TEST_TRANSCRIPT_URL,
					behavior: 'create',
				}),
			}));
		}
		if (jobs.length > 0) {
			const results = await Promise.all(jobs);
			for (const res of results) {
				if (res instanceof Response && !res.ok) {
					throw new Error(`ensureTestNote /clip failed: ${res.status}`);
				}
			}
			// Give the plugin a beat to reindex frontmatter
			await new Promise((r) => setTimeout(r, 600));
		}
	}
}
