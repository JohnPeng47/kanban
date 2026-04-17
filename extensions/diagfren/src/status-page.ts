import * as child_process from "child_process";
import * as util from "util";
import * as vscode from "vscode";
import { loadAnchors } from "./anchors";

const execFile = util.promisify(child_process.execFile);

interface DiagramInfo {
	relativePath: string;
	anchorCount: number;
	/** Number of commits since this file was last touched, or null if untracked. */
	commitsAgo: number | null;
}

/** Get the workspace root path, or null. */
function getWorkspaceRoot(): string | null {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** URI to the repo-local Claude skill file. */
function getSkillUri(): vscode.Uri | null {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.[0]) return null;
	return vscode.Uri.joinPath(folders[0].uri, ".claude", "skills", "diagfren", "SKILL.md");
}

/** Check if the diagfren Claude skill is installed in the current workspace. */
async function isSkillInstalled(): Promise<boolean> {
	const skillUri = getSkillUri();
	if (!skillUri) return false;
	try {
		await vscode.workspace.fs.stat(skillUri);
		return true;
	} catch {
		return false;
	}
}

/** Install the diagfren Claude skill into the current workspace. */
async function installSkill(prompt: string): Promise<void> {
	const skillUri = getSkillUri();
	if (!skillUri) throw new Error("No workspace folder");

	const skillContent = `---
name: diagfren
description: Use when generating or updating ASCII diagrams in this repo. Produces a diagram .txt file wrapped in \`\`\`diagram fences plus a .diagfren/ sidecar .anchors file that maps diagram text to code references for ctrl+click navigation.
---

${prompt}
`;

	await vscode.workspace.fs.writeFile(skillUri, Buffer.from(skillContent, "utf-8"));
}

/**
 * Count how many commits ago a file was last modified.
 * Returns null for untracked/uncommitted files.
 */
async function getCommitsAgo(cwd: string, relativePath: string): Promise<number | null> {
	try {
		// Get the hash of the last commit that touched this file
		const { stdout: lastHash } = await execFile(
			"git", ["log", "-1", "--format=%H", "--", relativePath],
			{ cwd },
		);
		const hash = lastHash.trim();
		if (!hash) return null;

		// Count commits between that hash and HEAD
		const { stdout: countStr } = await execFile(
			"git", ["rev-list", "--count", `${hash}..HEAD`],
			{ cwd },
		);
		return parseInt(countStr.trim(), 10);
	} catch {
		return null;
	}
}

/** Scan workspace for diagram .txt files that have `.diagfren/` sidecar anchor files. */
async function findDiagrams(): Promise<DiagramInfo[]> {
	const anchorsFiles = await vscode.workspace.findFiles(".diagfren/**/*.anchors", "**/node_modules/**", 500);
	const diagrams: DiagramInfo[] = [];
	const cwd = getWorkspaceRoot();

	for (const anchorsFile of anchorsFiles) {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders?.[0]) continue;

		const relative = vscode.workspace.asRelativePath(anchorsFile, false);
		const diagramRelative = relative.replace(/^\.diagfren\//, "").replace(/\.anchors$/, ".txt");
		const diagramUri = vscode.Uri.joinPath(workspaceFolders[0].uri, diagramRelative);

		// Skip orphaned sidecars whose source diagram no longer exists
		try {
			await vscode.workspace.fs.stat(diagramUri);
		} catch {
			continue;
		}

		const anchors = await loadAnchors(diagramUri);
		const commitsAgo = cwd ? await getCommitsAgo(cwd, diagramRelative) : null;

		diagrams.push({
			relativePath: diagramRelative,
			anchorCount: anchors.length,
			commitsAgo,
		});
	}

	diagrams.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	return diagrams;
}

/** Read the bundled prompt.md from the extension directory. */
async function loadPrompt(extensionUri: vscode.Uri): Promise<string> {
	const promptUri = vscode.Uri.joinPath(extensionUri, "prompt.md");
	try {
		const bytes = await vscode.workspace.fs.readFile(promptUri);
		return Buffer.from(bytes).toString("utf-8");
	} catch {
		return "(prompt.md not found)";
	}
}

