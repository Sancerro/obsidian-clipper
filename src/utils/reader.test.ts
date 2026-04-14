// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { Reader } from './reader';

describe('Reader bussproofs normalization', () => {
	test('strips nested delimiters inside prooftree blocks', () => {
		const normalized = (Reader as any).normalizeBussproofsLatex(
			String.raw`\begin{prooftree}\AxiomC{\(\rA\supset\rB\)}\RightLabel{$\wedge$(R)}\BinaryInfC{\(\rB\)}\end{prooftree}`
		);

		expect(normalized).toContain(String.raw`\AxiomC{\rA\supset\rB}`);
		expect(normalized).toContain(String.raw`\RightLabel{\wedge(R)}`);
		expect(normalized).toContain(String.raw`\BinaryInfC{\rB}`);
		expect(normalized).not.toContain(String.raw`\(`);
		expect(normalized).not.toContain('$');
	});

	test('unwraps standalone inline prooftrees so MathJax can parse the environment', () => {
		const normalized = (Reader as any).normalizeBussproofsMathText(
			String.raw`modus ponens: \(\begin{prooftree}\AxiomC{\(\rA\)}\BinaryInfC{\(\rB\)}\end{prooftree}\)`
		);

		expect(normalized).toContain(String.raw`\begin{prooftree}`);
		expect(normalized).toContain(String.raw`\AxiomC{\rA}`);
		expect(normalized).toContain(String.raw`\BinaryInfC{\rB}`);
		expect(normalized).not.toContain(String.raw`\(\begin{prooftree}`);
		expect(normalized).not.toContain(String.raw`\end{prooftree}\)`);
	});

	test('leaves regular math unchanged', () => {
		const source = String.raw`If \(p \supset q\) and \(p\), infer \(q\).`;
		const normalized = (Reader as any).normalizeBussproofsMathText(source);

		expect(normalized).toBe(source);
	});

	test('parses a simple proof tree structure', () => {
		const tree = (Reader as any).parseProofTree(
			String.raw`\begin{prooftree}\AxiomC{\(\rA\supset\rB\)}\AxiomC{\(\rA\)}\BinaryInfC{\(\rB\)}\end{prooftree}`
		);

		expect(tree?.conclusion).toBe('rB');
		expect(tree?.premises).toHaveLength(2);
		expect(tree?.premises[0]?.conclusion).toBe('rA⊃rB');
		expect(tree?.premises[1]?.conclusion).toBe('rA');
	});
});
