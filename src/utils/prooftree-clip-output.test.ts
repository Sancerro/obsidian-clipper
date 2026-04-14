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

	test('restores non-C bussproofs syntax for clipped sequent calculus prooftrees', () => {
		// This simulates what defuddle produces: \Axiom$...$  →  \Axiom{...}
		// The clip output must convert back for MathJax.
		const clippedNonC = String.raw`Sequent calculus rules:

$$
\begin{prooftree}
\def\fCenter{\Lrightarrow}
\Axiom{\Gamma\fCenter \Theta, \rA}
\RightLabel{\neg\text{(R)}}
\UnaryInf{\Gamma\fCenter \Theta, \neg\rA}
\end{prooftree}
$$

$$
\begin{prooftree}
\def\fCenter{\Lrightarrow}
\Axiom{\Gamma\fCenter \Theta, \rA}
\Axiom{\rB, \Gamma\fCenter \Theta}
\RightLabel{\supset\text{(L)}}
\BinaryInf{\rA \supset \rB, \Gamma\fCenter \Theta}
\end{prooftree}
$$`;

		const normalized = normalizeProoftreesForObsidian(clippedNonC);

		// Non-C inference commands must use $...$ syntax
		expect(normalized).toContain(String.raw`\Axiom$\Gamma\fCenter \Theta, \rA$`);
		expect(normalized).toContain(String.raw`\UnaryInf$\Gamma\fCenter \Theta, \neg\rA$`);
		expect(normalized).toContain(String.raw`\BinaryInf$\rA \supset \rB, \Gamma\fCenter \Theta$`);
		// Labels keep {...} but content wrapped in $...$
		expect(normalized).toContain(String.raw`\RightLabel{$\neg\text{(R)}$}`);
		expect(normalized).toContain(String.raw`\RightLabel{$\supset\text{(L)}$}`);
		// No brace-wrapped non-C commands
		expect(normalized).not.toContain(String.raw`\Axiom{`);
		expect(normalized).not.toContain(String.raw`\UnaryInf{`);
		expect(normalized).not.toContain(String.raw`\BinaryInf{`);
	});
});
