import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * Tiny static server for e2e fixture pages.
 *
 * Extension content_scripts only match http(s), not file://, so fixtures
 * must be served over HTTP. We bind to 127.0.0.1 and pick a stable
 * non-privileged port so tests can construct URLs deterministically.
 */
export class FixtureServer {
	private server: http.Server | null = null;
	private rootDir: string;
	public port: number = 0;

	constructor(rootDir: string) {
		this.rootDir = rootDir;
	}

	async start(port = 3100): Promise<number> {
		this.server = http.createServer(async (req, res) => {
			try {
				const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
				let pathname = url.pathname;
				if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html';
				const filePath = path.join(this.rootDir, pathname);
				// Guard against path traversal
				if (!filePath.startsWith(this.rootDir)) {
					res.statusCode = 403;
					res.end('forbidden');
					return;
				}
				const body = await fs.readFile(filePath);
				const ext = path.extname(filePath).toLowerCase();
				const mime: Record<string, string> = {
					'.html': 'text/html; charset=utf-8',
					'.css': 'text/css; charset=utf-8',
					'.js': 'application/javascript; charset=utf-8',
				};
				res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
				res.statusCode = 200;
				res.end(body);
			} catch {
				res.statusCode = 404;
				res.end('not found');
			}
		});
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			this.server!.once('error', onError);
			this.server!.listen(port, '127.0.0.1', () => {
				this.server!.removeListener('error', onError);
				resolve();
			});
		});
		this.port = (this.server!.address() as AddressInfo).port;
		return this.port;
	}

	async stop(): Promise<void> {
		if (this.server) {
			// Chrome holds HTTP/1.1 keep-alive connections open; plain close()
			// waits for them to drain (hangs until the browser closes the tab).
			// Force-drop them so teardown returns promptly.
			this.server.closeAllConnections?.();
			await new Promise<void>(resolve => this.server!.close(() => resolve()));
			this.server = null;
		}
	}

	urlFor(pathname: string): string {
		return `http://127.0.0.1:${this.port}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
	}
}
