import * as vscode from "vscode";

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
 * Resolve the `.diagfren/` sidecar path for a given document.
 *
 * For a diagram at `diagrams/extensions/ascii3/01-system-and-data-flow.txt`,
 * returns the workspace URI for `.diagfren/diagrams/extensions/ascii3/01-system-and-data-flow.anchors`.
 */
export function resolveAnchorsUri(documentUri: vscode.Uri): vscode.Uri | null {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders?.[0]) return null;

	const relativePath = vscode.workspace.asRelativePath(documentUri, false);
	// Replace .txt extension with .anchors
	const anchorsRelative = relativePath.replace(/\.txt$/, ".anchors");
	return vscode.Uri.joinPath(workspaceFolders[0].uri, ".diagfren", anchorsRelative);
}

/**
 * Load anchors for a document from its `.diagfren/` sidecar file.
 * Returns empty array if no sidecar file exists.
 */
export async function loadAnchors(documentUri: vscode.Uri): Promise<Anchor[]> {
	const anchorsUri = resolveAnchorsUri(documentUri);
	if (!anchorsUri) return [];

	try {
		const bytes = await vscode.workspace.fs.readFile(anchorsUri);
		const text = Buffer.from(bytes).toString("utf-8");
		return parseAnchorsContent(text);
	} catch {
		return [];
	}
}

/**
 * Synchronously load anchors for a document from its `.diagfren/` sidecar file.
 * Uses openTextDocument which may return a cached version.
 * Returns empty array if no sidecar file exists.
 */
export function loadAnchorsSync(documentUri: vscode.Uri): Anchor[] | null {
	const anchorsUri = resolveAnchorsUri(documentUri);
	if (!anchorsUri) return null;
	// Return null to signal "needs async resolution" — callers that need
	// sync access should use the cached approach or pre-load.
	return null;
}

/**
 * Check whether a `.diagfren/` sidecar file exists for the given document.
 */
export async function hasAnchorsFile(documentUri: vscode.Uri): Promise<boolean> {
	const anchorsUri = resolveAnchorsUri(documentUri);
	if (!anchorsUri) return false;

	try {
		await vscode.workspace.fs.stat(anchorsUri);
		return true;
	} catch {
		return false;
	}
}

/**
 * Parse raw anchors content (no fence markers — just the column data).
 *
 * Expected format:
 * ```
 * # anchor-text            code-ref                         label
 * DiagramContentArea        src/foo.tsx:286-354              DiagramContentArea component
 * ```
 *
 * Uses two-or-more-spaces as the column delimiter to allow spaces within
 * anchor text and labels.
 */
export function parseAnchorsContent(text: string): Anchor[] {
	const anchors: Anchor[] = [];

	for (const line of text.split("\n")) {
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

/**
 * Parse the ```anchors block from inline diagram text (legacy support).
 */
export function parseAnchors(text: string): Anchor[] {
	const startMatch = text.match(/^```anchors\s*$/m);
	if (!startMatch || startMatch.index === undefined) return [];

	const blockStart = startMatch.index + startMatch[0].length;
	const blockEnd = text.indexOf("```", blockStart);
	if (blockEnd === -1) return [];

	return parseAnchorsContent(text.slice(blockStart, blockEnd));
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