/** Show the diagfren status page in a webview panel. */
export async function showStatusPage(extensionUri: vscode.Uri): Promise<void> {
	const panel = vscode.window.createWebviewPanel(
		"diagfrenStatus",
		"diagfren: Status Page",
		vscode.ViewColumn.Active,
		{ enableScripts: true },
	);

	const render = async () => {
		const [diagrams, prompt, skillInstalled] = await Promise.all([
			findDiagrams(),
			loadPrompt(extensionUri),
			isSkillInstalled(),
		]);
		panel.webview.html = renderStatusPage(diagrams, prompt, skillInstalled);
	};

	panel.webview.html = renderLoading();
	await render();

	// Handle install requests from the webview
	panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg?.type === "installSkill") {
			try {
				const prompt = await loadPrompt(extensionUri);
				await installSkill(prompt);
				vscode.window.showInformationMessage("diagfren Claude skill installed at .claude/skills/diagfren/SKILL.md");
				await render();
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to install skill: ${err}`);
			}
		}
	});
}

function renderLoading(): string {
	return `<!DOCTYPE html>
<html><body style="background:#1e1e1e;color:#ccc;font-family:monospace;padding:20px;">
<p>Scanning for diagrams...</p>
</body></html>`;
}

function formatCommitsAgo(commitsAgo: number | null): string {
	if (commitsAgo === null) return `<span style="color:#6E7681;">untracked</span>`;
	if (commitsAgo === 0) return `<span style="color:#3FB950;">latest</span>`;
	if (commitsAgo <= 5) return `<span style="color:#D29922;">${commitsAgo}</span>`;
	return `<span style="color:#F85149;">${commitsAgo}</span>`;
}

function renderStatusPage(diagrams: DiagramInfo[], prompt: string, skillInstalled: boolean): string {
	const rows = diagrams.map(d =>
		`<tr>
			<td style="padding:4px 12px 4px 0;">${escapeHtml(d.relativePath)}</td>
			<td style="padding:4px 12px;text-align:right;">${d.anchorCount}</td>
			<td style="padding:4px 0;text-align:right;">${formatCommitsAgo(d.commitsAgo)}</td>
		</tr>`
	).join("\n");

	const total = diagrams.length;
	const totalAnchors = diagrams.reduce((sum, d) => sum + d.anchorCount, 0);

	const commitsAgoTooltip = "Number of git commits since this diagram's .txt file was last modified. 0 means the most recent commit touched it; higher numbers suggest the diagram may be getting out of sync with the underlying code.";

	return `<!DOCTYPE html>
<html>
<head>
<style>
	body { background:#1e1e1e; color:#ccc; font-family:'JetBrains Mono','Fira Code',monospace; font-size:13px; padding:20px; }
	h1 { color:#4C9AFF; font-size:16px; margin-bottom:4px; }
	h2 { color:#8B949E; font-size:14px; margin-top:28px; margin-bottom:8px; }
	.summary { color:#8B949E; margin-bottom:16px; }
	table { border-collapse:collapse; }
	th { text-align:left; padding:4px 12px 4px 0; color:#8B949E; border-bottom:1px solid #30363D; font-weight:normal; }
	th:last-child { text-align:right; padding-right:0; }
	tr:hover td { background:#2D3339; }
	td { border-bottom:1px solid #21262D; }
	.info-tip {
		position:relative;
		display:inline-block; width:13px; height:13px; line-height:13px; text-align:center;
		border:1px solid #444C56; border-radius:50%; color:#8B949E; font-size:10px;
		cursor:help; margin-left:4px; user-select:none;
	}
	.info-tip:hover { color:#E6EDF3; border-color:#6E7681; }
	.info-tip .tip-content {
		display:none;
		position:absolute; right:0; top:calc(100% + 6px);
		width:280px; padding:8px 10px;
		background:#2D3339; color:#E6EDF3; border:1px solid #444C56; border-radius:6px;
		font-size:12px; line-height:1.45; text-align:left; font-weight:normal;
		z-index:10; white-space:normal;
		box-shadow:0 2px 8px rgba(0,0,0,0.4);
	}
	.info-tip:hover .tip-content { display:block; }
	.desc { color:#8B949E; margin-bottom:12px; line-height:1.5; }
	.desc code { background:#2D3339; padding:2px 5px; border-radius:3px; color:#E6EDF3; }
	.btn {
		display:inline-block; padding:6px 14px; margin-top:4px; margin-right:6px;
		background:#353C43; color:#E6EDF3; border:1px solid #444C56; border-radius:6px;
		cursor:pointer; font-family:inherit; font-size:13px;
	}
	.btn:hover { background:#3E464E; border-color:#6E7681; }
	.btn.copied { background:#2D4A30; border-color:#3FB950; color:#3FB950; }
	.btn.primary { background:#2D4A30; border-color:#3FB950; color:#9FE2A7; }
	.btn.primary:hover { background:#36543A; }
	.status-badge {
		display:inline-block; padding:2px 10px; border-radius:10px; font-size:11px;
		margin-left:6px;
	}
	.status-installed { background:#1C3A24; color:#3FB950; border:1px solid #2D4A30; }
	.status-missing { background:#3A1F1F; color:#F85149; border:1px solid #4A2D2D; }
	pre.prompt-preview {
		background:#24292E; border:1px solid #30363D; border-radius:6px;
		padding:12px; margin-top:8px; max-height:300px; overflow:auto;
		font-size:12px; line-height:1.4; white-space:pre-wrap; display:none;
	}
</style>
</head>
<body>
	<h1>diagfren</h1>
	<p class="summary">${total} diagram(s) detected, ${totalAnchors} total anchor(s)</p>

	${total === 0
		? "<p>No diagrams with <code>.diagfren/</code> sidecar files found in this workspace.</p>"
		: `<table>
			<tr>
				<th>Diagram</th>
				<th>Anchors</th>
				<th>Commits ago<span class="info-tip">i<span class="tip-content">${escapeHtml(commitsAgoTooltip)}</span></span></th>
			</tr>
			${rows}
		</table>`
	}

	${total > 0 ? `<p class="desc" style="margin-top:12px;font-size:12px;">Diagrams do not automatically track changes to source code. If referenced code has been refactored or moved, update diagrams and anchors manually.</p>` : ""}

	<h2>Install Claude Skill</h2>
	<p class="desc">
		Install a Claude skill to instruct <em>all</em> ASCII diagram generation in this repo to be compatible with diagfren annotations.
		Status: <span class="status-badge ${skillInstalled ? "status-installed" : "status-missing"}">${skillInstalled ? "installed" : "not installed"}</span>
	</p>
	${!skillInstalled
		? `<button class="btn primary" id="installBtn">Install skill</button>`
		: `<p class="desc" style="margin-top:4px;font-size:12px;">Skill file: <code>.claude/skills/diagfren/SKILL.md</code></p>`
	}

	<h2>Usage</h2>
	<p class="desc">
		diagfren works by attaching metadata to <code>\`\`\`diagram\`\`\`</code> blocks.<br>
		The following prompt instructs the agent on how to construct this metadata.
	</p>
	<button class="btn" id="copyBtn">Copy prompt to clipboard</button>
	<button class="btn" id="toggleBtn">Show prompt</button>
	<pre class="prompt-preview" id="promptPreview">${escapeHtml(prompt)}</pre>

	<script>
		const vscode = acquireVsCodeApi();
		const prompt = ${JSON.stringify(prompt)};
		const copyBtn = document.getElementById('copyBtn');
		const toggleBtn = document.getElementById('toggleBtn');
		const preview = document.getElementById('promptPreview');
		const installBtn = document.getElementById('installBtn');

		copyBtn.addEventListener('click', async () => {
			await navigator.clipboard.writeText(prompt);
			copyBtn.textContent = 'Copied!';
			copyBtn.classList.add('copied');
			setTimeout(() => {
				copyBtn.textContent = 'Copy prompt to clipboard';
				copyBtn.classList.remove('copied');
			}, 2000);
		});

		toggleBtn.addEventListener('click', () => {
			const visible = preview.style.display !== 'none';
			preview.style.display = visible ? 'none' : 'block';
			toggleBtn.textContent = visible ? 'Show prompt' : 'Hide prompt';
		});

		if (installBtn) {
			installBtn.addEventListener('click', () => {
				installBtn.textContent = 'Installing...';
				installBtn.disabled = true;
				vscode.postMessage({ type: 'installSkill' });
			});
		}
	</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
