import { describe, expect, test } from 'vitest';
import { normalizeMacrosForObsidian, renderMacroDefsForObsidian } from './obsidian-math-macros';

describe('normalizeMacrosForObsidian', () => {
	test('rewrites problematic turnstile-style macros to simpler Obsidian-safe forms', () => {
		const normalized = normalizeMacrosForObsidian({
			turnstile: ['\\mathbin{\\scriptsize\\begin{array}{|c}x\\end{array}}', 1],
			dturnstile: ['\\mathbin{\\scriptsize\\begin{array}{|c}y\\end{array}}', 1],
			Lrightarrow: '\\mathbin{\\Large\\rightarrow}',
			CPC: '\\text{CPC}',
		});

		expect(normalized.turnstile).toEqual(['\\mathrel{\\vdash_{#1}}', 1]);
		expect(normalized.dturnstile).toEqual(['\\mathrel{\\vDash_{#1}}', 1]);
		expect(normalized.Lrightarrow).toBe('\\mathbin{\\rightarrow}');
		expect(normalized.CPC).toBe('\\text{CPC}');
	});

	test('renders normalized macro definitions', () => {
		const defs = renderMacroDefsForObsidian({
			turnstile: ['bad', 1],
			CPC: '\\text{CPC}',
		});

		expect(defs).toContain(String.raw`\newcommand{\turnstile}[1]{\mathrel{\vdash_{#1}}}`);
		expect(defs).toContain(String.raw`\newcommand{\CPC}{\text{CPC}}`);
	});

	test('does not emit duplicate definitions for backslash-prefixed keys', () => {
		const defs = renderMacroDefsForObsidian({
			'\\turnstile': ['bad-complex', 1],
			'\\CPC': '\\text{CPC}',
		});

		// Should have exactly one \turnstile definition (the normalized one)
		const turnstileCount = (defs.match(/\\newcommand\{\\turnstile\}/g) || []).length;
		expect(turnstileCount).toBe(1);
		expect(defs).toContain(String.raw`\newcommand{\turnstile}[1]{\mathrel{\vdash_{#1}}}`);
		expect(defs).not.toContain('bad-complex');
	});
});
