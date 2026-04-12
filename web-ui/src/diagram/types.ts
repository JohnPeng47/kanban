/** Axis-aligned bounding box.
 *  In local coordinates when on SceneElement.localBounds.
 *  In scene coordinates when returned by getWorldBounds / hitTestRect. */
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A point in either screen or scene coordinates (context-dependent). */
export interface Point {
	x: number;
	y: number;
}

/** Transform: translate + uniform scale. */
export interface Transform {
	tx: number;
	ty: number;
	scale: number;
}

export const IDENTITY_TRANSFORM: Transform = { tx: 0, ty: 0, scale: 1 };

export type InteractiveCategory = "module" | "function" | "type" | "data" | "flow" | "call" | "concept" | "annotation";

export type OverlayPosition = "above-left" | "above-right" | "below-left" | "below-right" | "left" | "right" | "auto";

/** A modal connection: source element → overlay diagram. */
export interface DiagramModal {
	source: {
		elementId: string;
		ref: string | null;
	};
	target: {
		path: string;
		position: OverlayPosition;
	};
}

/** A link connection: source element → target element on another diagram. */
export interface DiagramLink {
	source: {
		elementId: string;
		ref: string | null;
	};
	target: {
		path: string;
		elementId: string | null;
	};
}

/** Parsed interactive metadata for a SceneElement. */
export interface InteractiveData {
	ref: string;
	parsedRef: ParsedRef;
	category: InteractiveCategory;
	label: string;
	tooltip: string | null;
	navTarget: ParsedRef;
	modal: DiagramModal | null;
	link: DiagramLink | null;
}

/** Reflow participation marker for a SceneElement. */
export interface ReflowState {
	originalBounds: Rect;
}

/** Parsed source code reference from data-ref. */
export interface ParsedRef {
	filePath: string;
	startLine: number;
	endLine: number | null;
}

/** Parse a data-ref string like "src/foo.ts:10-50" into structured form. */
export function parseRef(ref: string): ParsedRef {
	const colonIndex = ref.lastIndexOf(":");
	if (colonIndex === -1) {
		return { filePath: ref, startLine: 1, endLine: null };
	}
	const filePath = ref.slice(0, colonIndex);
	const lineSpec = ref.slice(colonIndex + 1);
	const dashIndex = lineSpec.indexOf("-");
	if (dashIndex === -1) {
		const line = Number.parseInt(lineSpec, 10);
		return { filePath, startLine: Number.isFinite(line) ? line : 1, endLine: null };
	}
	const startLine = Number.parseInt(lineSpec.slice(0, dashIndex), 10);
	const endLine = Number.parseInt(lineSpec.slice(dashIndex + 1), 10);
	return {
		filePath,
		startLine: Number.isFinite(startLine) ? startLine : 1,
		endLine: Number.isFinite(endLine) ? endLine : null,
	};
}

/** Parse a data-modal attribute into a DiagramModal. */
export function parseModal(elementId: string, ref: string | null, raw: string, position?: string): DiagramModal {
	return {
		source: { elementId, ref },
		target: {
			path: raw,
			position: (position as OverlayPosition) ?? "auto",
		},
	};
}

/** Parse a data-link attribute ("path" or "path#elementId") into a DiagramLink. */
export function parseLink(elementId: string, ref: string | null, raw: string): DiagramLink {
	const hashIndex = raw.indexOf("#");
	return {
		source: { elementId, ref },
		target:
			hashIndex === -1
				? { path: raw, elementId: null }
				: { path: raw.slice(0, hashIndex), elementId: raw.slice(hashIndex + 1) },
	};
}

const VALID_CATEGORIES = new Set<InteractiveCategory>([
	"module",
	"function",
	"type",
	"data",
	"flow",
	"call",
	"concept",
	"annotation",
]);

/** Parse a category string, defaulting to "annotation" if invalid. */
export function parseCategory(value: string | undefined): InteractiveCategory {
	if (value && VALID_CATEGORIES.has(value as InteractiveCategory)) {
		return value as InteractiveCategory;
	}
	return "annotation";
}

/** Parse interactive metadata from a SceneElement's raw metadata bag. */
export function parseInteractiveData(id: string, metadata: Record<string, string>): InteractiveData | null {
	const ref = metadata.ref;
	if (!ref) return null;

	const parsedRef = parseRef(ref);
	const category = parseCategory(metadata.category);
	const label = metadata.label ?? id;
	const tooltip = metadata.tt ?? null;
	const navOverride = metadata.nav;
	const navTarget = navOverride ? parseRef(navOverride) : parsedRef;

	const modalRaw = metadata.modal;
	const modal = modalRaw ? parseModal(id, ref, modalRaw, metadata["modal-position"]) : null;

	const linkRaw = metadata.link;
	const link = linkRaw ? parseLink(id, ref, linkRaw) : null;

	return { ref, parsedRef, category, label, tooltip, navTarget, modal, link };
}

// ─── Overlay badges ─────────────────────────────────────────

/** Anchor point for an overlay badge. */
export type BadgeAnchor =
	| { space: "screen"; x: number; y: number }
	| { space: "scene"; x: number; y: number }
	| {
			space: "element";
			elementId: string;
			corner: "center" | "top-right" | "top-left" | "bottom-right" | "bottom-left";
	  };

/** A clickable badge drawn on top of the diagram at a fixed pixel size. */
export interface OverlayBadge {
	id: string;
	anchor: BadgeAnchor;
	text: string;
	onClick: () => void;
	style?: {
		color?: string;
		background?: string;
		borderColor?: string;
	};
}

/** Test whether two rects intersect (AABB). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Test whether rect `inner` is fully contained within `outer`. */
export function rectContains(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
	);
}

/** Compose two transforms (apply `parent` then `child`). */
export function composeTransforms(parent: Transform, child: Transform): Transform {
	return {
		tx: parent.tx + child.tx * parent.scale,
		ty: parent.ty + child.ty * parent.scale,
		scale: parent.scale * child.scale,
	};
}

/** Apply a transform to a rect. */
export function transformRect(rect: Rect, transform: Transform): Rect {
	return {
		x: rect.x * transform.scale + transform.tx,
		y: rect.y * transform.scale + transform.ty,
		width: rect.width * transform.scale,
		height: rect.height * transform.scale,
	};
}
