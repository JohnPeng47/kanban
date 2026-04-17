import type { SourceSpan } from "../diagram-data";
import type { InteractiveData, Rect, ReflowState, Transform } from "../types";

/**
 * The universal primitive of the Scene.
 *
 * Every tagged element in the diagram is a SceneElement. The element's
 * roles are determined by its parsed role fields — `interactive` and
 * `reflow` — which are derived from data-* attributes at construction time.
 */
export interface SceneElement {
	/** Unique identifier.
	 *  - For reflow groups: the data-reflow-group value
	 *  - For interactive regions: the data-interactive value
	 *  - For arrows: "arrow-{src}-{target}" (semantic) or "arrow-{index}" (legacy)
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

	/** Parsed interactive metadata (ref, category, label, modal, link).
	 *  Non-null when this element has data-interactive + data-ref. */
	interactive: InteractiveData | null;

	/** Reflow participation marker.
	 *  Non-null when this element has data-reflow-group or data-arrow. */
	reflow: ReflowState | null;

	/** Source span in the diagram's ASCII source text.
	 *  Non-null when this element has data-source-span. */
	sourceSpan: SourceSpan | null;
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

	/** Insert a new element into the Scene. Called after DOM insertion. */
	addElement(id: string, domNode: SVGGElement, parentId: string): SceneElement;

	/** Remove an element and all its descendants from the Scene. */
	removeElement(id: string): void;

	/** Parse a DOM subtree and add all tagged elements to the Scene. */
	addSubtree(rootDomNode: SVGElement, parentId: string): SceneElement[];

	// ─── Hit Testing ───────────────────────────────────────────

	/** Given a DOM element (from document.elementFromPoint), identify which
	 *  SceneElement it belongs to. Returns the element ID or null if the
	 *  element is not within this Scene's SVG. */
	identifyElement(domEl: Element): string | null;
	hitTestRect(sceneRect: Rect, mode: "intersect" | "contain"): string[];

	// ─── Rendering ─────────────────────────────────────────────

	/** Get the SVG element for mounting into the Viewport's DOM structure. */
	getSvgElement(): SVGSVGElement;

	// ─── Lifecycle ─────────────────────────────────────────────

	destroy(): void;
}

// ─── Role helpers ──────────────────────────────────────────

export function isReflowGroup(el: SceneElement): boolean {
	return el.reflow !== null;
}

export function isInteractiveRegion(el: SceneElement): boolean {
	return el.interactive !== null;
}

export function isArrow(el: SceneElement): boolean {
	return "arrow" in el.metadata;
}
