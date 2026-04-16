import { describe, test, expect } from 'vitest';
import { Defuddle } from '../src/node';
import { parseDocument } from './helpers';

function parse(html: string, url = 'https://example.com') {
	const doc = parseDocument(html, url);
	return Defuddle(doc, url, { separateMarkdown: true });
}

// ── ARIA role-based table conversion ─────────────────────────

describe('ARIA role-based tables', () => {
	test('converts div[role="table"] to semantic table', async () => {
		const result = await parse(`
			<html><head><title>T</title></head><body><main>
			<p>Data:</p>
			<div>
				<div role="rowgroup">
					<div role="row">
						<div role="columnheader">Name</div>
						<div role="columnheader">Age</div>
					</div>
				</div>
				<div role="table">
					<div role="rowgroup">
						<div role="row">
							<div role="cell">Alice</div>
							<div role="cell">30</div>
						</div>
						<div role="row">
							<div role="cell">Bob</div>
							<div role="cell">25</div>
						</div>
					</div>
				</div>
			</div>
			</main></body></html>
		`);
		expect(result.contentMarkdown).toContain('| Name | Age |');
		expect(result.contentMarkdown).toContain('| Alice | 30 |');
		expect(result.contentMarkdown).toContain('| Bob | 25 |');
	});

	test('handles columnheaders inside role="table"', async () => {
		const result = await parse(`
			<html><head><title>T</title></head><body><main>
			<div role="table">
				<div role="rowgroup">
					<div role="row">
						<div role="columnheader">X</div>
						<div role="columnheader">Y</div>
					</div>
				</div>
				<div role="rowgroup">
					<div role="row">
						<div role="cell">1</div>
						<div role="cell">2</div>
					</div>
				</div>
			</div>
			</main></body></html>
		`);
		expect(result.contentMarkdown).toContain('| X | Y |');
		expect(result.contentMarkdown).toContain('| 1 | 2 |');
	});

	test('table without columnheaders still converts rows', async () => {
		const result = await parse(`
			<html><head><title>T</title></head><body><main>
			<div role="table">
				<div role="rowgroup">
					<div role="row">
						<div role="cell">A</div>
						<div role="cell">B</div>
					</div>
				</div>
			</div>
			</main></body></html>
		`);
		expect(result.contentMarkdown).toContain('A');
		expect(result.contentMarkdown).toContain('B');
	});
});

// ── Decorative SVG removal from links ────────────────────────

describe('decorative SVG in links', () => {
	test('removes SVG from link that has text', async () => {
		const result = await parse(`
			<html><head><title>T</title></head><body><main>
			<p>Read <a href="https://example.com">more info <svg><title>arrow</title><rect width="100%" height="100%"></rect></svg></a> here.</p>
			</main></body></html>
		`);
		expect(result.content).not.toContain('<svg');
		expect(result.content).not.toContain('</svg>');
		expect(result.contentMarkdown).toContain('[more info]');
	});

	test('preserves SVG-only links (no text content)', async () => {
		const result = await parse(`
			<html><head><title>T</title></head><body><main>
			<p>Click <a href="https://example.com"><svg width="20" height="20"><circle cx="10" cy="10" r="10"></circle></svg></a> icon.</p>
			</main></body></html>
		`);
		// SVG preserved since it's the only content
		expect(result.content).toContain('<svg');
	});

	test('removes multiple SVGs from different links', async () => {
		const result = await parse(`
			<html><head><title>T</title></head><body><main>
			<p><a href="/a">Link A <svg><rect></rect></svg></a> and <a href="/b">Link B <svg><rect></rect></svg></a></p>
			</main></body></html>
		`);
		expect(result.contentMarkdown).toContain('[Link A]');
		expect(result.contentMarkdown).toContain('[Link B]');
		expect(result.content).not.toContain('<svg');
	});
});

// ── Style attribute handling in code blocks ──────────────────
// Note: defuddle's code handler extracts plain text and rebuilds code blocks,
// so inline styles don't survive to the final output. These tests verify the
// attribute-stripping rules work correctly at the standardize level.

describe('style attribute stripping', () => {
	test('strips style outside code blocks', async () => {
		const result = await parse(`
			<html><head><title>T</title></head><body><main>
			<p><span style="color: red">red text</span></p>
			</main></body></html>
		`);
		expect(result.content).not.toContain('style=');
	});

	test('strips layout styles from code block spans', async () => {
		const result = await parse(`
			<html><head><title>T</title></head><body><main>
			<pre><code><span style="display: block; position: absolute">code</span></code></pre>
			</main></body></html>
		`);
		// Layout-affecting styles should be stripped even inside code blocks
		expect(result.content).not.toContain('display: block');
		expect(result.content).not.toContain('position: absolute');
	});

	test('code block text content is preserved regardless of styles', async () => {
		const result = await parse(`
			<html><head><title>T</title></head><body><main>
			<pre><code><span style="color: red">const</span> x = <span style="color: green">42</span>;</code></pre>
			</main></body></html>
		`);
		expect(result.contentMarkdown).toContain('const x = 42;');
	});
});
