import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import type { Scene } from "../rendering/scene";
import { isExpandable } from "../rendering/scene";
import { Viewport, type ViewportSceneEvent } from "../rendering/viewport";
import type { Rect } from "../types";
import type { InteractiveElement, InteractiveElementRegistry } from "./interactive-registry";

const PATH_DISPLAY_MAX_LEN = 20;

/** Truncate a file path to fit a character budget: always show filename,
 *  and prepend the closest parent directory only if the combined result fits. */
function truncatePath(path: string, maxLen: number): string {
	const lastSlash = path.lastIndexOf("/");
	if (lastSlash === -1) return path;
	const filename = path.slice(lastSlash + 1);
	const parentPath = path.slice(0, lastSlash);
	const prevSlash = parentPath.lastIndexOf("/");
	const closestParent = prevSlash === -1 ? parentPath : parentPath.slice(prevSlash + 1);
	const withParent = `${closestParent}/${filename}`;
	if (withParent.length <= maxLen) return withParent;
	return filename;
}

export interface InteractionLayerProps {
	scene: Scene;
	interactiveRegistry: InteractiveElementRegistry;
	onNavigate?: (element: InteractiveElement, domEvent: PointerEvent) => void;
	onExpand?: (elementId: string) => void;
	onSelectionChange?: (elements: InteractiveElement[]) => void;
	/** When true, single-finger touch drag draws a selection lasso instead of panning. */
	selectMode?: boolean;
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
	selectMode = false,
	children,
}: InteractionLayerProps): ReactElement {
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const tooltipRef = useRef<HTMLDivElement>(null);

	// Tooltip: mouseover/mousemove/mouseout on data-tt elements (desktop),
	// plus pointerdown on touch to show tooltip on tap.
	const touchTooltipTargetRef = useRef<Element | null>(null);

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
				touchTooltipTargetRef.current = target;
				showTooltip(target, e.clientX, e.clientY);
			} else {
				touchTooltipTargetRef.current = null;
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

	// Track the current preview set so we can re-render the path list overlay
	// and clear visuals on drag update.
	const [dragPreviewIds, setDragPreviewIds] = useState<Set<string>>(new Set());

	const handleSelectionDrag = useCallback(
		(sceneRect: Rect) => {
			const hitIds = scene.hitTestRect(sceneRect, "intersect");
			const validIds = new Set<string>();
			for (const id of hitIds) {
				if (interactiveRegistry.get(id)) {
					validIds.add(id);
				}
			}

			setDragPreviewIds((prev) => {
				// Clear visuals for elements no longer in the lasso
				for (const id of prev) {
					if (!validIds.has(id)) {
						applySelectionVisual(id, false);
					}
				}
				// Apply visuals for newly lassoed elements
				for (const id of validIds) {
					applySelectionVisual(id, true);
				}
				return validIds;
			});
		},
		[scene, interactiveRegistry, applySelectionVisual],
	);

	const dragPreviewPaths = useMemo(() => {
		const items: Array<{ id: string; path: string }> = [];
		for (const id of dragPreviewIds) {
			const el = interactiveRegistry.get(id);
			if (el?.parsedRef.filePath) {
				items.push({ id, path: truncatePath(el.parsedRef.filePath, PATH_DISPLAY_MAX_LEN) });
			}
		}
		return items;
	}, [dragPreviewIds, interactiveRegistry]);

	const handleSelectionDragEnd = useCallback(
		(sceneRect: Rect) => {
			const hitIds = scene.hitTestRect(sceneRect, "intersect");
			const newSelectedIds = new Set<string>();
			for (const id of hitIds) {
				if (interactiveRegistry.get(id)) {
					newSelectedIds.add(id);
				}
			}

			// Clear any previous selection visuals
			for (const id of selectedIds) {
				if (!newSelectedIds.has(id)) {
					applySelectionVisual(id, false);
				}
			}
			// Apply final selection visuals
			for (const id of newSelectedIds) {
				applySelectionVisual(id, true);
			}

			setDragPreviewIds(new Set());
			setSelectedIds(newSelectedIds);

			const elements = getSelectedElements(newSelectedIds);
			onSelectionChange?.(elements);

			// Collect unique file paths and copy to clipboard
			const refs = new Set<string>();
			for (const el of elements) {
				if (el.ref) {
					refs.add(el.ref);
				}
			}

			if (refs.size > 0) {
				const text = Array.from(refs).join(" ");
				navigator.clipboard.writeText(text).then(
					() => {
						showAppToast({
							intent: "success",
							message: `Copied ${refs.size} ref(s)`,
							timeout: 3000,
						});
					},
					() => {
						showAppToast({
							intent: "warning",
							message: "Failed to copy paths to clipboard",
							timeout: 3000,
						});
					},
				);
			}
		},
		[scene, interactiveRegistry, selectedIds, applySelectionVisual, getSelectedElements, onSelectionChange],
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
			<Viewport
				scene={scene}
				onSceneClick={handleSceneClick}
				onSelectionDrag={handleSelectionDrag}
				onSelectionDragEnd={handleSelectionDragEnd}
				selectionOverlayPaths={dragPreviewPaths}
				selectMode={selectMode}
			>
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
