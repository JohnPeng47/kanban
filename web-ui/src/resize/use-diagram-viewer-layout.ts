import { useCallback, useMemo, useState } from "react";

import { useLayoutResetEffect } from "@/resize/layout-customizations";
import { clampAtLeast, clampWidthToContainer } from "@/resize/resize-persistence";
import {
	getResizePreferenceDefaultValue,
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { LocalStorageKey } from "@/storage/local-storage-store";

export const MIN_DIAGRAM_TREE_PANEL_WIDTH = 180;
export const MIN_DIAGRAM_CONTENT_PANEL_WIDTH = 340;
export const DIAGRAM_VIEWER_SEPARATOR_COUNT = 1;

const TREE_PANEL_WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DiagramTreePanelWidth,
	defaultValue: 250,
	normalize: (value) => clampAtLeast(value, MIN_DIAGRAM_TREE_PANEL_WIDTH, true),
};

export function clampDiagramTreePanelWidth(width: number, containerWidth: number): number {
	return clampWidthToContainer({
		width,
		minWidth: MIN_DIAGRAM_TREE_PANEL_WIDTH,
		containerWidth,
		reservedWidth: MIN_DIAGRAM_CONTENT_PANEL_WIDTH + DIAGRAM_VIEWER_SEPARATOR_COUNT,
	});
}

export function useDiagramViewerLayout({ containerWidth }: { containerWidth: number | null }): {
	treePanelWidth: number;
	displayTreePanelWidth: number;
	setTreePanelWidth: (width: number) => void;
} {
	const [treePanelWidth, setTreePanelWidthState] = useState(() => loadResizePreference(TREE_PANEL_WIDTH_PREFERENCE));

	const setTreePanelWidth = useCallback((width: number) => {
		setTreePanelWidthState(persistResizePreference(TREE_PANEL_WIDTH_PREFERENCE, width));
	}, []);

	useLayoutResetEffect(() => {
		setTreePanelWidthState(getResizePreferenceDefaultValue(TREE_PANEL_WIDTH_PREFERENCE));
	});

	const displayTreePanelWidth = useMemo(() => {
		if (containerWidth === null || !Number.isFinite(containerWidth)) {
			return treePanelWidth;
		}
		return clampDiagramTreePanelWidth(treePanelWidth, containerWidth);
	}, [containerWidth, treePanelWidth]);

	return {
		treePanelWidth,
		displayTreePanelWidth,
		setTreePanelWidth,
	};
}
