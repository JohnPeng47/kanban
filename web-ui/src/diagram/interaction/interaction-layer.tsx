import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Scene } from "../rendering/scene";
import { isExpandable } from "../rendering/scene";
import { Viewport, type ViewportSceneEvent } from "../rendering/viewport";
import type { InteractiveElement, InteractiveElementRegistry } from "./interactive-registry";

export interface InteractionLayerProps {
	scene: Scene;
	interactiveRegistry: InteractiveElementRegistry;
	onNavigate?: (element: InteractiveElement, domEvent: PointerEvent) => void;
	onExpand?: (elementId: string) => void;
	onSelectionChange?: (elements: InteractiveElement[]) => void;
	children?: ReactNode;
}

/** React component that handles diagram interaction: click, selection, tooltip,
 *  and delegates pan/zoom to Viewport. Renders Viewport wrapping children. */
export function InteractionLayer({
	scene,
	interactiveRegistry,
	onNavigate,
	onExpand,
	onSelectionChange,
	children,
}: InteractionLayerProps): ReactElement {
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const tooltipRef = useRef<HTMLDivElement>(null);

	// Tooltip: mouseover/mousemove/mouseout on data-tt elements
	useEffect(() => {
		const svg = scene.getSvgElement();
		const tooltip = tooltipRef.current;
		if (!svg || !tooltip) return;

		const onMouseOver = (e: MouseEvent) => {
			const target = (e.target as Element).closest?.("[data-tt]");
			if (!target) {
				tooltip.classList.remove("visible");
				return;
			}
			const tt = target.getAttribute("data-tt") ?? "";
			const parts = tt.split(" — ");
			tooltip.innerHTML = `<span class="tt-file">${parts[0]}</span>${
				parts[1] ? `<div class="tt-hint">${parts[1]}</div>` : ""
			}<div class="tt-action">click to jump to code</div>`;
			tooltip.classList.add("visible");
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

		svg.addEventListener("mouseover", onMouseOver);
		svg.addEventListener("mousemove", onMouseMove);
		svg.addEventListener("mouseout", onMouseOut);
		return () => {
			svg.removeEventListener("mouseover", onMouseOver);
			svg.removeEventListener("mousemove", onMouseMove);
			svg.removeEventListener("mouseout", onMouseOut);
		};
	}, [scene]);

	const applySelectionVisual = useCallback(
		(id: string, selected: boolean) => {
			const svg = scene.getSvgElement();
			const g = svg.querySelector(`[data-reflow-group="${id}"]`) ?? svg.querySelector(`[data-interactive="${id}"]`);
			if (g) {
				g.classList.toggle("selected", selected);
			}
		},
		[scene],
	);

	const getSelectedElements = useCallback(
		(ids: Set<string>): InteractiveElement[] => {
			return Array.from(ids)
				.map((id) => interactiveRegistry.get(id))
				.filter((el): el is InteractiveElement => el != null);
		},
		[interactiveRegistry],
	);

	const handleSceneClick = useCallback(
		(event: ViewportSceneEvent) => {
			// Hide tooltip on click
			tooltipRef.current?.classList.remove("visible");

			const hitId = scene.hitTest(event.screenPoint);

			if (!hitId) {
				for (const id of selectedIds) {
					applySelectionVisual(id, false);
				}
				setSelectedIds((prev) => {
					if (prev.size === 0) return prev;
					const empty = new Set<string>();
					onSelectionChange?.(getSelectedElements(empty));
					return empty;
				});
				return;
			}

			const interactive = interactiveRegistry.get(hitId);

			// Check if this click resolves to an expandable ancestor
			let expandableId: string | null = null;
			if (onExpand) {
				let walkId: string | null = hitId;
				while (walkId) {
					const el = scene.getElement(walkId);
					if (el && isExpandable(el)) {
						expandableId = walkId;
						break;
					}
					walkId = el?.parentId ?? null;
				}
			}

			// Update selection
			if (interactive) {
				if (event.domEvent.shiftKey) {
					setSelectedIds((prev) => {
						const next = new Set(prev);
						if (next.has(hitId)) {
							next.delete(hitId);
							applySelectionVisual(hitId, false);
						} else {
							next.add(hitId);
							applySelectionVisual(hitId, true);
						}
						onSelectionChange?.(getSelectedElements(next));
						return next;
					});
				} else {
					setSelectedIds((prev) => {
						for (const id of prev) {
							applySelectionVisual(id, false);
						}
						applySelectionVisual(hitId, true);
						const next = new Set([hitId]);
						onSelectionChange?.(getSelectedElements(next));
						return next;
					});
				}
			} else {
				for (const id of selectedIds) {
					applySelectionVisual(id, false);
				}
				setSelectedIds((prev) => {
					if (prev.size === 0) return prev;
					const empty = new Set<string>();
					onSelectionChange?.(getSelectedElements(empty));
					return empty;
				});
			}

			// If expand found, fire expand and skip navigate
			if (expandableId) {
				onExpand?.(expandableId);
				return;
			}

			// Fire navigate only if no expand
			if (interactive && onNavigate) {
				onNavigate(interactive, event.domEvent);
			}
		},
		[
			scene,
			interactiveRegistry,
			selectedIds,
			applySelectionVisual,
			getSelectedElements,
			onNavigate,
			onExpand,
			onSelectionChange,
		],
	);

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
			<Viewport scene={scene} onSceneClick={handleSceneClick}>
				{children}
			</Viewport>
			<style>{`
				.diagram-tooltip.visible { opacity: 1 !important; }
				.diagram-tooltip .tt-file { color: #4C9AFF; }
				.diagram-tooltip .tt-hint { color: #6E7681; font-size: 10px; margin-top: 2px; }
				.diagram-tooltip .tt-action { color: #D29922; font-size: 10px; margin-top: 3px; }
			`}</style>
		</>
	);
}
