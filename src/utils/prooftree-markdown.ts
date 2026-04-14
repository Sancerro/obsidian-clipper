const PROOFTREE_COMMANDS = new Set([
	'AxiomC',
	'UnaryInfC',
	'BinaryInfC',
	'TrinaryInfC',
	'QuaternaryInfC',
	'QuinaryInfC',
	'RightLabel',
	'LeftLabel',
]);

// Non-C bussproofs inference commands (without trailing "C").
// MathJax expects these with $...$ arguments, not {...}.
const NON_C_INFERENCE_COMMANDS = new Set([
	'Axiom',
	'UnaryInf',
	'BinaryInf',
	'TrinaryInf',
	'QuaternaryInf',
	'QuinaryInf',
]);

function extractBraceArgument(source: string, openBraceIndex: number): { value: string; endIndex: number } | null {
	if (source[openBraceIndex] !== '{') return null;

	let depth = 0;
	let value = '';
	for (let i = openBraceIndex; i < source.length; i++) {
		const char = source[i];
		if (char === '{') {
			depth += 1;
			if (depth > 1) value += char;
			continue;
		}
		if (char === '}') {
			depth -= 1;
			if (depth === 0) return { value, endIndex: i + 1 };
			value += char;
			continue;
		}
		value += char;
	}

	return null;
}

function stripMathWrappers(arg: string): string {
	let out = arg.trim();
	while (/^(\\\(|\\\[|\$)/.test(out)) {
		out = out.replace(/^(\\\(|\\\[|\$)\s*/, '');
	}
	while (/(\\\)|\\\]|\$)$/.test(out)) {
		out = out.replace(/\s*(\\\)|\\\]|\$)$/, '');
	}
	return out.trim();
}

function normalizeProoftreeCommandArguments(block: string): string {
	let result = '';

	for (let i = 0; i < block.length;) {
		if (block[i] !== '\\') {
			result += block[i];
			i += 1;
			continue;
		}

		const match = block.slice(i).match(/^\\([A-Za-z]+)/);
		if (!match) {
			result += block[i];
			i += 1;
			continue;
		}

		const command = match[1];
		if (!PROOFTREE_COMMANDS.has(command)) {
			result += `\\${command}`;
			i += command.length + 1;
			continue;
		}

		let j = i + command.length + 1;
		while (/\s/.test(block[j] || '')) j += 1;
		const arg = extractBraceArgument(block, j);
		if (!arg) {
			result += `\\${command}`;
			i += command.length + 1;
			continue;
		}

		result += `\\${command}{${stripMathWrappers(arg.value)}}`;
		i = arg.endIndex;
	}

	return result;
}

/**
 * Detect whether a prooftree block uses non-C bussproofs syntax.
 * A block is non-C if it contains commands like \Axiom, \UnaryInf, etc.
 * (without the trailing "C") followed by a brace argument.
 */
function blockUsesNonCSyntax(block: string): boolean {
	for (const cmd of NON_C_INFERENCE_COMMANDS) {
		// Match \Axiom{ but not \AxiomC{ — the command must not be followed by "C"
		const pattern = new RegExp(`\\\\${cmd}\\s*\\{`);
		if (pattern.test(block)) return true;
	}
	return false;
}

/**
 * Convert non-C inference commands from \Axiom{...} back to \Axiom$...$
 * and wrap label content in $...$ for MathJax compatibility.
 * Only applied to blocks that use non-C syntax.
 */
function restoreNonCSyntax(block: string): string {
	if (!blockUsesNonCSyntax(block)) return block;

	let result = '';

	for (let i = 0; i < block.length;) {
		if (block[i] !== '\\') {
			result += block[i];
			i += 1;
			continue;
		}

		const match = block.slice(i).match(/^\\([A-Za-z]+)/);
		if (!match) {
			result += block[i];
			i += 1;
			continue;
		}

		const command = match[1];

		// Non-C inference commands: \Axiom{...} → \Axiom$...$
		if (NON_C_INFERENCE_COMMANDS.has(command)) {
			let j = i + command.length + 1;
			while (/\s/.test(block[j] || '')) j += 1;
			const arg = extractBraceArgument(block, j);
			if (arg) {
				result += `\\${command}$${arg.value}$`;
				i = arg.endIndex;
			} else {
				result += `\\${command}`;
				i += command.length + 1;
			}
			continue;
		}

		// Labels in non-C blocks: \RightLabel{...} → \RightLabel{$...$}
		if (command === 'RightLabel' || command === 'LeftLabel') {
			let j = i + command.length + 1;
			while (/\s/.test(block[j] || '')) j += 1;
			const arg = extractBraceArgument(block, j);
			if (arg) {
				result += `\\${command}{$${arg.value}$}`;
				i = arg.endIndex;
			} else {
				result += `\\${command}`;
				i += command.length + 1;
			}
			continue;
		}

		result += `\\${command}`;
		i += command.length + 1;
	}

	return result;
}

