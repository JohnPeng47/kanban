import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import type { ReactElement } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { FileTreeNode } from "@/utils/file-tree";

function DiagramTreeRow({
	node,
	depth,
	selectedPath,
	expandedFolders,
	onSelectPath,
	onToggleFolder,
}: {
	node: FileTreeNode;
	depth: number;
	selectedPath: string | null;
	expandedFolders: Set<string>;
	onSelectPath: (path: string) => void;
	onToggleFolder: (path: string) => void;
}): ReactElement {
	const isDirectory = node.type === "directory";
	const isSelected = !isDirectory && node.path === selectedPath;
	const isExpanded = isDirectory && expandedFolders.has(node.path);

	return (
		<div>
			<button
				type="button"
				className={cn(
					"flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-xs",
					isDirectory && "cursor-pointer text-text-tertiary",
					isSelected && "bg-accent text-white",
					!isDirectory && !isSelected && "cursor-pointer text-text-secondary hover:bg-surface-3",
				)}
				style={{ paddingLeft: depth * 16 + 8 }}
				onClick={() => {
					if (isDirectory) {
						onToggleFolder(node.path);
					} else {
						onSelectPath(node.path);
					}
				}}
			>
				{isDirectory ? (
					<>
						{isExpanded ? (
							<ChevronDown size={12} className="shrink-0" />
						) : (
							<ChevronRight size={12} className="shrink-0" />
						)}
						{isExpanded ? (
							<FolderOpen size={14} className="shrink-0" />
						) : (
							<Folder size={14} className="shrink-0" />
						)}
					</>
				) : (
					<>
						<span className="w-3 shrink-0" />
						<FileText size={14} className="shrink-0" />
					</>
				)}
				<span className="truncate">{node.name}</span>
				{!isDirectory && node.name.endsWith(".html") ? (
					<span
						className={cn(
							"ml-auto shrink-0 text-[10px] font-mono",
							isSelected ? "text-white/70" : "text-status-blue",
						)}
					>
						HTML
					</span>
				) : null}
			</button>
			{isDirectory && isExpanded && node.children.length > 0 ? (
				<div>
					{node.children.map((child) => (
						<DiagramTreeRow
							key={child.path}
							node={child}
							depth={depth + 1}
							selectedPath={selectedPath}
							expandedFolders={expandedFolders}
							onSelectPath={onSelectPath}
							onToggleFolder={onToggleFolder}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

export function DiagramTreePanel({
	tree,
	selectedPath,
	expandedFolders,
	onSelectPath,
	onToggleFolder,
	isLoading,
	panelWidth,
}: {
	tree: FileTreeNode[];
	selectedPath: string | null;
	expandedFolders: Set<string>;
	onSelectPath: (path: string) => void;
	onToggleFolder: (path: string) => void;
	isLoading: boolean;
	panelWidth: number;
}): ReactElement {
	return (
		<div className="flex flex-col min-w-0 min-h-0 bg-surface-0" style={{ width: panelWidth, flexShrink: 0 }}>
			<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2">
				{isLoading ? (
					<div className="flex items-center justify-center py-12">
						<Spinner size={20} />
					</div>
				) : tree.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
						<FolderOpen size={40} />
						<span className="text-xs">No diagrams found</span>
					</div>
				) : (
					<div>
						{tree.map((node) => (
							<DiagramTreeRow
								key={node.path}
								node={node}
								depth={0}
								selectedPath={selectedPath}
								expandedFolders={expandedFolders}
								onSelectPath={onSelectPath}
								onToggleFolder={onToggleFolder}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
