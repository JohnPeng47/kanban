import * as vscode from "vscode";
import { type Anchor, loadAnchors } from "./anchors";

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
