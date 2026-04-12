import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { CodeVizStatusIndicator } from "@/components/diagram-panels/code-viz-status-indicator";
import { DiagramContentArea } from "@/components/diagram-panels/diagram-content-area";
import { DiagramTreePanel } from "@/components/diagram-panels/diagram-tree-panel";
import { DiagramViewerFallback } from "@/components/diagram-panels/diagram-viewer-fallback";
import { useCodeVizStatus } from "@/hooks/use-code-viz-status";
import { type UseDiagramAgentPanelInput, useDiagramAgentPanel } from "@/hooks/use-diagram-agent-panel";
import { useDiagramViewer } from "@/hooks/use-diagram-viewer";
import { ResizeHandle } from "@/resize/resize-handle";
import {
	clampDiagramAgentPanelWidth,
	clampDiagramTreePanelWidth,
	useDiagramViewerLayout,
} from "@/resize/use-diagram-viewer-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { useWindowEvent } from "@/utils/react-use";

export function DiagramViewer({
	workspaceId,
	initialPath,
	agentPanelInput,
}: {
	workspaceId: string | null;
	initialPath?: string | null;
	agentPanelInput: UseDiagramAgentPanelInput;
}): React.ReactElement {
	const viewer = useDiagramViewer(workspaceId, initialPath ?? null);
	const codeVizStatus = useCodeVizStatus(workspaceId);
	const agentPanel = useDiagramAgentPanel(agentPanelInput);
	const [containerWidth, setContainerWidth] = useState<number | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const { startDrag } = useResizeDrag();
	const { displayTreePanelWidth, setTreePanelWidth, displayAgentPanelWidth, setAgentPanelWidth } =
		useDiagramViewerLayout({ containerWidth });

	const updateContainerWidth = useCallback(() => {
		const container = containerRef.current;
		if (!container) return;
		setContainerWidth(Math.max(container.offsetWidth, 1));
	}, []);

	useEffect(() => {
		updateContainerWidth();
	}, [updateContainerWidth]);

	useWindowEvent("resize", updateContainerWidth);

	const handleTreeSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = containerRef.current;
			if (!container) return;
			const currentContainerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startWidth = displayTreePanelWidth;
			const siblingAgentWidth = displayAgentPanelWidth;
			startDrag(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaX = pointerX - startX;
					setTreePanelWidth(
						clampDiagramTreePanelWidth(startWidth + deltaX, currentContainerWidth, siblingAgentWidth),
					);
				},
				onEnd: (pointerX) => {
					const deltaX = pointerX - startX;
					setTreePanelWidth(
						clampDiagramTreePanelWidth(startWidth + deltaX, currentContainerWidth, siblingAgentWidth),
					);
				},
			});
		},
		[displayTreePanelWidth, displayAgentPanelWidth, setTreePanelWidth, startDrag],
	);

	const handleAgentSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = containerRef.current;
			if (!container) return;
			const currentContainerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startWidth = displayAgentPanelWidth;
			const siblingTreeWidth = displayTreePanelWidth;
			startDrag(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaX = pointerX - startX;
					// Dragging the right separator left should grow the agent panel
					setAgentPanelWidth(
						clampDiagramAgentPanelWidth(startWidth - deltaX, currentContainerWidth, siblingTreeWidth),
					);
				},
				onEnd: (pointerX) => {
					const deltaX = pointerX - startX;
					setAgentPanelWidth(
						clampDiagramAgentPanelWidth(startWidth - deltaX, currentContainerWidth, siblingTreeWidth),
					);
				},
			});
		},
		[displayAgentPanelWidth, displayTreePanelWidth, setAgentPanelWidth, startDrag],
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
				onMouseDown={handleTreeSeparatorMouseDown}
			/>
			<div className="relative flex flex-1 min-w-0 min-h-0">
				<DiagramContentArea
					content={viewer.content}
					isLoading={viewer.isContentLoading}
					error={viewer.contentError}
					selectedPath={viewer.selectedPath}
					workspaceId={workspaceId}
					workspacePath={viewer.workspacePath}
					onRequestJump={viewer.requestJump}
					pendingJumpElementId={viewer.pendingJumpElementId}
					onJumpConsumed={viewer.consumeJump}
				/>
				<div className="absolute top-2 right-2 z-10">
					<CodeVizStatusIndicator state={codeVizStatus.state} />
				</div>
			</div>
			{agentPanel ? (
				<>
					<ResizeHandle
						orientation="vertical"
						ariaLabel="Resize diagram content and agent panels"
						onMouseDown={handleAgentSeparatorMouseDown}
					/>
					<div className="flex min-h-0 shrink-0 flex-col bg-surface-1" style={{ width: displayAgentPanelWidth }}>
						{agentPanel}
					</div>
				</>
			) : null}
		</div>
	);
}
