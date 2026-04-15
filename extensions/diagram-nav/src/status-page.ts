import * as vscode from "vscode";
import { parseAnchors } from "./anchors";

interface DiagramInfo {
	relativePath: string;
	anchorCount: number;
}

/** Scan workspace for diagram .txt files with anchors blocks. */
async function findDiagrams(): Promise<DiagramInfo[]> {
	const files = await vscode.workspace.findFiles("**/*.txt", "**/node_modules/**", 500);
	const diagrams: DiagramInfo[] = [];

	for (const file of files) {
		const doc = await vscode.workspace.openTextDocument(file);
		const text = doc.getText();

		// Only include files that have both a diagram block and an anchors block
		if (!text.includes("```diagram") || !text.includes("```anchors")) continue;

		const anchors = parseAnchors(text);
		const relativePath = vscode.workspace.asRelativePath(file);
		diagrams.push({ relativePath, anchorCount: anchors.length });
	}

	diagrams.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	return diagrams;
}

/** Show the diagfren status page in a webview panel. */
export async function showStatusPage(): Promise<void> {
	const panel = vscode.window.createWebviewPanel(
		"diagfrenStatus",
		"diagfren: Status Page",
		vscode.ViewColumn.Active,
		{ enableScripts: false },
	);

	panel.webview.html = renderLoading();

	const diagrams = await findDiagrams();
	panel.webview.html = renderStatusPage(diagrams);
}

function renderLoading(): string {
	return `<!DOCTYPE html>
<html><body style="background:#1e1e1e;color:#ccc;font-family:monospace;padding:20px;">
<p>Scanning for diagrams...</p>
</body></html>`;
}

function renderStatusPage(diagrams: DiagramInfo[]): string {
	const rows = diagrams.map(d =>
		`<tr>
			<td style="padding:4px 12px 4px 0;">${escapeHtml(d.relativePath)}</td>
			<td style="padding:4px 0;text-align:right;">${d.anchorCount}</td>
		</tr>`
	).join("\n");

	const total = diagrams.length;
	const totalAnchors = diagrams.reduce((sum, d) => sum + d.anchorCount, 0);

	return `<!DOCTYPE html>
<html>
<head>
<style>
	body { background:#1e1e1e; color:#ccc; font-family:'JetBrains Mono','Fira Code',monospace; font-size:13px; padding:20px; }
	h1 { color:#4C9AFF; font-size:16px; margin-bottom:4px; }
	.summary { color:#8B949E; margin-bottom:16px; }
	table { border-collapse:collapse; }
	th { text-align:left; padding:4px 12px 4px 0; color:#8B949E; border-bottom:1px solid #30363D; }
	th:last-child { text-align:right; padding-right:0; }
	tr:hover td { background:#2D3339; }
	td { border-bottom:1px solid #21262D; }
</style>
</head>
<body>
	<h1>diagfren</h1>
	<p class="summary">${total} diagram(s) detected, ${totalAnchors} total anchor(s)</p>
	${total === 0
		? "<p>No diagram files with <code>\`\`\`anchors</code> blocks found in this workspace.</p>"
		: `<table>
			<tr><th>Diagram</th><th>Anchors</th></tr>
			${rows}
		</table>`
	}
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
