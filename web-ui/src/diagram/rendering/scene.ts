import type { Point, Rect, Transform } from "../types";

/**
 * The universal primitive of the Scene.
 *
 * Every tagged element in the diagram is a SceneElement. The element's
 * roles (reflow group, interactive region, arrow, viewport root) are
 * determined by its metadata — specifically, the data-* attributes
 * from the source SVG.
 */
export interface SceneElement {
	/** Unique identifier.
	 *  - For reflow groups: the data-reflow-group value
	 *  - For interactive regions: the data-interactive value
	 *  - For arrows: "arrow-{index}"
	 *  - For the root: "root" */
	id: string;

	/** Parent element ID, or null for the root. */
	parentId: string | null;

	/** Child element IDs, in document order. */
	childIds: string[];

	/** Bounding box in local coordinates (before this element's transform).
	 *  Matches SVG getBBox() semantics. */
	localBounds: Rect;

	/** Transform applied to this element. */
	transform: Transform;

	/** All data-* attributes from the source element. */
	metadata: Record<string, string>;

	/** Whether this element has a visual rect that can be grown during reflow. */
	hasVisualRect: boolean;
}

/** The rendering abstraction between the diagram loader and the rest of the framework. */
export interface Scene {
	// ─── Element Tree ──────────────────────────────────────────

	getRoot(): SceneElement;
	getElement(id: string): SceneElement | null;
	getAllElements(): Map<string, SceneElement>;
	getChildren(id: string): SceneElement[];

	// ─── Bounds ────────────────────────────────────────────────

	getLocalBounds(id: string): Rect;
	getWorldBounds(id: string): Rect;

	// ─── Transforms ────────────────────────────────────────────

	setTransform(id: string, transform: Transform): void;
	getTransform(id: string): Transform;
	getWorldTransform(id: string): Transform;

	// ─── Mutations ─────────────────────────────────────────────

	growVisualBounds(id: string, deltaW: number, deltaH: number): void;

	// ─── Hit Testing ───────────────────────────────────────────

	hitTest(scenePoint: Point): string | null;
	hitTestRect(sceneRect: Rect, mode: "intersect" | "contain"): string[];

	// ─── Coordinate Conversion ─────────────────────────────────

	screenToScene(screenPoint: Point): Point;
	sceneToScreen(scenePoint: Point): Point;

	// ─── Rendering ─────────────────────────────────────────────

	/** Get the DOM element that renders the scene. D3-zoom attaches here. */
	getRenderElement(): HTMLElement;

	// ─── Lifecycle ─────────────────────────────────────────────

	destroy(): void;
}

// ─── Role helpers ──────────────────────────────────────────

export function isReflowGroup(el: SceneElement): boolean {
	return "reflow-group" in el.metadata;
}

export function isInteractiveRegion(el: SceneElement): boolean {
	return "interactive" in el.metadata;
}

export function isArrow(el: SceneElement): boolean {
	return "arrow" in el.metadata;
}

export function isExpandable(el: SceneElement): boolean {
	return el.metadata.expandable === "true";
}
