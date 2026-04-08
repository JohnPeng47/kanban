import { type ReactElement, type ReactNode, useCallback, useState } from "react";
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

/** React component that handles diagram interaction: click, selection, and
 *  delegates pan/zoom to Viewport. Renders Viewport wrapping children. */
export function InteractionLayer({
	scene,
	interactiveRegistry,
	onNavigate,
	onExpand,
	onSelectionChange,
	children,
}: InteractionLayerProps): ReactElement {
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
			// hitTest takes screen-space point (uses elementFromPoint)
			const hitId = scene.hitTest(event.screenPoint);

			if (!hitId) {
				// Clear selection
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

			// Update selection
			if (interactive) {
				if (event.domEvent.shiftKey) {
					// Toggle
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
					// Select only this
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
				// Clicked non-interactive — clear selection
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

			// Fire navigate for interactive elements
			if (interactive && onNavigate) {
				onNavigate(interactive, event.domEvent);
			}

			// Fire expand — walk up ancestors to find the expandable element
			if (onExpand) {
				let expandId: string | null = hitId;
				while (expandId) {
					const el = scene.getElement(expandId);
					if (el && isExpandable(el)) {
						onExpand(expandId);
						break;
					}
					expandId = el?.parentId ?? null;
				}
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
		<Viewport scene={scene} onSceneClick={handleSceneClick}>
			{children}
		</Viewport>
	);
}
