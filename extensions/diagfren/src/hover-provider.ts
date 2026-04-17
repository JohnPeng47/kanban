import * as vscode from "vscode";
import { getAnchors } from "./anchor-cache";
import { findDiagramBlockRange } from "./anchors";

/** Shows code-ref info on hover over anchor text in diagram files. */
export class DiagramHoverProvider implements vscode.HoverProvider {
	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<vscode.Hover | null> {
		const anchors = await getAnchors(document.uri);
		if (anchors.length === 0) return null;

		const text = document.getText();
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
				if (position.character >= idx && position.character <= idx + anchor.text.length) {
					const range = new vscode.Range(
						position.line, idx,
						position.line, idx + anchor.text.length,
					);
					const md = new vscode.MarkdownString();
					md.appendMarkdown(`**${anchor.label}**\n\n`);
					md.appendMarkdown(`\`${anchor.filePath}:${anchor.startLine}${anchor.endLine ? `-${anchor.endLine}` : ""}\``);
					return new vscode.Hover(md, range);
				}
				startIndex = idx + anchor.text.length;
			}
		}

		return null;
	}
}
