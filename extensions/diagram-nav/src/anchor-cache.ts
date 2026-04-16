import * as vscode from "vscode";
import { type Anchor, loadAnchors, resolveAnchorsUri } from "./anchors";

/**
 * Cache of parsed anchors per document URI, loaded from `.diagfren/` sidecar files.
 *
 * Providers call `getAnchors()` which returns from cache or loads on demand.
 * The `onDidChange` emitter notifies the DocumentLinkProvider to re-query.
 */
const cache = new Map<string, Anchor[]>();

/** Fires when cached anchors change — link provider listens to re-provide links. */
export const onDidChangeAnchors = new vscode.EventEmitter<void>();

/** Get anchors for a document, loading from sidecar if not cached. */
export async function getAnchors(documentUri: vscode.Uri): Promise<Anchor[]> {
	const key = documentUri.toString();
	const cached = cache.get(key);
	if (cached !== undefined) return cached;

	const anchors = await loadAnchors(documentUri);
	cache.set(key, anchors);
	return anchors;
}

/** Get cached anchors synchronously. Returns empty array if not yet loaded. */
export function getCachedAnchors(documentUri: vscode.Uri): Anchor[] {
	return cache.get(documentUri.toString()) ?? [];
}

/** Refresh the cache for a single document and fire change event. */
export async function refreshAnchors(documentUri: vscode.Uri): Promise<void> {
	const anchors = await loadAnchors(documentUri);
	const key = documentUri.toString();
	const prev = cache.get(key);
	cache.set(key, anchors);

	// Only fire if the result actually changed
	const changed = prev === undefined
		|| prev.length !== anchors.length
		|| JSON.stringify(prev) !== JSON.stringify(anchors);
	if (changed) {
		onDidChangeAnchors.fire();
	}
}

/** Returns true if the cache has anchors for this document. */
export function hasCachedAnchors(documentUri: vscode.Uri): boolean {
	const entry = cache.get(documentUri.toString());
	return entry !== undefined && entry.length > 0;
}

/** Register listeners that keep the cache warm. */
export function registerAnchorCache(context: vscode.ExtensionContext): void {
	// Load on activation for currently open editors
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document.languageId === "plaintext") {
			refreshAnchors(editor.document.uri);
		}
	}

	// Sweep orphaned sidecars whose source diagrams no longer exist
	pruneOrphanedSidecars();

	context.subscriptions.push(
		onDidChangeAnchors,
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor?.document.languageId === "plaintext") {
				refreshAnchors(editor.document.uri);
			}
		}),
		vscode.workspace.onDidOpenTextDocument((doc) => {
			if (doc.languageId === "plaintext") {
				refreshAnchors(doc.uri);
			}
		}),
	);

	// Watch .diagfren/ for changes so edits to sidecar files refresh the cache
	const anchorsWatcher = vscode.workspace.createFileSystemWatcher("**/.diagfren/**/*.anchors");
	context.subscriptions.push(
		anchorsWatcher,
		anchorsWatcher.onDidChange(() => refreshAllVisible()),
		anchorsWatcher.onDidCreate(() => refreshAllVisible()),
		anchorsWatcher.onDidDelete(() => refreshAllVisible()),
	);

	// Watch diagram .txt files for deletion — clean up orphaned .diagfren/ sidecars
	const txtWatcher = vscode.workspace.createFileSystemWatcher("**/*.txt");
	context.subscriptions.push(
		txtWatcher,
		txtWatcher.onDidDelete(async (deletedUri) => {
			const anchorsUri = resolveAnchorsUri(deletedUri);
			if (!anchorsUri) return;

			try {
				await vscode.workspace.fs.delete(anchorsUri);
			} catch {
				// Sidecar didn't exist — nothing to clean up
			}

			// Evict from cache
			const key = deletedUri.toString();
			if (cache.delete(key)) {
				onDidChangeAnchors.fire();
			}
		}),
	);
}

/** Delete `.diagfren/` sidecar files whose source diagram no longer exists. */
async function pruneOrphanedSidecars(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders?.[0]) return;

	const root = workspaceFolders[0].uri;
	const anchorsFiles = await vscode.workspace.findFiles(".diagfren/**/*.anchors", "**/node_modules/**", 500);

	for (const anchorsFile of anchorsFiles) {
		const relative = vscode.workspace.asRelativePath(anchorsFile, false);
		const diagramRelative = relative.replace(/^\.diagfren\//, "").replace(/\.anchors$/, ".txt");
		const diagramUri = vscode.Uri.joinPath(root, diagramRelative);

		try {
			await vscode.workspace.fs.stat(diagramUri);
		} catch {
			// Source diagram gone — delete the orphaned sidecar
			try {
				await vscode.workspace.fs.delete(anchorsFile);
			} catch {
				// Already gone
			}
		}
	}
}

function refreshAllVisible(): void {
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document.languageId === "plaintext") {
			refreshAnchors(editor.document.uri);
		}
	}
}
