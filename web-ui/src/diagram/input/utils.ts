import type { Scene } from "../rendering/scene";
import type { ViewportHandle } from "../rendering/viewport";
import type { ClickTarget } from "../types";

/**
 * Truncate a file path to fit a character budget: always show filename,
 * and prepend the closest parent directory only if the combined result fits.
 */
export function truncatePath(path: string, maxLen: number): string {
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

/** Identify what the user clicked on: an overlay badge, an SVG scene element, or nothing. */
export function identifyClickTarget(
	screenPoint: { x: number; y: number },
	viewport: ViewportHandle | null,
	scene: Scene,
): ClickTarget {
	const domEl = document.elementFromPoint(screenPoint.x, screenPoint.y);
	if (!domEl) return { kind: "miss" };

	// Check overlay badges first (rendered on top, z-10)
	if (viewport) {
		const badge = viewport.identifyOverlay(domEl);
		if (badge) return { kind: "overlay", badge };
	}

	// Check SVG scene elements
	const elementId = scene.identifyElement(domEl);
	if (elementId) {
		const el = scene.getElement(elementId);
		return { kind: "svg", elementId, interactive: el?.interactive ?? null };
	}

	return { kind: "miss" };
}
