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
}

export function useDiagramViewer(workspaceId: string | null): UseDiagramViewerResult {
	const [tree, setTree] = useState<FileTreeNode[]>([]);
	const [diagramsRootExists, setDiagramsRootExists] = useState(true);
	const [isTreeLoading, setIsTreeLoading] = useState(true);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
	const [content, setContent] = useState<string | null>(null);
	const [isContentLoading, setIsContentLoading] = useState(false);
	const [contentError, setContentError] = useState<string | null>(null);
	const [workspacePath, setWorkspacePath] = useState<string | null>(null);

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

				// Store the workspace path for navigate calls
				if (result.diagramsRootExists) {
					// diagramsRoot is "{workspacePath}/diagrams", extract workspace path
					const diagramsRoot = result.diagramsRoot;
					const wsPath = diagramsRoot.endsWith("/diagrams")
						? diagramsRoot.slice(0, -"/diagrams".length)
						: diagramsRoot;
					setWorkspacePath(wsPath);
				}

				// Auto-expand top-level directories
				const topLevelDirs = result.tree.filter((n) => n.type === "directory").map((n) => n.path);
				if (topLevelDirs.length > 0) {
					setExpandedFolders(new Set(topLevelDirs));
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

	const onSelectPath = useCallback((path: string) => {
		setSelectedPath(path);
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
		],
	);
}
