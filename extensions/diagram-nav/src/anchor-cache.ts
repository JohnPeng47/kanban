import * as vscode from "vscode";
import { type Anchor, loadAnchors } from "./anchors";

/**
 * Cache of parsed anchors per document URI, loaded from `.diagfren/` sidecar files.
 *
 * Synchronous providers (DefinitionProvider, HoverProvider) can't await file reads,
 * so we pre-load anchors when documents are opened/changed and serve from cache.
 */
const cache = new Map<string, Anchor[]>();

/** Get cached anchors for a document. Returns empty array if not yet loaded. */
export function getCachedAnchors(documentUri: vscode.Uri): Anchor[] {
	return cache.get(documentUri.toString()) ?? [];
}

/** Refresh the cache for a single document. */
export async function refreshAnchors(documentUri: vscode.Uri): Promise<void> {
	const anchors = await loadAnchors(documentUri);
	if (anchors.length > 0) {
		cache.set(documentUri.toString(), anchors);
	} else {
		cache.delete(documentUri.toString());
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

	context.subscriptions.push(
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
	const watcher = vscode.workspace.createFileSystemWatcher("**/.diagfren/**/*.anchors");
	context.subscriptions.push(
		watcher,
		watcher.onDidChange(() => refreshAllVisible()),
		watcher.onDidCreate(() => refreshAllVisible()),
		watcher.onDidDelete(() => refreshAllVisible()),
	);
}

function refreshAllVisible(): void {
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document.languageId === "plaintext") {
			refreshAnchors(editor.document.uri);
		}
	}
}
