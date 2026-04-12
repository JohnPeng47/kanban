import { useCallback, useEffect, useMemo, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { FileTreeNode } from "@/utils/file-tree";

export interface UseDiagramViewerResult {
	tree: FileTreeNode[];
	diagramsRootExists: boolean;
	isTreeLoading: boolean;
	selectedPath: string | null;
	expandedFolders: Set<string>;
	content: string | null;
	isContentLoading: boolean;
	contentError: string | null;
	workspacePath: string | null;
	onSelectPath: (path: string) => void;
	onToggleFolder: (path: string) => void;
	/** Request a cross-diagram jump. Sets selectedPath and stashes the jump target. */
	requestJump: (path: string, elementId: string | null) => void;
	/** The element ID to center on after the new Scene loads. Null when no jump is pending. */
	pendingJumpElementId: string | null;
	/** Call after the pending jump has been consumed. */
	consumeJump: () => void;
}

/** Compute the set of ancestor folder paths for a given file path. */
function getAncestorFolders(filePath: string): string[] {
	const parts = filePath.split("/");
	const folders: string[] = [];
	for (let i = 1; i < parts.length; i++) {
		folders.push(parts.slice(0, i).join("/"));
	}
	return folders;
}

/** Update the browser URL to reflect the current diagram view state. */
function syncUrlState(selectedPath: string | null): void {
	const url = new URL(window.location.href);
	if (selectedPath) {
		url.searchParams.set("view", "diagram");
		url.searchParams.set("path", selectedPath);
	} else {
		url.searchParams.delete("view");
		url.searchParams.delete("path");
	}
	history.replaceState(null, "", url.toString());
}

export function useDiagramViewer(workspaceId: string | null, initialPath?: string | null): UseDiagramViewerResult {
	const [tree, setTree] = useState<FileTreeNode[]>([]);
	const [diagramsRootExists, setDiagramsRootExists] = useState(true);
	const [isTreeLoading, setIsTreeLoading] = useState(true);
	const [selectedPath, setSelectedPath] = useState<string | null>(initialPath ?? null);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
		// Auto-expand ancestor folders if initialPath is provided
		if (initialPath) {
			return new Set(getAncestorFolders(initialPath));
		}
		return new Set();
	});
	const [content, setContent] = useState<string | null>(null);
	const [isContentLoading, setIsContentLoading] = useState(false);
	const [contentError, setContentError] = useState<string | null>(null);
	const [workspacePath, setWorkspacePath] = useState<string | null>(null);
	const [pendingJumpElementId, setPendingJumpElementId] = useState<string | null>(null);

	// Fetch tree on mount / workspace change
	useEffect(() => {
		if (!workspaceId) {
			setTree([]);
			setIsTreeLoading(false);
			return;
		}

		let cancelled = false;
		const trpc = getRuntimeTrpcClient(workspaceId);

		setIsTreeLoading(true);
		void trpc.diagrams.list.query({}).then(
			(result) => {
				if (cancelled) return;
				setTree(result.tree);
				setDiagramsRootExists(result.diagramsRootExists);
				setIsTreeLoading(false);

				if (result.diagramsRootExists) {
					const diagramsRoot = result.diagramsRoot;
					const wsPath = diagramsRoot.endsWith("/diagrams")
						? diagramsRoot.slice(0, -"/diagrams".length)
						: diagramsRoot;
					setWorkspacePath(wsPath);
				}

				// Auto-expand top-level directories (merge with any initial expansion)
				const topLevelDirs = result.tree.filter((n) => n.type === "directory").map((n) => n.path);
				if (topLevelDirs.length > 0) {
					setExpandedFolders((prev) => {
						const next = new Set(prev);
						for (const dir of topLevelDirs) {
							next.add(dir);
						}
						return next;
					});
				}
			},
			() => {
				if (cancelled) return;
				setTree([]);
				setIsTreeLoading(false);
			},
		);

		return () => {
			cancelled = true;
		};
	}, [workspaceId]);

	// Fetch content when selectedPath changes
	useEffect(() => {
		if (!workspaceId || !selectedPath) {
			setContent(null);
			setContentError(null);
			return;
		}

		let cancelled = false;
		const trpc = getRuntimeTrpcClient(workspaceId);

		setIsContentLoading(true);
		setContentError(null);
		void trpc.diagrams.getContent.query({ path: selectedPath }).then(
			(result) => {
				if (cancelled) return;
				setContent(result.content);
				setIsContentLoading(false);
			},
			(error) => {
				if (cancelled) return;
				setContent(null);
				setContentError(error instanceof Error ? error.message : "Failed to load diagram");
				setIsContentLoading(false);
			},
		);

		return () => {
			cancelled = true;
		};
	}, [workspaceId, selectedPath]);

	// Sync URL when selected path changes
	useEffect(() => {
		syncUrlState(selectedPath);
	}, [selectedPath]);

	const onSelectPath = useCallback((path: string) => {
		setSelectedPath(path);
	}, []);

	const requestJump = useCallback((path: string, elementId: string | null) => {
		setPendingJumpElementId(elementId);
		setSelectedPath(path);
		// Use pushState for jumps so browser back works
		const url = new URL(window.location.href);
		url.searchParams.set("view", "diagram");
		url.searchParams.set("path", path);
		if (elementId) {
			url.searchParams.set("at", elementId);
		} else {
			url.searchParams.delete("at");
		}
		history.pushState(null, "", url.toString());
	}, []);

	const consumeJump = useCallback(() => {
		setPendingJumpElementId(null);
	}, []);

	const onToggleFolder = useCallback((path: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	}, []);

	return useMemo(
		() => ({
			tree,
			diagramsRootExists,
			isTreeLoading,
			selectedPath,
			expandedFolders,
			content,
			isContentLoading,
			contentError,
			workspacePath,
			onSelectPath,
			onToggleFolder,
			requestJump,
			pendingJumpElementId,
			consumeJump,
		}),
		[
			tree,
			diagramsRootExists,
			isTreeLoading,
			selectedPath,
			expandedFolders,
			content,
			isContentLoading,
			contentError,
			workspacePath,
			onSelectPath,
			onToggleFolder,
			requestJump,
			pendingJumpElementId,
			consumeJump,
		],
	);
}
