import * as vscode from "vscode";
import { hasCachedAnchors, getCachedAnchors, refreshAnchors } from "./anchor-cache";
import { findDiagramBlockRange } from "./anchors";

/**
 * Register a clipboard intercept that appends code-refs to copied diagram text.
 *
 * Uses a context variable so the keybinding only activates when the current
 * file has a `.diagfren/` sidecar with anchors.
 */
export function registerCopyProvider(context: vscode.ExtensionContext): void {
	// Track whether the active file has anchors
	async function updateContext(editor: vscode.TextEditor | undefined) {
		if (!editor || editor.document.languageId !== "plaintext") {
			vscode.commands.executeCommand("setContext", "diagfren.hasAnchors", false);
			return;
		}
		await refreshAnchors(editor.document.uri);
		const has = hasCachedAnchors(editor.document.uri);
		vscode.commands.executeCommand("setContext", "diagfren.hasAnchors", has);
	}

	updateContext(vscode.window.activeTextEditor);
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(updateContext),
	);

	// Debug command — shows what getText(selection) returns in a new editor tab
	context.subscriptions.push(
		vscode.commands.registerCommand("diagfren.debugCopy", async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const selections = editor.selections;
			const sel = editor.selection;
			const text = selections.length > 1
				? selections
					.slice()
					.sort((a, b) => a.start.compareTo(b.start))
					.map((s) => editor.document.getText(s))
					.join("\n")
				: editor.document.getText(sel);
			const lines = text.split("\n");

			const report = [
				`=== diagfren debug copy ===`,
				``,
				`Selections: ${selections.length} cursor(s)`,
				`Primary: L${sel.start.line}:${sel.start.character} → L${sel.end.line}:${sel.end.character}`,
				...selections.length > 1
					? selections.map((s, i) => `  [${i}] L${s.start.line}:${s.start.character} → L${s.end.line}:${s.end.character}`)
					: [],
				`getText returned: ${lines.length} lines, ${text.length} chars`,
				``,
				`--- raw text (between markers) ---`,
				`>>>`,
				text,
				`<<<`,
				``,
				`--- first line JSON ---`,
				JSON.stringify(lines[0]),
				``,
				`--- last line JSON ---`,
				JSON.stringify(lines[lines.length - 1]),
			].join("\n");

			const doc = await vscode.workspace.openTextDocument({ content: report, language: "plaintext" });
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("diagfren.copyWithRefs", async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.selection.isEmpty) {
				return;
			}

			const document = editor.document;

			// Handle multi-cursor / column selection: join all selections' text
			const selections = editor.selections;
			const selectedText = selections.length > 1
				? selections
					.slice()
					.sort((a, b) => a.start.compareTo(b.start))
					.map((sel) => document.getText(sel))
					.join("\n")
				: document.getText(selections[0]!);

			// Compute the overall selection span across all cursors
			const sorted = selections.slice().sort((a, b) => a.start.compareTo(b.start));

			const text = document.getText();
			const blockRange = findDiagramBlockRange(text);

			// If selection isn't in the diagram block, plain copy
			const overallStart = sorted[0]!.start;
			const overallEnd = sorted[sorted.length - 1]!.end;
			if (!blockRange || overallEnd.line < blockRange[0] || overallStart.line > blockRange[1]) {
				await vscode.env.clipboard.writeText(selectedText);
				return;
			}

			const anchors = getCachedAnchors(document.uri);
			if (anchors.length === 0) {
				await vscode.env.clipboard.writeText(selectedText);
				return;
			}

			// Find which anchors have text within the selection.
			// Use per-selection text (not full lines) so column/box selections
			// only match anchors visible inside the selected columns.
			const matchedRefs = new Map<string, string>();
			const selectedFragments = sorted
				.filter((sel) => sel.start.line >= blockRange[0] && sel.end.line <= blockRange[1])
				.map((sel) => document.getText(sel));

			for (const anchor of anchors) {
				if (selectedFragments.some((fragment) => fragment.includes(anchor.text))) {
					const ref = `${anchor.filePath}:${anchor.startLine}${anchor.endLine ? `-${anchor.endLine}` : ""}`;
					matchedRefs.set(anchor.text, ref);
				}
			}

			if (matchedRefs.size === 0) {
				await vscode.env.clipboard.writeText(selectedText);
				return;
			}

			const relativePath = vscode.workspace.asRelativePath(document.uri);
			const refLines = Array.from(matchedRefs.entries())
				.map(([anchorText, ref]) => `${anchorText}  ${ref}`)
				.join("\n");

			await vscode.env.clipboard.writeText(`${selectedText}\n\n---\nsource: ${relativePath}\n${refLines}`);
			vscode.window.setStatusBarMessage(`Copied with ${matchedRefs.size} code-ref(s)`, 3000);
		}),
	);
}
