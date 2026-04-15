import * as vscode from "vscode";
import { type Anchor, findDiagramBlockRange, parseAnchors } from "./anchors";

/**
 * Provides "Go to Definition" for anchor text in diagram files.
 *
 * ctrl+click → Go to Definition (opens in same pane)
 * ctrl+alt+click → Peek/Open to Side (VS Code built-in behavior for definitions)
 *
 * This replaces the DocumentLinkProvider for navigation so that
 * ctrl+alt+click "Open to the Side" works natively.
 */
export class DiagramDefinitionProvider implements vscode.DefinitionProvider {
	provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): vscode.LocationLink[] | null {
		const text = document.getText();
		const anchors = parseAnchors(text);
		if (anchors.length === 0) return null;

		const blockRange = findDiagramBlockRange(text);
		if (!blockRange) return null;

		const [blockStart, blockEnd] = blockRange;
		if (position.line < blockStart || position.line > blockEnd) return null;

		const line = document.lineAt(position.line).text;

		for (const anchor of anchors) {
			let startIndex = 0;
			while (true) {
				const idx = line.indexOf(anchor.text, startIndex);
				if (idx === -1) break;
				if (position.character >= idx && position.character < idx + anchor.text.length) {
					return buildLocationLinks(document, anchor, position.line, idx);
				}
				startIndex = idx + anchor.text.length;
			}
		}

		return null;
	}
}

function buildLocationLinks(
	document: vscode.TextDocument,
	anchor: Anchor,
	line: number,
	col: number,
): vscode.LocationLink[] | null {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders?.[0]) return null;

	const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, anchor.filePath);
	const targetLine = Math.max(0, anchor.startLine - 1);
	const targetEndLine = anchor.endLine ? Math.max(0, anchor.endLine - 1) : targetLine;

	const originRange = new vscode.Range(line, col, line, col + anchor.text.length);
	const targetRange = new vscode.Range(targetLine, 0, targetEndLine, 0);

	return [{
		originSelectionRange: originRange,
		targetUri: fileUri,
		targetRange: targetRange,
		targetSelectionRange: new vscode.Range(targetLine, 0, targetLine, 0),
	}];
}
