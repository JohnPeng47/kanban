import * as vscode from "vscode";
import { getCachedAnchors } from "./anchor-cache";
import { type Anchor, findDiagramBlockRange } from "./anchors";

interface DiagramDocumentLink extends vscode.DocumentLink {
	anchor: Anchor;
}

/** Provides ctrl+click navigation links for anchor text in diagram files. */
export class DiagramLinkProvider implements vscode.DocumentLinkProvider {
	provideDocumentLinks(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): DiagramDocumentLink[] {
		const anchors = getCachedAnchors(document.uri);
		if (anchors.length === 0) return [];

		const text = document.getText();
		const blockRange = findDiagramBlockRange(text);
		if (!blockRange) return [];

		const [blockStart, blockEnd] = blockRange;
		const links: DiagramDocumentLink[] = [];

		for (const anchor of anchors) {
			const occurrences = findAnchorOccurrences(document, anchor, blockStart, blockEnd);
			for (const range of occurrences) {
				const link = new vscode.DocumentLink(range) as DiagramDocumentLink;
				link.tooltip = `${anchor.label} — ${anchor.filePath}:${anchor.startLine}`;
				link.anchor = anchor;
				links.push(link);
			}
		}

		return links;
	}

	resolveDocumentLink(
		link: DiagramDocumentLink,
		_token: vscode.CancellationToken,
	): vscode.DocumentLink {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders?.[0]) return link;

		const { anchor } = link;
		const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, anchor.filePath);
		link.target = fileUri.with({ fragment: String(anchor.startLine) });
		return link;
	}
}

/**
 * Open an anchor target in a split pane (ctrl+alt+click).
 * - 1 pane → open in new vertical split (ViewColumn.Beside)
 * - 2 panes → open in the other pane
 * - 3+ panes → open in the "next" pane
 */
export async function openAnchorInSplit(anchor: Anchor): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders?.[0]) return;

	const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, anchor.filePath);
	const line = Math.max(0, anchor.startLine - 1);

	const activeGroup = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
	const groups = vscode.window.tabGroups.all;

	let targetColumn: vscode.ViewColumn;
	if (groups.length <= 1) {
		// 1 pane → open beside (creates a new split)
		targetColumn = vscode.ViewColumn.Beside;
	} else if (groups.length === 2) {
		// 2 panes → open in the other one
		targetColumn = activeGroup === vscode.ViewColumn.One
			? vscode.ViewColumn.Two
			: vscode.ViewColumn.One;
	} else {
		// 3+ panes → open in the next pane (wrap around)
		const currentIndex = groups.findIndex(g => g.viewColumn === activeGroup);
		const nextIndex = (currentIndex + 1) % groups.length;
		targetColumn = groups[nextIndex]!.viewColumn;
	}

	const doc = await vscode.workspace.openTextDocument(fileUri);
	const editor = await vscode.window.showTextDocument(doc, { viewColumn: targetColumn, preview: false });
	const range = new vscode.Range(line, 0, line, 0);
	editor.selection = new vscode.Selection(range.start, range.start);
	editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/** Find all occurrences of an anchor's text within the diagram block lines. */
function findAnchorOccurrences(
	document: vscode.TextDocument,
	anchor: Anchor,
	blockStart: number,
	blockEnd: number,
): vscode.Range[] {
	const ranges: vscode.Range[] = [];
	const searchText = anchor.text;

	for (let lineNum = blockStart; lineNum <= blockEnd; lineNum++) {
		const line = document.lineAt(lineNum);
		let startIndex = 0;
		while (true) {
			const idx = line.text.indexOf(searchText, startIndex);
			if (idx === -1) break;
			ranges.push(new vscode.Range(lineNum, idx, lineNum, idx + searchText.length));
			startIndex = idx + searchText.length;
		}
	}

	return ranges;
}
