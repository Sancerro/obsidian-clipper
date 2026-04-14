import { describe, expect, test } from 'vitest';
import { normalizeProoftreesForObsidian } from './prooftree-markdown';

describe('prooftree clip output', () => {
	test('normalizes the broken markdown shape emitted by clipping', () => {
		const brokenClip = String.raw`The inference rules of are

- *modus ponens*: 
	$$
\begin{prooftree}
\AxiomC{{A}\supset{B}}\AxiomC{{A}}\BinaryInfC{{B}}
\end{prooftree}
	$$
- *Nicod’s inference*: 
	$$
\begin{prooftree}
\AxiomC{{A}} \AxiomC{\({A}|({B}|{C})\)} \BinaryInfC{{C}}
\end{prooftree}
	$$

Inline broken form:

*modus ponens*: $\begin{prooftree}
\AxiomC{\(\rA\supset\rB$}\AxiomC{$\rA$}\BinaryInfC{$\rB$}
\end{prooftree}\)`;

		const normalized = normalizeProoftreesForObsidian(brokenClip);

		expect(normalized).toContain(String.raw`\require{bussproofs}`);
		expect(normalized).toContain(String.raw`\begin{prooftree}`);
		expect(normalized).toContain('$$');
		expect(normalized).not.toContain(String.raw`$\begin{prooftree}`);
		expect(normalized).not.toContain('\n$\n');
		expect(normalized).not.toContain(String.raw`\AxiomC{\(`);
		expect(normalized).toContain(String.raw`\AxiomC{{A}} \AxiomC{{A}|({B}|{C})} \BinaryInfC{{C}}`);
		expect(normalized).toContain(String.raw`\AxiomC{\rA\supset\rB}`);
		expect(normalized).toContain(String.raw`\BinaryInfC{\rB}`);
	});
});
