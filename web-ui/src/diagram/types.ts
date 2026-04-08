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

/** Pre-computed reflow animation script embedded in a diagram file. */
export interface ReflowScript {
	trigger: string;
	deltaH: number;
	deltaW?: number;
	translations: Array<{
		id: string;
		dx?: number;
		dy: number;
	}>;
	growths: Array<{
		id: string;
		dw?: number;
		dh: number;
	}>;
}

export type InteractiveCategory = "module" | "function" | "type" | "data" | "flow" | "call" | "concept" | "annotation";

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
