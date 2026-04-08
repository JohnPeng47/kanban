import { type ReactElement, type ReactNode, useCallback, useEffect, useRef } from "react";
import { IDENTITY_TRANSFORM, type Point, type Transform } from "../types";
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
	children?: ReactNode;
}

/** Viewport component that owns pan/zoom and coordinate conversion.
 *  Wraps the Scene's SVG in a container with CSS transform. */
export function Viewport({ scene, onSceneClick, children }: ViewportProps): ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const transformDivRef = useRef<HTMLDivElement>(null);
	const transformRef = useRef<Transform>({ ...IDENTITY_TRANSFORM });

	// Pan state
	const pointerDownRef = useRef<{ x: number; y: number; transform: Transform } | null>(null);
	const didDragRef = useRef(false);

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
		};
		didDragRef.current = false;
		containerRef.current?.setPointerCapture(event.pointerId);
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
			}

			if (didDragRef.current) {
				const newTransform: Transform = {
					tx: start.transform.tx + dx,
					ty: start.transform.ty + dy,
					scale: start.transform.scale,
				};
				applyTransform(newTransform);
				syncRootTransform(newTransform);
			}
		},
		[applyTransform, syncRootTransform],
	);

	const onPointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			containerRef.current?.releasePointerCapture(event.pointerId);

			if (!didDragRef.current && pointerDownRef.current && onSceneClick) {
				const screenPoint = { x: event.clientX, y: event.clientY };
				const scenePoint = screenToScene(screenPoint);
				onSceneClick({
					scenePoint,
					screenPoint,
					domEvent: event.nativeEvent,
				});
			}

			pointerDownRef.current = null;
			didDragRef.current = false;
		},
		[onSceneClick, screenToScene],
	);

	return (
		<div
			ref={containerRef}
			className="relative w-full h-full overflow-hidden"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
		>
			<div ref={transformDivRef} style={{ transformOrigin: "0 0", willChange: "transform" }} />
			{children}
		</div>
	);
}
