import { forwardRef, type ReactElement, type ReactNode, useCallback, useImperativeHandle, useRef } from "react";
import type { Scene } from "../rendering/scene";
import { Viewport, type ViewportHandle, type ViewportSceneEvent } from "../rendering/viewport";
import type { InteractiveData, OverlayBadge } from "../types";
import { DiagramTooltip, type DiagramTooltipHandle } from "./tooltip";
import { useClickDispatch } from "./use-click-dispatch";
import { useSelection } from "./use-selection";

export interface SceneInputProps {
	scene: Scene;
	onNavigate?: (interactive: InteractiveData, domEvent: PointerEvent) => void;
	onSelectionChange?: (elements: InteractiveData[]) => void;
	onContextMenu?: (event: ViewportSceneEvent) => void;
	/** Called when a badge without interactive data is clicked (e.g. user-placed badges). */
	onBadgeClick?: (badge: OverlayBadge) => void;
	/** Overlay badges rendered on top of the diagram at fixed pixel size. */
	badges?: OverlayBadge[];
	/** Embedded ASCII diagram source for Ctrl+Alt+drag selection mapping. */
	asciiSource?: string | null;
	children?: ReactNode;
}

/** Re-export ViewportHandle so consumers can use it without importing viewport directly. */
export type { ViewportHandle };

/** Processes pointer input against the Scene: hit testing, selection state,
 *  click dispatch. Receives pre-classified events from Viewport.
 *  Does not decide what to do with clicks — fires onNavigate to the application layer. */
export const SceneInput = forwardRef<ViewportHandle, SceneInputProps>(function SceneInput(
	{ scene, onNavigate, onSelectionChange, onContextMenu, onBadgeClick, badges, asciiSource, children },
	ref,
): ReactElement {
	const internalViewportRef = useRef<ViewportHandle>(null);
	useImperativeHandle(ref, () => internalViewportRef.current!, []);

	const tooltipHandleRef = useRef<DiagramTooltipHandle | null>(null);
	const hideTooltip = useCallback(() => tooltipHandleRef.current?.hide(), []);

	const selection = useSelection(scene, onSelectionChange, asciiSource);
	const handleSceneClick = useClickDispatch(
		scene,
		internalViewportRef,
		selection,
		hideTooltip,
		onNavigate,
		onBadgeClick,
	);

	return (
		<>
			<DiagramTooltip scene={scene} handleRef={tooltipHandleRef} />
			<Viewport
				ref={internalViewportRef}
				scene={scene}
				onSceneClick={handleSceneClick}
				onContextMenu={onContextMenu}
				onSelectionDrag={selection.handleSelectionDrag}
				onSelectionDragEnd={selection.handleSelectionDragEnd}
				selectionOverlayPaths={selection.dragPreviewPaths}
				badges={badges}
			>
				{children}
			</Viewport>
		</>
	);
});
