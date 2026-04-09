import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { IDENTITY_TRANSFORM, type Point, type Rect, type Transform } from "../types";
import type { Scene } from "./scene";

const ZOOM_SENSITIVITY = 0.002;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const DRAG_THRESHOLD = 4;

export interface ViewportSceneEvent {
	scenePoint: Point;
	screenPoint: Point;
	domEvent: PointerEvent;
}

export interface ViewportProps {
	scene: Scene;
	onSceneClick?: (event: ViewportSceneEvent) => void;
	onSelectionDrag?: (sceneRect: Rect) => void;
	onSelectionDragEnd?: (sceneRect: Rect) => void;
	/** When a selection lasso is active, render these labels to the left of the box. */
	selectionOverlayPaths?: Array<{ id: string; path: string }>;
	children?: ReactNode;
}

/** Viewport component that owns pan/zoom and coordinate conversion.
 *  Wraps the Scene's SVG in a container with CSS transform. */
export function Viewport({
	scene,
	onSceneClick,
	onSelectionDrag,
	onSelectionDragEnd,
	selectionOverlayPaths,
	children,
}: ViewportProps): ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const transformDivRef = useRef<HTMLDivElement>(null);
	const transformRef = useRef<Transform>({ ...IDENTITY_TRANSFORM });

	// Pan state
	const pointerDownRef = useRef<{ x: number; y: number; transform: Transform; ctrl: boolean } | null>(null);
	const didDragRef = useRef(false);

	// Selection drag overlay (screen-space rect)
	const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

	// Mount SVG into transformDiv
	useEffect(() => {
		const transformDiv = transformDivRef.current;
		if (!transformDiv) return;
		const svg = scene.getSvgElement();
		transformDiv.appendChild(svg);
		return () => {
			if (svg.parentElement === transformDiv) {
				transformDiv.removeChild(svg);
			}
		};
	}, [scene]);

	const applyTransform = useCallback((t: Transform) => {
		transformRef.current = t;
		const el = transformDivRef.current;
		if (el) {
			el.style.transform = `translate(${t.tx}px,${t.ty}px) scale(${t.scale})`;
		}
	}, []);

	const screenToScene = useCallback((screenPoint: Point): Point => {
		const container = containerRef.current;
		if (!container) return { x: screenPoint.x, y: screenPoint.y };
		const rect = container.getBoundingClientRect();
		const { tx, ty, scale } = transformRef.current;
		return {
			x: (screenPoint.x - rect.left - tx) / scale,
			y: (screenPoint.y - rect.top - ty) / scale,
		};
	}, []);

	// Keep Scene's root transform in sync for bounds calculations
	const syncRootTransform = useCallback(
		(t: Transform) => {
			scene.setTransform("root", t);
		},
		[scene],
	);

	// Wheel zoom
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const { tx, ty, scale } = transformRef.current;
			const delta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : ZOOM_SENSITIVITY);
			const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (1 + delta)));

			const rect = container.getBoundingClientRect();
			const cursorX = event.clientX - rect.left;
			const cursorY = event.clientY - rect.top;

			const newTransform: Transform = {
				tx: cursorX - (cursorX - tx) * (newScale / scale),
				ty: cursorY - (cursorY - ty) * (newScale / scale),
				scale: newScale,
			};
			applyTransform(newTransform);
			syncRootTransform(newTransform);
		};

		container.addEventListener("wheel", onWheel, { passive: false });
		return () => container.removeEventListener("wheel", onWheel);
	}, [applyTransform, syncRootTransform]);

	// Pointer events for pan and click
	const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		pointerDownRef.current = {
			x: event.clientX,
			y: event.clientY,
			transform: { ...transformRef.current },
			ctrl: event.ctrlKey || event.metaKey,
		};
		didDragRef.current = false;
		// Don't capture yet — only capture when drag threshold is exceeded
	}, []);

	const onPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const start = pointerDownRef.current;
			if (!start) return;

			const dx = event.clientX - start.x;
			const dy = event.clientY - start.y;
			const distance = Math.sqrt(dx * dx + dy * dy);

			if (!didDragRef.current && distance > DRAG_THRESHOLD) {
				didDragRef.current = true;
				containerRef.current?.setPointerCapture(event.pointerId);
			}

			if (didDragRef.current) {
				if (start.ctrl && onSelectionDrag) {
					// Ctrl+drag → selection lasso
					const container = containerRef.current;
					if (container) {
						const containerRect = container.getBoundingClientRect();
						const sx = start.x - containerRect.left;
						const sy = start.y - containerRect.top;
						const cx = event.clientX - containerRect.left;
						const cy = event.clientY - containerRect.top;
						setSelectionRect({
							x: Math.min(sx, cx),
							y: Math.min(sy, cy),
							w: Math.abs(cx - sx),
							h: Math.abs(cy - sy),
						});
					}

					const startScene = screenToScene({ x: start.x, y: start.y });
					const currentScene = screenToScene({ x: event.clientX, y: event.clientY });
					const sceneRect: Rect = {
						x: Math.min(startScene.x, currentScene.x),
						y: Math.min(startScene.y, currentScene.y),
						width: Math.abs(currentScene.x - startScene.x),
						height: Math.abs(currentScene.y - startScene.y),
					};
					onSelectionDrag(sceneRect);
				} else {
					// Normal drag → pan
					const newTransform: Transform = {
						tx: start.transform.tx + dx,
						ty: start.transform.ty + dy,
						scale: start.transform.scale,
					};
					applyTransform(newTransform);
					syncRootTransform(newTransform);
				}
			}
		},
		[applyTransform, syncRootTransform, onSelectionDrag, screenToScene],
	);

	// Use window-level pointerup to always clear state, even if the event
	// target is inside dynamically-appended content (nested SVGs from expand)
	useEffect(() => {
		const onWindowPointerUp = (event: PointerEvent) => {
			const start = pointerDownRef.current;
			if (!start) return;

			const wasDrag = didDragRef.current;
			const wasCtrl = start.ctrl;

			// Clear state FIRST — ensures cleanup even if click handler throws
			pointerDownRef.current = null;
			didDragRef.current = false;
			setSelectionRect(null);

			if (wasDrag) {
				try {
					containerRef.current?.releasePointerCapture(event.pointerId);
				} catch {
					// Pointer capture may not be held
				}

				if (wasCtrl && onSelectionDragEnd) {
					const startScene = screenToScene({ x: start.x, y: start.y });
					const endScene = screenToScene({ x: event.clientX, y: event.clientY });
					const sceneRect: Rect = {
						x: Math.min(startScene.x, endScene.x),
						y: Math.min(startScene.y, endScene.y),
						width: Math.abs(endScene.x - startScene.x),
						height: Math.abs(endScene.y - startScene.y),
					};
					onSelectionDragEnd(sceneRect);
				}
				return;
			}

			if (onSceneClick) {
				const screenPoint = { x: event.clientX, y: event.clientY };
				const scenePoint = screenToScene(screenPoint);
				onSceneClick({
					scenePoint,
					screenPoint,
					domEvent: event,
				});
			}
		};

		window.addEventListener("pointerup", onWindowPointerUp);
		return () => window.removeEventListener("pointerup", onWindowPointerUp);
	}, [onSceneClick, onSelectionDragEnd, screenToScene]);

	return (
		<div
			ref={containerRef}
			className="relative w-full h-full overflow-hidden select-none"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
		>
			<div ref={transformDivRef} style={{ transformOrigin: "0 0", willChange: "transform" }} />
			{children}
			{selectionRect && (
				<div
					className="absolute pointer-events-none border border-accent bg-accent/8"
					style={{
						left: selectionRect.x,
						top: selectionRect.y,
						width: selectionRect.w,
						height: selectionRect.h,
					}}
				/>
			)}
			{selectionRect && selectionOverlayPaths && selectionOverlayPaths.length > 0 ? (
				<div
					className="absolute pointer-events-none flex flex-col items-end gap-0.5"
					style={{
						left: 0,
						top: selectionRect.y,
						width: Math.max(0, selectionRect.x - 6),
					}}
				>
					{selectionOverlayPaths.map((item) => (
						<div
							key={item.id}
							className="font-mono text-[11px] text-text-primary bg-surface-2 border border-border rounded px-1.5 py-px whitespace-nowrap"
						>
							{item.path}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
