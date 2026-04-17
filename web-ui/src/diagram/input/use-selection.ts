import { useCallback, useMemo, useState } from "react";
import type { Scene } from "../rendering/scene";
import type { InteractiveData, Rect } from "../types";
import { copyAsciiText, copyCodeRefs } from "./clipboard";
import { truncatePath } from "./utils";

const PATH_DISPLAY_MAX_LEN = 20;

export interface UseSelectionResult {
	/** Clear all, then select exactly this element. */
	selectOnly(id: string): void;
	/** Shift-click: toggle one element in the selection set. */
	toggleSelection(id: string): void;
	/** Deselect everything. */
	clearSelection(): void;
	/** Live-preview during Ctrl+drag: highlight elements under the rect. */
	handleSelectionDrag(sceneRect: Rect, alt: boolean): void;
	/** Finalize Ctrl+drag: commit selection, copy refs or ASCII to clipboard. */
	handleSelectionDragEnd(sceneRect: Rect, alt: boolean): void;
	/** Path labels shown beside the selection rect during drag. */
	dragPreviewPaths: Array<{ id: string; path: string }>;
}

export function useSelection(
	scene: Scene,
	onSelectionChange?: (elements: InteractiveData[]) => void,
	asciiSource?: string | null,
): UseSelectionResult {
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [dragPreviewIds, setDragPreviewIds] = useState<Set<string>>(new Set());

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

	const getSelectedInteractiveData = useCallback(
		(ids: Set<string>): InteractiveData[] => {
			const result: InteractiveData[] = [];
			for (const id of ids) {
				const el = scene.getElement(id);
				if (el?.interactive) {
					result.push(el.interactive);
				}
			}
			return result;
		},
		[scene],
	);

	const selectOnly = useCallback(
		(id: string) => {
			setSelectedIds((prev) => {
				for (const prevId of prev) {
					applySelectionVisual(prevId, false);
				}
				applySelectionVisual(id, true);
				const next = new Set([id]);
				onSelectionChange?.(getSelectedInteractiveData(next));
				return next;
			});
		},
		[applySelectionVisual, getSelectedInteractiveData, onSelectionChange],
	);

	const toggleSelection = useCallback(
		(id: string) => {
			setSelectedIds((prev) => {
				const next = new Set(prev);
				if (next.has(id)) {
					next.delete(id);
					applySelectionVisual(id, false);
				} else {
					next.add(id);
					applySelectionVisual(id, true);
				}
				onSelectionChange?.(getSelectedInteractiveData(next));
				return next;
			});
		},
		[applySelectionVisual, getSelectedInteractiveData, onSelectionChange],
	);

	const clearSelection = useCallback(() => {
		for (const id of selectedIds) {
			applySelectionVisual(id, false);
		}
		setSelectedIds((prev) => {
			if (prev.size === 0) return prev;
			const empty = new Set<string>();
			onSelectionChange?.(getSelectedInteractiveData(empty));
			return empty;
		});
	}, [selectedIds, applySelectionVisual, getSelectedInteractiveData, onSelectionChange]);

	const handleSelectionDrag = useCallback(
		(sceneRect: Rect, _alt: boolean) => {
			const hitIds = scene.hitTestRect(sceneRect, "intersect");
			const validIds = new Set<string>();
			for (const id of hitIds) {
				const el = scene.getElement(id);
				if (el?.interactive || el?.sourceSpan) {
					validIds.add(id);
				}
			}

			setDragPreviewIds((prev) => {
				for (const id of prev) {
					if (!validIds.has(id)) {
						applySelectionVisual(id, false);
					}
				}
				for (const id of validIds) {
					applySelectionVisual(id, true);
				}
				return validIds;
			});
		},
		[scene, applySelectionVisual],
	);

	const handleSelectionDragEnd = useCallback(
		(sceneRect: Rect, alt: boolean) => {
			const hitIds = scene.hitTestRect(sceneRect, "intersect");
			const newSelectedIds = new Set<string>();
			for (const id of hitIds) {
				const el = scene.getElement(id);
				if (el?.interactive || el?.sourceSpan) {
					newSelectedIds.add(id);
				}
			}

			for (const id of selectedIds) {
				if (!newSelectedIds.has(id)) {
					applySelectionVisual(id, false);
				}
			}
			for (const id of newSelectedIds) {
				applySelectionVisual(id, true);
			}

			setDragPreviewIds(new Set());
			setSelectedIds(newSelectedIds);

			const elements = getSelectedInteractiveData(newSelectedIds);
			onSelectionChange?.(elements);

			if (alt) {
				copyAsciiText(sceneRect, scene, asciiSource);
			} else {
				copyCodeRefs(elements);
			}
		},
		[scene, selectedIds, applySelectionVisual, getSelectedInteractiveData, onSelectionChange, asciiSource],
	);

	const dragPreviewPaths = useMemo(() => {
		const items: Array<{ id: string; path: string }> = [];
		for (const id of dragPreviewIds) {
			const el = scene.getElement(id);
			if (el?.interactive?.parsedRef.filePath) {
				items.push({ id, path: truncatePath(el.interactive.parsedRef.filePath, PATH_DISPLAY_MAX_LEN) });
			}
		}
		return items;
	}, [dragPreviewIds, scene]);

	return {
		selectOnly,
		toggleSelection,
		clearSelection,
		handleSelectionDrag,
		handleSelectionDragEnd,
		dragPreviewPaths,
	};
}
