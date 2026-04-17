import { type RefObject, useCallback } from "react";
import type { Scene } from "../rendering/scene";
import type { ViewportHandle, ViewportSceneEvent } from "../rendering/viewport";
import type { InteractiveData, OverlayBadge } from "../types";
import type { UseSelectionResult } from "./use-selection";
import { identifyClickTarget } from "./utils";

/** Build a scene-click handler that resolves the hit target and dispatches
 *  to the appropriate callback (navigate, badge, or selection operation). */
export function useClickDispatch(
	scene: Scene,
	viewportRef: RefObject<ViewportHandle | null>,
	selection: Pick<UseSelectionResult, "selectOnly" | "toggleSelection" | "clearSelection">,
	hideTooltip: () => void,
	onNavigate?: (interactive: InteractiveData, domEvent: PointerEvent) => void,
	onBadgeClick?: (badge: OverlayBadge) => void,
): (event: ViewportSceneEvent) => void {
	return useCallback(
		(event: ViewportSceneEvent) => {
			hideTooltip();

			const target = identifyClickTarget(event.screenPoint, viewportRef.current, scene);

			switch (target.kind) {
				case "overlay": {
					if (target.badge.interactive && onNavigate) {
						onNavigate(target.badge.interactive, event.domEvent);
					} else {
						onBadgeClick?.(target.badge);
					}
					return;
				}

				case "svg": {
					const { elementId: hitId, interactive } = target;

					if (interactive) {
						if (event.domEvent.shiftKey) {
							selection.toggleSelection(hitId);
						} else {
							selection.selectOnly(hitId);
						}
						onNavigate?.(interactive, event.domEvent);
					} else {
						selection.clearSelection();
					}
					return;
				}

				case "miss": {
					selection.clearSelection();
					return;
				}
			}
		},
		[scene, viewportRef, selection, hideTooltip, onNavigate, onBadgeClick],
	);
}
