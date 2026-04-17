import { X } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useRef } from "react";

import { SceneInput } from "@/diagram/input/input";
import type { Scene } from "@/diagram/rendering/scene";
import type { InteractiveData, OverlayPosition, Rect } from "@/diagram/types";
import { useDiagram } from "@/diagram/use-diagram";

/** Min popup size in px. */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
/** Max popup size as fraction of container. */
const MAX_WIDTH_RATIO = 0.85;
const MAX_HEIGHT_RATIO = 0.85;
/** Padding added around the diagram content. */
const CONTENT_PADDING = 24;
export interface PopupDiagramOverlayProps {
	/** HTML content of the diagram to render in the overlay. */
	content: string;
	/** Bounding box of the anchor element (in screen-relative px within the content area). */
	anchorBounds: Rect;
	/** Preferred position relative to the anchor. */
	position: OverlayPosition;
	/** Called when the overlay should close. */
	onClose: () => void;
	/** Called when an interactive element inside the popup is clicked. */
	onNavigate?: (interactive: InteractiveData, domEvent: PointerEvent) => void;
	/** Z-index for stacking nested popups. */
	zIndex?: number;
}

/** Fixed offset from the top-left origin. */
const ORIGIN_OFFSET = 24;

/** Compute popup size to fit diagram content, placed near the top-left origin. */
function computePopupLayout(
	containerWidth: number,
	containerHeight: number,
	diagramWidth?: number,
	diagramHeight?: number,
): { top: number; left: number; width: number; height: number } {
	const maxW = Math.max(MIN_WIDTH, containerWidth * MAX_WIDTH_RATIO);
	const maxH = Math.max(MIN_HEIGHT, containerHeight * MAX_HEIGHT_RATIO);

	let width: number;
	let height: number;

	if (diagramWidth && diagramHeight && diagramWidth > 0 && diagramHeight > 0) {
		const targetW = diagramWidth + CONTENT_PADDING;
		const targetH = diagramHeight + CONTENT_PADDING;
		const scaleToFit = Math.min(1, maxW / targetW, maxH / targetH);
		width = Math.max(MIN_WIDTH, Math.round(targetW * scaleToFit));
		height = Math.max(MIN_HEIGHT, Math.round(targetH * scaleToFit));
	} else {
		width = Math.min(maxW, containerWidth - 32);
		height = Math.min(maxH, containerHeight - 32);
	}

	return { top: ORIGIN_OFFSET, left: ORIGIN_OFFSET, width, height };
}

/** Renders a diagram as a fully interactive overlay positioned near the anchor element. */
export function PopupDiagramOverlay({
	content,
	onClose,
	onNavigate,
	zIndex = 50,
}: PopupDiagramOverlayProps): ReactElement {
	const scene = useDiagram(content);
	const containerRef = useRef<HTMLDivElement>(null);

	// ESC to close
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const handleBackdropClick = useCallback(
		(e: React.MouseEvent) => {
			if (e.target === e.currentTarget) {
				onClose();
			}
		},
		[onClose],
	);

	// Get diagram natural size from Scene root bounds
	const diagramBounds = scene?.getRoot().localBounds;

	const layout = useMemo(() => {
		const container = containerRef.current;
		if (!container) {
			return { top: ORIGIN_OFFSET, left: ORIGIN_OFFSET, width: 400, height: 300 };
		}
		return computePopupLayout(
			container.offsetWidth,
			container.offsetHeight,
			diagramBounds?.width,
			diagramBounds?.height,
		);
	}, [diagramBounds?.width, diagramBounds?.height]);

	return (
		<div ref={containerRef} className="absolute inset-0" style={{ zIndex }} onClick={handleBackdropClick}>
			{/* Semi-transparent backdrop */}
			<div className="absolute inset-0 bg-surface-0/50 backdrop-blur-[2px]" />

			{/* Positioned popup */}
			<div
				className="absolute flex flex-col border border-border-bright rounded-lg bg-surface-1 shadow-2xl overflow-hidden"
				style={{
					top: layout.top,
					left: layout.left,
					width: layout.width,
					height: layout.height,
					animation: "kb-dialog-show 150ms ease",
				}}
			>
				{/* Close button */}
				<div className="absolute top-2 right-2 z-10">
					<button
						type="button"
						className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-3 cursor-pointer"
						onClick={onClose}
					>
						<X size={16} />
					</button>
				</div>

				{/* Diagram content */}
				{scene ? (
					<PopupScene scene={scene} onNavigate={onNavigate} />
				) : (
					<div className="flex flex-1 items-center justify-center text-text-tertiary text-xs">Loading...</div>
				)}
			</div>
		</div>
	);
}

function PopupScene({
	scene,
	onNavigate,
}: {
	scene: Scene;
	onNavigate?: (interactive: InteractiveData, domEvent: PointerEvent) => void;
}): ReactElement {
	return <SceneInput scene={scene} onNavigate={onNavigate} />;
}
