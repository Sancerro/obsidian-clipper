type MathJaxMacroValue = string | [string, number];
type MathJaxMacroMap = Record<string, MathJaxMacroValue>;

export function normalizeMacrosForObsidian(macros: MathJaxMacroMap): MathJaxMacroMap {
	const normalized = { ...macros };

	// Keys may be backslash-prefixed (\turnstile) or bare (turnstile).
	// Delete both forms before setting the normalized value to avoid
	// duplicate \newcommand definitions in the output.
	for (const name of ['turnstile', 'dturnstile', 'Lrightarrow']) {
		delete normalized[name];
		delete normalized[`\\${name}`];
	}

	normalized.turnstile = ['\\mathrel{\\vdash_{#1}}', 1];
	normalized.dturnstile = ['\\mathrel{\\vDash_{#1}}', 1];
	normalized.Lrightarrow = '\\mathbin{\\rightarrow}';

	return normalized;
}

export function renderMacroDefsForObsidian(macros: MathJaxMacroMap): string {
	const normalized = normalizeMacrosForObsidian(macros);
	return Object.entries(normalized).map(([name, val]) => {
		const n = name.startsWith('\\') ? name : `\\${name}`;
		if (Array.isArray(val)) return `\\newcommand{${n}}[${val[1]}]{${val[0]}}`;
		return `\\newcommand{${n}}{${val}}`;
	}).join('\n');
}
