import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Fake reading-selection-highlight plugin HTTP+SSE server.
 *
 * Mimics the contract that the clipper's background.ts and plugin-url.ts
 * expect on localhost:27124. In-memory only, no persistence.
 *
 * Test hooks:
 *   - registerNote(url, note) — map a URL to a linked Obsidian note
 *   - injectHighlightFromObsidian(url, h) — simulate user highlighting
 *       inside Obsidian. Pushes SSE event to subscribed streams.
 *   - getHighlights(url) — inspect current state
 *   - waitForClipperAdd(url) — promise resolves the next time the clipper
 *       POSTs /highlights/add for this url (used for W→O, R→O tests)
 */

export interface FakeHighlight {
	id: string;
	exactText: string;
	prefixText: string;
	suffixText: string;
}

export interface FakeNote {
	notePath: string;
	title: string;
	/** HTML body returned by /page?url= — used by reader mode for linked notes. */
	content: string;
	noteModified?: number;
}

interface StreamClient {
	url: string;
	res: http.ServerResponse;
}

function normalizeUrl(url: string): string {
	return url.replace(/#:~:text=[^&]+(&|$)/, '');
}

export class FakePlugin {
	private server: http.Server | null = null;
	private notes = new Map<string, FakeNote>();
	private highlights = new Map<string, FakeHighlight[]>();
	private streams: StreamClient[] = [];
	private addWaiters = new Map<string, Array<(h: FakeHighlight) => void>>();
	private removeWaiters = new Map<string, Array<(id: string) => void>>();

	async start(port = 27124): Promise<number> {
		this.server = http.createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			this.server!.once('error', onError);
			this.server!.listen(port, '127.0.0.1', () => {
				this.server!.removeListener('error', onError);
				resolve();
			});
		});
		return (this.server!.address() as AddressInfo).port;
	}

	async stop(): Promise<void> {
		// Close all SSE streams first — they'd keep the server alive forever
		for (const s of this.streams) {
			try { s.res.end(); } catch { /* ignore */ }
		}
		this.streams = [];
		if (this.server) {
			await new Promise<void>(resolve => this.server!.close(() => resolve()));
			this.server = null;
		}
		this.notes.clear();
		this.highlights.clear();
		this.addWaiters.clear();
		this.removeWaiters.clear();
	}

	// ── Test hooks ────────────────────────────────────────────

	registerNote(url: string, note: FakeNote): void {
		this.notes.set(normalizeUrl(url), note);
	}

	getHighlights(url: string): FakeHighlight[] {
		return this.highlights.get(normalizeUrl(url)) ?? [];
	}

	/** Simulate Obsidian adding a highlight to a note. Pushes SSE to subscribers. */
	injectHighlightFromObsidian(url: string, h: FakeHighlight): void {
		const key = normalizeUrl(url);
		const list = this.highlights.get(key) ?? [];
		list.push(h);
		this.highlights.set(key, list);
		this.broadcastChange(key);
	}

	/** Simulate Obsidian removing a highlight. Pushes SSE to subscribers. */
	removeHighlightFromObsidian(url: string, highlightId: string): void {
		const key = normalizeUrl(url);
		const list = (this.highlights.get(key) ?? []).filter(h => h.id !== highlightId);
		this.highlights.set(key, list);
		this.broadcastChange(key);
	}

	/** Resolves the next time the clipper POSTs /highlights/add for this url. */
	waitForClipperAdd(url: string): Promise<FakeHighlight> {
		const key = normalizeUrl(url);
		return new Promise(resolve => {
			const list = this.addWaiters.get(key) ?? [];
			list.push(resolve);
			this.addWaiters.set(key, list);
		});
	}

	/** Resolves the next time the clipper POSTs /highlights/remove for this url. */
	waitForClipperRemove(url: string): Promise<string> {
		const key = normalizeUrl(url);
		return new Promise(resolve => {
			const list = this.removeWaiters.get(key) ?? [];
			list.push(resolve);
			this.removeWaiters.set(key, list);
		});
	}

	// ── HTTP handling ─────────────────────────────────────────

	private broadcastChange(url: string): void {
		const payload = `data: ${JSON.stringify({ url, changedAt: Date.now() })}\n\n`;
		for (const s of this.streams) {
			if (s.url === url) {
				try { s.res.write(payload); } catch { /* ignore */ }
			}
		}
	}

	private cors(res: http.ServerResponse): void {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	}

	private json(res: http.ServerResponse, status: number, body: unknown): void {
		this.cors(res);
		res.statusCode = status;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify(body));
	}

	private async readBody(req: http.IncomingMessage): Promise<any> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(Buffer.from(c)));
			req.on('end', () => {
				const raw = Buffer.concat(chunks).toString('utf8');
				if (!raw) return resolve({});
				try { resolve(JSON.parse(raw)); }
				catch (e) { reject(e); }
			});
			req.on('error', reject);
		});
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1:27124');
		const path = url.pathname;

		if (req.method === 'OPTIONS') {
			this.cors(res);
			res.statusCode = 204;
			res.end();
			return;
		}

		if (path === '/health') {
			return this.json(res, 200, { status: 'ok' });
		}

		if (path === '/page' && req.method === 'GET') {
			const target = normalizeUrl(url.searchParams.get('url') ?? '');
			const note = this.notes.get(target);
			if (!note) {
				return this.json(res, 404, { error: 'no note linked to this url' });
			}
			return this.json(res, 200, {
				notePath: note.notePath,
				title: note.title,
				content: note.content,
				noteModified: note.noteModified ?? Date.now(),
			});
		}

		if (path === '/highlights' && req.method === 'GET') {
			const target = normalizeUrl(url.searchParams.get('url') ?? '');
			const highlights = this.highlights.get(target) ?? [];
			return this.json(res, 200, { entry: { highlights } });
		}

		if (path === '/highlights/add' && req.method === 'POST') {
			this.readBody(req).then((body) => {
				const target = normalizeUrl(body.url ?? '');
				const h = body.highlight as FakeHighlight;
				if (!target || !h || !h.id) {
					return this.json(res, 400, { error: 'missing url or highlight' });
				}
				const list = this.highlights.get(target) ?? [];
				// Dedupe by id
				if (!list.find(x => x.id === h.id)) list.push(h);
				this.highlights.set(target, list);
				// Notify waiters (so tests can observe the exact add call)
				const waiters = this.addWaiters.get(target) ?? [];
				this.addWaiters.set(target, []);
				for (const w of waiters) w(h);
				// Broadcast so other subscribed views pick it up
				this.broadcastChange(target);
				return this.json(res, 200, { ok: true });
			}).catch(() => this.json(res, 400, { error: 'invalid json' }));
			return;
		}

		if (path === '/highlights/remove' && req.method === 'POST') {
			this.readBody(req).then((body) => {
				const target = normalizeUrl(body.url ?? '');
				const id = body.highlightId as string;
				if (!target || !id) {
					return this.json(res, 400, { error: 'missing url or highlightId' });
				}
				const list = (this.highlights.get(target) ?? []).filter(h => h.id !== id);
				this.highlights.set(target, list);
				const waiters = this.removeWaiters.get(target) ?? [];
				this.removeWaiters.set(target, []);
				for (const w of waiters) w(id);
				this.broadcastChange(target);
				return this.json(res, 200, { ok: true });
			}).catch(() => this.json(res, 400, { error: 'invalid json' }));
			return;
		}

		if (path === '/highlights/stream' && req.method === 'GET') {
			const target = normalizeUrl(url.searchParams.get('url') ?? '');
			this.cors(res);
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('Connection', 'keep-alive');
			res.statusCode = 200;
			// Initial comment so the client knows the stream is open
			res.write(': connected\n\n');
			const client: StreamClient = { url: target, res };
			this.streams.push(client);
			const cleanup = () => {
				this.streams = this.streams.filter(s => s !== client);
			};
			req.on('close', cleanup);
			req.on('error', cleanup);
			return;
		}

		this.cors(res);
		res.statusCode = 404;
		res.end(JSON.stringify({ error: `unknown route ${req.method} ${path}` }));
	}
}
