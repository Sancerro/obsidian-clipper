import { describe, expect, test } from 'vitest';
import { normalizeProoftreesForObsidian } from './prooftree-markdown';

describe('normalizeProoftreesForObsidian', () => {
	test('unwraps inline prooftrees from dollar math', () => {
		const input = String.raw`*modus ponens*: $\begin{prooftree}
\AxiomC{\(\rA\supset\rB\)}\AxiomC{\(\rA\)}\BinaryInfC{\(\rB\)}
\end{prooftree}$`;
		const output = normalizeProoftreesForObsidian(input);

		expect(output).toContain('$$');
		expect(output).toContain(String.raw`\require{bussproofs}`);
		expect(output).toContain(String.raw`\begin{prooftree}`);
		expect(output).toContain(String.raw`\AxiomC{\rA\supset\rB}`);
		expect(output).toContain(String.raw`\BinaryInfC{\rB}`);
	});

	test('unwraps display prooftrees from double-dollar math', () => {
		const input = String.raw`$$
\begin{prooftree}
\AxiomC{$\rA$}
\UnaryInfC{$\rB$}
\end{prooftree}
$$`;
		const output = normalizeProoftreesForObsidian(input);

		expect(output).toContain('$$');
		expect(output).toContain(String.raw`\require{bussproofs}`);
		expect(output).toContain(String.raw`\AxiomC{\rA}`);
		expect(output).toContain(String.raw`\UnaryInfC{\rB}`);
	});

	test('unwraps malformed mixed wrappers produced by nested delimiter clipping', () => {
		const input = String.raw`*modus ponens*: $\begin{prooftree}
\AxiomC{\(\rA\supset\rB$}\AxiomC{$\rA$}\BinaryInfC{$\rB$}
\end{prooftree}\)`;
		const output = normalizeProoftreesForObsidian(input);

		expect(output).toContain('$$');
		expect(output).toContain(String.raw`\require{bussproofs}`);
		expect(output).toContain(String.raw`\AxiomC{\rA\supset\rB}`);
		expect(output).toContain(String.raw`\BinaryInfC{\rB}`);
	});

	test('splits multi-tree display blocks into separate $$ blocks', () => {
		const input = String.raw`$$
\hspace{-10em}
\begin{prooftree} \AxiomC{\(\rA\supset\rB\)} \AxiomC{\(\rA\)}
\RightLabel{\({\supset}\text{elim}\)} \BinaryInfC{\(\rB\)}
\end{prooftree}
\hspace{4em}
\begin{prooftree} \AxiomC{\(\rA\wedge\rB\)} \UnaryInfC{\(\rA\)}
\end{prooftree}
$$`;
		const output = normalizeProoftreesForObsidian(input);

		// Each tree gets its own $$ block
		expect(output.match(/\$\$/g)?.length).toBe(4); // 2 pairs
		expect(output.match(/\\begin\{prooftree\}/g)?.length).toBe(2);
		expect(output).toContain(String.raw`\require{bussproofs}`);
		// \hspace stripped (not meaningful in separate blocks)
		expect(output).not.toContain(String.raw`\hspace`);
		// Inner delimiters stripped
		expect(output).toContain(String.raw`\AxiomC{\rA\supset\rB}`);
		expect(output).toContain(String.raw`\RightLabel{{\supset}\text{elim}}`);
	});

	test('leaves non-prooftree math unchanged', () => {
		const input = String.raw`Euler: $e^{i\pi}+1=0$`;
		expect(normalizeProoftreesForObsidian(input)).toBe(input);
	});
});
