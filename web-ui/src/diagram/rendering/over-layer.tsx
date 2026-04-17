import { forwardRef, type ReactElement, useEffect, useImperativeHandle, useRef } from "react";
import type { BadgeAnchor, OverlayBadge, Transform } from "../types";
import type { Scene } from "./scene";

/** Resolve a badge anchor to screen-space (x, y) relative to the container. */
function resolveAnchor(anchor: BadgeAnchor, transform: Transform, scene: Scene): { x: number; y: number } {
	switch (anchor.space) {
		case "screen":
			return { x: anchor.x, y: anchor.y };

		case "scene":
			return {
				x: anchor.x * transform.scale + transform.tx,
				y: anchor.y * transform.scale + transform.ty,
			};

		case "element": {
			const bounds = scene.getWorldBounds(anchor.elementId);
			if (bounds.width === 0 && bounds.height === 0) return { x: 0, y: 0 };

			let sx: number;
			let sy: number;
			switch (anchor.corner) {
				case "top-left":
					sx = bounds.x;
					sy = bounds.y;
					break;
				case "top-right":
					sx = bounds.x + bounds.width;
					sy = bounds.y;
					break;
				case "bottom-left":
					sx = bounds.x;
					sy = bounds.y + bounds.height;
					break;
				case "bottom-right":
					sx = bounds.x + bounds.width;
					sy = bounds.y + bounds.height;
					break;
				default:
					sx = bounds.x + bounds.width / 2;
					sy = bounds.y + bounds.height / 2;
					break;
			}

			return {
				x: sx * transform.scale + transform.tx,
				y: sy * transform.scale + transform.ty,
			};
		}
	}
}

/** Imperative handle for identifying badge clicks from outside. */
export interface OverLayerHandle {
	/** Given a DOM element (from elementFromPoint), return the badge it belongs to, or null. */
	identify(domEl: Element): OverlayBadge | null;
}

export interface OverLayerProps {
	badges: OverlayBadge[];
	scene: Scene;
	/** Ref to the Viewport's current transform. Read on every animation frame. */
	transformRef: React.RefObject<Transform>;
}

/** Renders overlay badges on top of the diagram, positioned in screen space
 *  but anchored to scene coordinates. Uses rAF to sync with pan/zoom without
 *  React re-renders. */
export const OverLayer = forwardRef<OverLayerHandle, OverLayerProps>(function OverLayer(
	{ badges, scene, transformRef },
	ref,
): ReactElement {
	const badgeRefsMap = useRef<Map<string, HTMLButtonElement>>(new Map());

	useImperativeHandle(
		ref,
		() => ({
			identify(domEl: Element): OverlayBadge | null {
				const btn = domEl instanceof HTMLButtonElement ? domEl : domEl.closest?.("button");
				if (!btn) return null;
				for (const badge of badges) {
					const el = badgeRefsMap.current.get(badge.id);
					if (el === btn) return badge;
				}
				return null;
			},
		}),
		[badges],
	);

	// rAF loop: sync badge screen positions with viewport transform
	useEffect(() => {
		if (badges.length === 0) return;

		let rafId: number;
		const sync = () => {
			const t = transformRef.current;
			if (!t) {
				rafId = requestAnimationFrame(sync);
				return;
			}
			for (const badge of badges) {
				const dom = badgeRefsMap.current.get(badge.id);
				if (!dom) continue;
				const pos = resolveAnchor(badge.anchor, t, scene);
				dom.style.left = `${pos.x}px`;
				dom.style.top = `${pos.y}px`;
			}
			rafId = requestAnimationFrame(sync);
		};
		rafId = requestAnimationFrame(sync);
		return () => cancelAnimationFrame(rafId);
	}, [badges, scene, transformRef]);

	if (badges.length === 0) return <></>;

	return (
		<div className="absolute inset-0 overflow-hidden" style={{ zIndex: 10 }}>
			{badges.map((badge) => (
				<button
					key={badge.id}
					type="button"
					ref={(el) => {
						if (el) {
							badgeRefsMap.current.set(badge.id, el);
						} else {
							badgeRefsMap.current.delete(badge.id);
						}
					}}
					className="absolute flex items-center justify-center rounded-full text-[10px] font-bold leading-none cursor-pointer transition-transform hover:scale-125"
					style={{
						width: 18,
						height: 18,
						marginLeft: -9,
						marginTop: -9,
						color: badge.style?.color ?? "#fff",
						background: badge.style?.background ?? "#4C9AFF",
						border: `1.5px solid ${badge.style?.borderColor ?? "transparent"}`,
						pointerEvents: "auto",
					}}
				>
					{badge.text}
				</button>
			))}
		</div>
	);
});
