/** A parsed anchor mapping visible diagram text to a code reference. */
export interface Anchor {
	/** The exact visible string in the diagram. */
	text: string;
	/** File path relative to workspace root. */
	filePath: string;
	/** Start line in the source file (1-based). */
	startLine: number;
	/** End line in the source file (1-based), or null if single line. */
	endLine: number | null;
	/** Human-readable label for hover tooltip. */
	label: string;
}

/**
 * Parse the ```anchors block from a diagram .txt file.
 *
 * Expected format (whitespace-separated columns):
 * ```
 * ```anchors
 * # anchor-text            code-ref                         label
 * DiagramContentArea        src/foo.tsx:286-354              DiagramContentArea component
 * ```
 * ```
 *
 * Uses two-or-more-spaces as the column delimiter to allow spaces within
 * anchor text and labels.
 */
export function parseAnchors(text: string): Anchor[] {
	const anchors: Anchor[] = [];

	// Find the anchors block
	const startMatch = text.match(/^```anchors\s*$/m);
	if (!startMatch || startMatch.index === undefined) return anchors;

	const blockStart = startMatch.index + startMatch[0].length;
	const blockEnd = text.indexOf("```", blockStart);
	if (blockEnd === -1) return anchors;

	const block = text.slice(blockStart, blockEnd);
	const lines = block.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Split on 2+ spaces
		const parts = trimmed.split(/\s{2,}/);
		if (parts.length < 2) continue;

		const anchorText = parts[0]!;
		const codeRef = parts[1]!;
		const label = parts.slice(2).join("  ") || anchorText;

		const parsed = parseCodeRef(codeRef);
		if (!parsed) continue;

		anchors.push({
			text: anchorText,
			filePath: parsed.filePath,
			startLine: parsed.startLine,
			endLine: parsed.endLine,
			label,
		});
	}

	return anchors;
}

function parseCodeRef(ref: string): { filePath: string; startLine: number; endLine: number | null } | null {
	const colonIndex = ref.lastIndexOf(":");
	if (colonIndex === -1) {
		return { filePath: ref, startLine: 1, endLine: null };
	}
	const filePath = ref.slice(0, colonIndex);
	const lineSpec = ref.slice(colonIndex + 1);
	const dashIndex = lineSpec.indexOf("-");
	if (dashIndex === -1) {
		const line = parseInt(lineSpec, 10);
		if (!Number.isFinite(line)) return null;
		return { filePath, startLine: line, endLine: null };
	}
	const startLine = parseInt(lineSpec.slice(0, dashIndex), 10);
	const endLine = parseInt(lineSpec.slice(dashIndex + 1), 10);
	if (!Number.isFinite(startLine)) return null;
	return {
		filePath,
		startLine,
		endLine: Number.isFinite(endLine) ? endLine : null,
	};
}

/** A modal link mapping visible diagram text to another diagram file for inline expansion. */
export interface ModalLink {
	/** The exact visible string in the diagram that triggers expansion. */
	text: string;
	/** Relative path to the target diagram file. */
	targetFile: string;
	/** Human-readable label for hover tooltip. */
	label: string;
}

/**
 * Parse the ```modals block from a diagram .txt file.
 *
 * Format (two-or-more-spaces as column delimiter):
 * ```
 * ```modals
 * # anchor-text            target-file                          label
 * DiagramContentArea        05-content-and-navigation.txt        Expanded content area detail
 * ```
 * ```
 */
export function parseModals(text: string): ModalLink[] {
	const modals: ModalLink[] = [];

	const startMatch = text.match(/^```modals\s*$/m);
	if (!startMatch || startMatch.index === undefined) return modals;

	const blockStart = startMatch.index + startMatch[0].length;
	const blockEnd = text.indexOf("```", blockStart);
	if (blockEnd === -1) return modals;

	const block = text.slice(blockStart, blockEnd);
	const lines = block.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const parts = trimmed.split(/\s{2,}/);
		if (parts.length < 2) continue;

		modals.push({
			text: parts[0]!,
			targetFile: parts[1]!,
			label: parts.slice(2).join("  ") || parts[0]!,
		});
	}

	return modals;
}

/**
 * Find the range of the diagram block (between ```diagram and the next ```).
 * Returns [startLine, endLine] (0-based, inclusive) or null.
 */
export function findDiagramBlockRange(text: string): [number, number] | null {
	const lines = text.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() === "```diagram") {
			start = i + 1;
		} else if (start !== -1 && lines[i]!.trim() === "```") {
			return [start, i - 1];
		}
	}
	return null;
}
