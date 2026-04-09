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
export const MIN_DIAGRAM_AGENT_PANEL_WIDTH = 320;
export const DEFAULT_DIAGRAM_AGENT_PANEL_WIDTH = 420;
export const DIAGRAM_VIEWER_SEPARATOR_COUNT = 2;

const TREE_PANEL_WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DiagramTreePanelWidth,
	defaultValue: 250,
	normalize: (value) => clampAtLeast(value, MIN_DIAGRAM_TREE_PANEL_WIDTH, true),
};

const AGENT_PANEL_WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DiagramAgentPanelWidth,
	defaultValue: DEFAULT_DIAGRAM_AGENT_PANEL_WIDTH,
	normalize: (value) => clampAtLeast(value, MIN_DIAGRAM_AGENT_PANEL_WIDTH, true),
};

export function clampDiagramTreePanelWidth(width: number, containerWidth: number, agentPanelWidth: number): number {
	return clampWidthToContainer({
		width,
		minWidth: MIN_DIAGRAM_TREE_PANEL_WIDTH,
		containerWidth,
		reservedWidth: MIN_DIAGRAM_CONTENT_PANEL_WIDTH + agentPanelWidth + DIAGRAM_VIEWER_SEPARATOR_COUNT,
	});
}

export function clampDiagramAgentPanelWidth(width: number, containerWidth: number, treePanelWidth: number): number {
	return clampWidthToContainer({
		width,
		minWidth: MIN_DIAGRAM_AGENT_PANEL_WIDTH,
		containerWidth,
		reservedWidth: MIN_DIAGRAM_CONTENT_PANEL_WIDTH + treePanelWidth + DIAGRAM_VIEWER_SEPARATOR_COUNT,
	});
}

export function useDiagramViewerLayout({ containerWidth }: { containerWidth: number | null }): {
	treePanelWidth: number;
	displayTreePanelWidth: number;
	setTreePanelWidth: (width: number) => void;
	agentPanelWidth: number;
	displayAgentPanelWidth: number;
	setAgentPanelWidth: (width: number) => void;
} {
	const [treePanelWidth, setTreePanelWidthState] = useState(() => loadResizePreference(TREE_PANEL_WIDTH_PREFERENCE));
	const [agentPanelWidth, setAgentPanelWidthState] = useState(() =>
		loadResizePreference(AGENT_PANEL_WIDTH_PREFERENCE),
	);

	const setTreePanelWidth = useCallback((width: number) => {
		setTreePanelWidthState(persistResizePreference(TREE_PANEL_WIDTH_PREFERENCE, width));
	}, []);

	const setAgentPanelWidth = useCallback((width: number) => {
		setAgentPanelWidthState(persistResizePreference(AGENT_PANEL_WIDTH_PREFERENCE, width));
	}, []);

	useLayoutResetEffect(() => {
		setTreePanelWidthState(getResizePreferenceDefaultValue(TREE_PANEL_WIDTH_PREFERENCE));
		setAgentPanelWidthState(getResizePreferenceDefaultValue(AGENT_PANEL_WIDTH_PREFERENCE));
	});

	const displayTreePanelWidth = useMemo(() => {
		if (containerWidth === null || !Number.isFinite(containerWidth)) {
			return treePanelWidth;
		}
		return clampDiagramTreePanelWidth(treePanelWidth, containerWidth, agentPanelWidth);
	}, [containerWidth, treePanelWidth, agentPanelWidth]);

	const displayAgentPanelWidth = useMemo(() => {
		if (containerWidth === null || !Number.isFinite(containerWidth)) {
			return agentPanelWidth;
		}
		return clampDiagramAgentPanelWidth(agentPanelWidth, containerWidth, displayTreePanelWidth);
	}, [containerWidth, agentPanelWidth, displayTreePanelWidth]);

	return {
		treePanelWidth,
		displayTreePanelWidth,
		setTreePanelWidth,
		agentPanelWidth,
		displayAgentPanelWidth,
		setAgentPanelWidth,
	};
}
