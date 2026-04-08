import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { DiagramContentArea } from "@/components/diagram-panels/diagram-content-area";
import { DiagramTreePanel } from "@/components/diagram-panels/diagram-tree-panel";
import { DiagramViewerFallback } from "@/components/diagram-panels/diagram-viewer-fallback";
import { useDiagramViewer } from "@/hooks/use-diagram-viewer";
import { ResizeHandle } from "@/resize/resize-handle";
import { clampDiagramTreePanelWidth, useDiagramViewerLayout } from "@/resize/use-diagram-viewer-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { useWindowEvent } from "@/utils/react-use";

export function DiagramViewer({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
	const viewer = useDiagramViewer(workspaceId);
	const [containerWidth, setContainerWidth] = useState<number | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const { startDrag } = useResizeDrag();
	const { displayTreePanelWidth, setTreePanelWidth } = useDiagramViewerLayout({ containerWidth });

	const updateContainerWidth = useCallback(() => {
		const container = containerRef.current;
		if (!container) return;
		setContainerWidth(Math.max(container.offsetWidth, 1));
	}, []);

	useEffect(() => {
		updateContainerWidth();
	}, [updateContainerWidth]);

	useWindowEvent("resize", updateContainerWidth);

	const handleSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = containerRef.current;
			if (!container) return;
			const currentContainerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startWidth = displayTreePanelWidth;
			startDrag(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaX = pointerX - startX;
					setTreePanelWidth(clampDiagramTreePanelWidth(startWidth + deltaX, currentContainerWidth));
				},
				onEnd: (pointerX) => {
					const deltaX = pointerX - startX;
					setTreePanelWidth(clampDiagramTreePanelWidth(startWidth + deltaX, currentContainerWidth));
				},
			});
		},
		[displayTreePanelWidth, setTreePanelWidth, startDrag],
	);

	if (!viewer.isTreeLoading && !viewer.diagramsRootExists) {
		return <DiagramViewerFallback reason="no-diagrams-dir" />;
	}

	return (
		<div ref={containerRef} className="flex flex-1 min-h-0 overflow-hidden bg-surface-0">
			<DiagramTreePanel
				tree={viewer.tree}
				selectedPath={viewer.selectedPath}
				expandedFolders={viewer.expandedFolders}
				onSelectPath={viewer.onSelectPath}
				onToggleFolder={viewer.onToggleFolder}
				isLoading={viewer.isTreeLoading}
				panelWidth={displayTreePanelWidth}
			/>
			<ResizeHandle
				orientation="vertical"
				ariaLabel="Resize diagram tree and content panels"
				onMouseDown={handleSeparatorMouseDown}
			/>
			<DiagramContentArea
				content={viewer.content}
				isLoading={viewer.isContentLoading}
				error={viewer.contentError}
				selectedPath={viewer.selectedPath}
				workspaceId={workspaceId}
				workspacePath={viewer.workspacePath}
			/>
		</div>
	);
}
