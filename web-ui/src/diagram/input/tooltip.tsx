import { type ReactElement, useEffect, useRef } from "react";
import type { Scene } from "../rendering/scene";

export interface DiagramTooltipHandle {
	hide(): void;
}

export interface DiagramTooltipProps {
	scene: Scene;
	/** Optional ref to expose imperative hide() to the parent for click-dismiss. */
	handleRef?: React.MutableRefObject<DiagramTooltipHandle | null>;
}

/**
 * Floating tooltip that shows `data-tt` content when the user hovers or taps
 * interactive SVG elements in the diagram. Self-contained: attaches its own
 * DOM listeners and owns its positioning.
 */
export function DiagramTooltip({ scene, handleRef }: DiagramTooltipProps): ReactElement {
	const tooltipRef = useRef<HTMLDivElement>(null);
	const touchTargetRef = useRef<Element | null>(null);

	// Expose imperative hide() for parent (e.g. to dismiss on click).
	useEffect(() => {
		if (!handleRef) return;
		handleRef.current = {
			hide: () => tooltipRef.current?.classList.remove("visible"),
		};
		return () => {
			if (handleRef.current) handleRef.current = null;
		};
	}, [handleRef]);

	useEffect(() => {
		const svg = scene.getSvgElement();
		const tooltip = tooltipRef.current;
		if (!svg || !tooltip) return;

		const showTooltip = (target: Element, x: number, y: number) => {
			const tt = target.getAttribute("data-tt") ?? "";
			const parts = tt.split(" — ");
			tooltip.innerHTML = `<span class="tt-file">${parts[0]}</span>${
				parts[1] ? `<div class="tt-hint">${parts[1]}</div>` : ""
			}<div class="tt-action">${"ontouchstart" in window ? "tap to jump to code" : "click to jump to code"}</div>`;
			tooltip.style.left = `${x + 14}px`;
			tooltip.style.top = `${y - 10}px`;
			tooltip.classList.add("visible");
		};

		const onMouseOver = (e: MouseEvent) => {
			const target = (e.target as Element).closest?.("[data-tt]");
			if (!target) {
				tooltip.classList.remove("visible");
				return;
			}
			showTooltip(target, e.clientX, e.clientY);
		};

		const onMouseMove = (e: MouseEvent) => {
			tooltip.style.left = `${e.clientX + 14}px`;
			tooltip.style.top = `${e.clientY - 10}px`;
		};

		const onMouseOut = (e: MouseEvent) => {
			if (!(e.target as Element).closest?.("[data-tt]")) {
				tooltip.classList.remove("visible");
			}
		};

		// Touch: show tooltip on tap, dismiss on tap elsewhere
		const onPointerDown = (e: PointerEvent) => {
			if (e.pointerType !== "touch") return;
			const target = (e.target as Element).closest?.("[data-tt]");
			if (target) {
				touchTargetRef.current = target;
				showTooltip(target, e.clientX, e.clientY);
			} else {
				touchTargetRef.current = null;
				tooltip.classList.remove("visible");
			}
		};

		svg.addEventListener("mouseover", onMouseOver);
		svg.addEventListener("mousemove", onMouseMove);
		svg.addEventListener("mouseout", onMouseOut);
		svg.addEventListener("pointerdown", onPointerDown);
		return () => {
			svg.removeEventListener("mouseover", onMouseOver);
			svg.removeEventListener("mousemove", onMouseMove);
			svg.removeEventListener("mouseout", onMouseOut);
			svg.removeEventListener("pointerdown", onPointerDown);
		};
	}, [scene]);

	return (
		<>
			<div
				ref={tooltipRef}
				className="diagram-tooltip"
				style={{
					position: "fixed",
					pointerEvents: "none",
					background: "#2D3339",
					color: "#E6EDF3",
					fontFamily: "'JetBrains Mono','Fira Code','SF Mono',monospace",
					fontSize: 11,
					padding: "6px 10px",
					borderRadius: 6,
					border: "1px solid #444C56",
					boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
					opacity: 0,
					transition: "opacity 0.15s ease",
					zIndex: 100,
					maxWidth: 400,
					whiteSpace: "nowrap",
				}}
			/>
			<style>{`
				.diagram-tooltip.visible { opacity: 1 !important; }
				.diagram-tooltip .tt-file { color: #4C9AFF; }
				.diagram-tooltip .tt-hint { color: #6E7681; font-size: 10px; margin-top: 2px; }
				.diagram-tooltip .tt-action { color: #D29922; font-size: 10px; margin-top: 3px; }
			`}</style>
		</>
	);
}
