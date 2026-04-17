import {
	forwardRef,
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { IDENTITY_TRANSFORM, type OverlayBadge, type Point, type Rect, type Transform } from "../types";
import { OverLayer, type OverLayerHandle } from "./over-layer";
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
	onContextMenu?: (event: ViewportSceneEvent) => void;
	onSelectionDrag?: (sceneRect: Rect, alt: boolean) => void;
	onSelectionDragEnd?: (sceneRect: Rect, alt: boolean) => void;
	/** When a selection lasso is active, render these labels to the left of the box. */
	selectionOverlayPaths?: Array<{ id: string; path: string }>;
	/** Overlay badges rendered on top of the diagram at fixed pixel size. */
	badges?: OverlayBadge[];
	/** When true, single-finger drag draws a selection lasso instead of panning. */
	selectMode?: boolean;
	children?: ReactNode;
}

/** Imperative handle for programmatic viewport control. */
export interface ViewportHandle {
	centerOn(scenePoint: Point, opts?: { scale?: number; animate?: boolean }): void;
	/** Identify which overlay badge (if any) a DOM element belongs to. */
	identifyOverlay(domEl: Element): OverlayBadge | null;
}

/** Viewport component that owns pan/zoom and coordinate conversion.
 *  Wraps the Scene's SVG in a container with CSS transform. */