function normalizeProoftreeLatex(latex: string): string {
	if (!latex.includes('\\begin{prooftree}')) return latex;

	return latex.replace(/\\begin\{prooftree\}[\s\S]*?\\end\{prooftree\}/g, block => (
		restoreNonCSyntax(
			normalizeProoftreeCommandArguments(
				block
				.replace(/\\\(([\s\S]*?)\\\)/g, '$1')
				.replace(/\\\[([\s\S]*?)\\\]/g, '$1')
				// Convert non-C \Axiom$...$  →  \Axiom{...} before generic $ stripping
				.replace(/\\(Axiom|UnaryInf|BinaryInf|TrinaryInf|QuaternaryInf|QuinaryInf)\$([^$]*)\$/g,
					(_m, cmd, arg) => `\\${cmd}{${arg}}`)
				.replace(/\$([^$]+?)\$/g, '$1')
			)
		)
	));
}

function withBussproofsRequire(expression: string): string {
	const trimmed = expression.trim().replace(/^\\require\{bussproofs\}\s*/m, '').trim();
	return `\\require{bussproofs}\n${trimmed}`;
}

function normalizeProoftreeExpression(expression: string): string {
	const normalized = expression.replace(
		/\\begin\{prooftree\}[\s\S]*?\\end\{prooftree\}/g,
		block => normalizeProoftreeLatex(block)
	).trim();
	return withBussproofsRequire(normalized);
}

function splitMultiTreeBlock(expr: string): string {
	// Extract individual prooftree environments from a display block
	// that may contain \hspace, \quad, etc. between them.
	const treePattern = /\\begin\{prooftree\}[\s\S]*?\\end\{prooftree\}/g;
	const trees: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = treePattern.exec(expr))) {
		trees.push(normalizeProoftreeLatex(m[0]));
	}
	if (trees.length === 0) return `$$\n${expr.trim()}\n$$`;
	// Each tree gets its own $$ block with \require{bussproofs}
	return trees.map(tree =>
		`$$\n${withBussproofsRequire(tree)}\n$$`
	).join('\n\n');
}

export function normalizeProoftreesForObsidian(markdown: string): string {
	if (!markdown.includes('\\begin{prooftree}')) return markdown;

	return markdown
		// Display $$ blocks containing prooftrees — split multi-tree blocks
		.replace(/(^|\n)([ \t>]*)\$\$\s*\n([\s\S]*?\\begin\{prooftree\}[\s\S]*?)\n\2\$\$(?=\n|$)/g, (_match, prefix: string, _indent: string, expr: string) => (
			`${prefix}${splitMultiTreeBlock(expr)}`
		))
		// \[...\] containing prooftrees
		.replace(/\\\[([\s\S]*?\\begin\{prooftree\}[\s\S]*?\\end\{prooftree\}[\s\S]*?)\\\]/g, (_match, expr: string) => (
			`\n${splitMultiTreeBlock(expr)}\n`
		))
		// Inline $..$ or \(...\) wrapping a prooftree
		.replace(/(^|\n)([^\n]*?)(?:\$\s*|\\\(\s*)(\\begin\{prooftree\}[\s\S]*?\\end\{prooftree\})(?:\s*\$|\s*\\\))?([^\n]*)(?=\n|$)/g, (_match, prefix: string, before: string, expr: string, after: string) => {
			const trimmedBefore = before.trimEnd();
			const trimmedAfter = after.trimStart();
			const parts = [];
			if (trimmedBefore) parts.push(trimmedBefore);
			parts.push(splitMultiTreeBlock(expr));
			if (trimmedAfter) parts.push(trimmedAfter);
			return `${prefix}${parts.join('\n')}`;
		})
		// Clean up any remaining $$ with \require that got double-wrapped
		.replace(/\$\$\s*\\require\{bussproofs\}\s*([\s\S]*?)\s*\$\$/g, (_match, body: string) => (
			body.includes('\\begin{prooftree}')
				? `$$\n\\require{bussproofs}\n${body.trim()}\n$$`
				: `$$\n${body.trim()}\n$$`
		))
		.replace(/(^|\n)[ \t]*\$\s*(?=\n|$)/g, '$1');
}