export const Viewport = forwardRef<ViewportHandle, ViewportProps>(function Viewport(
	{
		scene,
		onSceneClick,
		onContextMenu,
		onSelectionDrag,
		onSelectionDragEnd,
		selectionOverlayPaths,
		badges,
		selectMode = false,
		children,
	},
	ref,
): ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const transformDivRef = useRef<HTMLDivElement>(null);
	const transformRef = useRef<Transform>({ ...IDENTITY_TRANSFORM });
	const overlayRef = useRef<OverLayerHandle>(null);

	// Pan state
	const pointerDownRef = useRef<{ x: number; y: number; transform: Transform; ctrl: boolean; alt: boolean } | null>(
		null,
	);
	const didDragRef = useRef(false);

	// Multi-touch pinch-to-zoom state
	const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
	const pinchStartRef = useRef<{ distance: number; midpoint: Point; transform: Transform } | null>(null);

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

	// Expose imperative handle for programmatic viewport control (e.g. jump navigation)
	useImperativeHandle(
		ref,
		() => ({
			centerOn(scenePoint: Point, opts?: { scale?: number; animate?: boolean }) {
				const container = containerRef.current;
				const transformDiv = transformDivRef.current;
				if (!container || !transformDiv) return;
				const rect = container.getBoundingClientRect();
				const scale = opts?.scale ?? transformRef.current.scale;
				const newTransform: Transform = {
					tx: rect.width / 2 - scenePoint.x * scale,
					ty: rect.height / 2 - scenePoint.y * scale,
					scale,
				};
				if (opts?.animate) {
					transformDiv.style.transition = "transform 220ms ease";
					requestAnimationFrame(() => {
						applyTransform(newTransform);
						syncRootTransform(newTransform);
						setTimeout(() => {
							transformDiv.style.transition = "";
						}, 240);
					});
				} else {
					applyTransform(newTransform);
					syncRootTransform(newTransform);
				}
			},
			identifyOverlay(domEl: Element) {
				return overlayRef.current?.identify(domEl) ?? null;
			},
		}),
		[applyTransform, syncRootTransform],
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

	// --- Pinch-to-zoom helpers ---
	const getPointerDistance = useCallback((pointers: Map<number, { x: number; y: number }>): number => {
		const pts = Array.from(pointers.values());
		if (pts.length < 2) return 0;
		const a = pts[0]!;
		const b = pts[1]!;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		return Math.sqrt(dx * dx + dy * dy);
	}, []);

	const getPointerMidpoint = useCallback((pointers: Map<number, { x: number; y: number }>): Point => {
		const pts = Array.from(pointers.values());
		if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 };
		const a = pts[0]!;
		const b = pts[1]!;
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}, []);

	// Pointer events for pan, click, and pinch-to-zoom
	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;

			// Track active pointers for multi-touch
			activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

			if (activePointersRef.current.size === 2) {
				// Second finger down → start pinch, cancel any single-finger drag
				pointerDownRef.current = null;
				didDragRef.current = false;
				setSelectionRect(null);
				pinchStartRef.current = {
					distance: getPointerDistance(activePointersRef.current),
					midpoint: getPointerMidpoint(activePointersRef.current),
					transform: { ...transformRef.current },
				};
				return;
			}

			if (activePointersRef.current.size > 2) return;

			// Treat selectMode (touch) the same as Ctrl (desktop)
			const isSelecting = event.ctrlKey || event.metaKey || (selectMode && event.pointerType === "touch");

			pointerDownRef.current = {
				x: event.clientX,
				y: event.clientY,
				transform: { ...transformRef.current },
				ctrl: isSelecting,
				alt: event.altKey,
			};
			didDragRef.current = false;
			// Don't capture yet — only capture when drag threshold is exceeded
		},
		[selectMode, getPointerDistance, getPointerMidpoint],
	);

	const onPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			// Update tracked pointer position
			if (activePointersRef.current.has(event.pointerId)) {
				activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
			}

			// Pinch-to-zoom: two active pointers
			const pinchStart = pinchStartRef.current;
			if (pinchStart && activePointersRef.current.size === 2) {
				const currentDist = getPointerDistance(activePointersRef.current);
				const currentMid = getPointerMidpoint(activePointersRef.current);
				if (pinchStart.distance === 0) return;

				const scaleFactor = currentDist / pinchStart.distance;
				const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStart.transform.scale * scaleFactor));

				const container = containerRef.current;
				if (!container) return;
				const rect = container.getBoundingClientRect();
				const cx = currentMid.x - rect.left;
				const cy = currentMid.y - rect.top;

				// Zoom around pinch midpoint + pan by midpoint delta
				const midDx = currentMid.x - pinchStart.midpoint.x;
				const midDy = currentMid.y - pinchStart.midpoint.y;
				const startCx = pinchStart.midpoint.x - rect.left;
				const startCy = pinchStart.midpoint.y - rect.top;

				const newTransform: Transform = {
					tx:
						cx -
						(startCx - pinchStart.transform.tx) * (newScale / pinchStart.transform.scale) +
						midDx -
						(cx - startCx),
					ty:
						cy -
						(startCy - pinchStart.transform.ty) * (newScale / pinchStart.transform.scale) +
						midDy -
						(cy - startCy),
					scale: newScale,
				};
				applyTransform(newTransform);
				syncRootTransform(newTransform);
				return;
			}

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
					// Ctrl+drag or select-mode drag → selection lasso
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
					onSelectionDrag(sceneRect, start.alt);
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
		[applyTransform, syncRootTransform, onSelectionDrag, screenToScene, getPointerDistance, getPointerMidpoint],
	);

	// Use window-level pointerup to always clear state, even if the event
	// target is inside dynamically-appended content (nested SVGs from expand)
	useEffect(() => {
		const onWindowPointerUp = (event: PointerEvent) => {
			// Clean up tracked pointer
			activePointersRef.current.delete(event.pointerId);

			// If we were pinching and a finger lifts, end pinch
			if (pinchStartRef.current) {
				pinchStartRef.current = null;
				// Don't fire click after pinch
				if (activePointersRef.current.size <= 1) {
					pointerDownRef.current = null;
					didDragRef.current = false;
				}
				return;
			}

			const start = pointerDownRef.current;
			if (!start) return;

			const wasDrag = didDragRef.current;
			const wasCtrl = start.ctrl;
			const wasAlt = start.alt;

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
					onSelectionDragEnd(sceneRect, wasAlt);
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

	const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		activePointersRef.current.delete(event.pointerId);
		if (activePointersRef.current.size < 2) {
			pinchStartRef.current = null;
		}
	}, []);

	const handleContextMenu = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			if (!onContextMenu) return;
			event.preventDefault();
			const screenPoint = { x: event.clientX, y: event.clientY };
			const scenePoint = screenToScene(screenPoint);
			onContextMenu({ scenePoint, screenPoint, domEvent: event.nativeEvent as unknown as PointerEvent });
		},
		[onContextMenu, screenToScene],
	);

	return (
		<div
			ref={containerRef}
			className="relative w-full h-full overflow-hidden select-none touch-none"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerCancel={onPointerCancel}
			onContextMenu={handleContextMenu}
		>
			<div ref={transformDivRef} style={{ transformOrigin: "0 0", willChange: "transform" }} />
			{badges && badges.length > 0 && (
				<OverLayer ref={overlayRef} badges={badges} scene={scene} transformRef={transformRef} />
			)}
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
});
