import {
	composeTransforms,
	IDENTITY_TRANSFORM,
	type Point,
	type Rect,
	rectContains,
	rectsIntersect,
	type Transform,
	transformRect,
} from "../types";
import type { Scene, SceneElement } from "./scene";

const SCENE_ELEMENT_SELECTOR = "[data-reflow-group], [data-interactive], [data-arrow]";

/** Resolve a unique ID for a tagged SVG <g> element. */
function resolveElementId(g: SVGGElement, arrowCounter: { value: number }): string | null {
	const reflowGroup = g.getAttribute("data-reflow-group");
	if (reflowGroup) return reflowGroup;
	const interactive = g.getAttribute("data-interactive");
	if (interactive) return interactive;
	if (g.hasAttribute("data-arrow")) {
		const id = `arrow-${arrowCounter.value}`;
		arrowCounter.value++;
		return id;
	}
	return null;
}

/** Read all data-* attributes into a plain object. */
function readMetadata(g: SVGGElement): Record<string, string> {
	const metadata: Record<string, string> = {};
	for (const attr of g.attributes) {
		if (attr.name.startsWith("data-")) {
			metadata[attr.name.slice(5)] = attr.value;
		}
	}
	return metadata;
}

/** Check if an SVG <g> element has a direct <rect> child (the visual border). */
function findVisualRect(g: SVGGElement): SVGRectElement | null {
	for (const child of g.children) {
		if (child.tagName === "rect") {
			return child as SVGRectElement;
		}
	}
	return null;
}

export class SvgScene implements Scene {
	private container: HTMLDivElement;
	private svg: SVGSVGElement;
	private transformDiv: HTMLDivElement;
	private elements = new Map<string, SceneElement>();
	private domElements = new Map<string, SVGGElement>();
	private visualRects = new Map<string, SVGRectElement>();
	private worldBoundsCache = new Map<string, Rect>();
	private rootId = "root";

	constructor(svg: SVGSVGElement) {
		this.svg = svg;

		// Create container structure: container > transformDiv > svg
		this.container = document.createElement("div");
		this.container.className = "scene-container";
		this.container.style.cssText = "width:100%;height:100%;overflow:hidden;position:relative";

		this.transformDiv = document.createElement("div");
		this.transformDiv.className = "scene-transform";
		this.transformDiv.style.cssText = "transform-origin:0 0;will-change:transform";

		// Remove viewBox, set explicit dimensions for 1:1 rendering
		const viewBox = svg.getAttribute("viewBox");
		if (viewBox) {
			const parts = viewBox.split(/[\s,]+/).map(Number);
			if (parts.length === 4 && parts.every(Number.isFinite)) {
				svg.removeAttribute("viewBox");
				svg.setAttribute("width", String(parts[2]));
				svg.setAttribute("height", String(parts[3]));
			}
		}
		svg.style.overflow = "visible";
		svg.style.display = "block";

		this.transformDiv.appendChild(svg);
		this.container.appendChild(this.transformDiv);

		// Build the SceneElement tree
		this.buildElementTree();
	}

	private buildElementTree(): void {
		const arrowCounter = { value: 0 };
		const taggedGs = this.svg.querySelectorAll<SVGGElement>(SCENE_ELEMENT_SELECTOR);

		// Create root element
		const rootElement: SceneElement = {
			id: this.rootId,
			parentId: null,
			childIds: [],
			localBounds: { x: 0, y: 0, width: 0, height: 0 },
			transform: { ...IDENTITY_TRANSFORM },
			metadata: {},
			hasVisualRect: false,
		};
		this.elements.set(this.rootId, rootElement);

		// Map DOM elements to IDs
		const domToId = new Map<SVGGElement, string>();
		for (const g of taggedGs) {
			const id = resolveElementId(g, arrowCounter);
			if (!id || this.elements.has(id)) continue;
			domToId.set(g, id);
			this.domElements.set(id, g);
		}

		// Build parent-child relationships by walking DOM ancestry
		for (const [g, id] of domToId) {
			const metadata = readMetadata(g);
			const visualRect = findVisualRect(g);
			if (visualRect) {
				this.visualRects.set(id, visualRect);
			}

			// Find nearest tagged ancestor to determine parent
			let parentId = this.rootId;
			let ancestor: Element | null = g.parentElement;
			while (ancestor && ancestor !== (this.svg as Element)) {
				if (ancestor instanceof SVGGElement && domToId.has(ancestor)) {
					parentId = domToId.get(ancestor)!;
					break;
				}
				ancestor = ancestor.parentElement;
			}

			// Read local bounds from getBBox (element must be in DOM)
			let localBounds: Rect;
			try {
				const bbox = g.getBBox();
				localBounds = { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
			} catch {
				localBounds = { x: 0, y: 0, width: 0, height: 0 };
			}

			const element: SceneElement = {
				id,
				parentId,
				childIds: [],
				localBounds,
				transform: { ...IDENTITY_TRANSFORM },
				metadata,
				hasVisualRect: visualRect !== null,
			};
			this.elements.set(id, element);

			// Register as child of parent
			const parent = this.elements.get(parentId);
			if (parent) {
				parent.childIds.push(id);
			}
		}

		// Compute root bounds from SVG dimensions
		const svgWidth = this.svg.width.baseVal.value || 0;
		const svgHeight = this.svg.height.baseVal.value || 0;
		rootElement.localBounds = { x: 0, y: 0, width: svgWidth, height: svgHeight };
	}

	// ─── Element Tree ──────────────────────────────────────────

	getRoot(): SceneElement {
		return this.elements.get(this.rootId)!;
	}

	getElement(id: string): SceneElement | null {
		return this.elements.get(id) ?? null;
	}

	getAllElements(): Map<string, SceneElement> {
		return this.elements;
	}

	getChildren(id: string): SceneElement[] {
		const element = this.elements.get(id);
		if (!element) return [];
		return element.childIds
			.map((childId) => this.elements.get(childId))
			.filter((el): el is SceneElement => el != null);
	}

	// ─── Bounds ────────────────────────────────────────────────

	getLocalBounds(id: string): Rect {
		const element = this.elements.get(id);
		if (!element) return { x: 0, y: 0, width: 0, height: 0 };
		return element.localBounds;
	}

	getWorldBounds(id: string): Rect {
		const cached = this.worldBoundsCache.get(id);
		if (cached) return cached;

		const element = this.elements.get(id);
		if (!element) return { x: 0, y: 0, width: 0, height: 0 };

		// Compose transforms from root's children down to this element's parent
		// Root transform is NOT included (world bounds are in scene space)
		const parentTransform = this.getAncestorTransform(id);
		const bounds = transformRect(element.localBounds, parentTransform);
		this.worldBoundsCache.set(id, bounds);
		return bounds;
	}

	/** Compose transforms from root's immediate children down to the element's parent. */
	private getAncestorTransform(id: string): Transform {
		const chain: Transform[] = [];
		let current = this.elements.get(id);
		// Walk up to root, collecting parent transforms (skip root's own transform)
		while (current && current.parentId !== null) {
			const parent = this.elements.get(current.parentId);
			if (parent && parent.id !== this.rootId) {
				chain.push(parent.transform);
			}
			current = parent ?? undefined;
		}
		// Compose from outermost to innermost
		chain.reverse();
		let composed: Transform = { ...IDENTITY_TRANSFORM };
		for (const t of chain) {
			composed = composeTransforms(composed, t);
		}
		return composed;
	}

	// ─── Transforms ────────────────────────────────────────────

	setTransform(id: string, transform: Transform): void {
		const element = this.elements.get(id);
		if (!element) return;

		element.transform = transform;
		this.invalidateWorldBoundsCache(id);

		if (id === this.rootId) {
			this.transformDiv.style.transform = `translate(${transform.tx}px,${transform.ty}px) scale(${transform.scale})`;
		} else {
			const g = this.domElements.get(id);
			if (g) {
				g.style.transform = `translate(${transform.tx}px,${transform.ty}px)`;
			}
		}
	}

	getTransform(id: string): Transform {
		const element = this.elements.get(id);
		if (!element) return { ...IDENTITY_TRANSFORM };
		return element.transform;
	}

	getWorldTransform(id: string): Transform {
		const element = this.elements.get(id);
		if (!element) return { ...IDENTITY_TRANSFORM };

		const chain: Transform[] = [];
		let current: SceneElement | null = element;
		while (current) {
			chain.push(current.transform);
			current = current.parentId ? (this.elements.get(current.parentId) ?? null) : null;
		}
		chain.reverse();
		let composed: Transform = { ...IDENTITY_TRANSFORM };
		for (const t of chain) {
			composed = composeTransforms(composed, t);
		}
		return composed;
	}

	private invalidateWorldBoundsCache(id: string): void {
		this.worldBoundsCache.delete(id);
		const element = this.elements.get(id);
		if (element) {
			for (const childId of element.childIds) {
				this.invalidateWorldBoundsCache(childId);
			}
		}
	}

	// ─── Mutations ─────────────────────────────────────────────

	growVisualBounds(id: string, deltaW: number, deltaH: number): void {
		const rect = this.visualRects.get(id);
		if (!rect) return;

		const currentW = rect.width.baseVal.value;
		const currentH = rect.height.baseVal.value;
		rect.setAttribute("width", String(currentW + deltaW));
		rect.setAttribute("height", String(currentH + deltaH));

		// Update localBounds
		const element = this.elements.get(id);
		if (element) {
			element.localBounds = {
				...element.localBounds,
				width: element.localBounds.width + deltaW,
				height: element.localBounds.height + deltaH,
			};
		}

		this.invalidateWorldBoundsCache(id);
	}

	// ─── Hit Testing ───────────────────────────────────────────

	hitTest(scenePoint: Point): string | null {
		const screenPoint = this.sceneToScreen(scenePoint);
		const domElement = document.elementFromPoint(screenPoint.x, screenPoint.y);
		if (!domElement || !this.container.contains(domElement)) return null;

		// Walk up from hit element to find nearest SceneElement
		const closest = (domElement as Element).closest?.(SCENE_ELEMENT_SELECTOR);
		if (!closest || !(closest instanceof SVGGElement)) return null;

		// Find the ID for this DOM element
		for (const [id, g] of this.domElements) {
			if (g === closest) return id;
		}
		return null;
	}

	hitTestRect(sceneRect: Rect, mode: "intersect" | "contain"): string[] {
		const matches: string[] = [];
		const testFn = mode === "intersect" ? rectsIntersect : rectContains;

		for (const [id, element] of this.elements) {
			if (!("interactive" in element.metadata)) continue;
			const worldBounds = this.getWorldBounds(id);
			if (mode === "contain") {
				if (rectContains(sceneRect, worldBounds)) {
					matches.push(id);
				}
			} else if (testFn(sceneRect, worldBounds)) {
				matches.push(id);
			}
		}
		return matches;
	}

	// ─── Coordinate Conversion ─────────────────────────────────

	screenToScene(screenPoint: Point): Point {
		const root = this.getRoot();
		const { tx, ty, scale } = root.transform;
		const containerRect = this.container.getBoundingClientRect();
		return {
			x: (screenPoint.x - containerRect.left - tx) / scale,
			y: (screenPoint.y - containerRect.top - ty) / scale,
		};
	}

	sceneToScreen(scenePoint: Point): Point {
		const root = this.getRoot();
		const { tx, ty, scale } = root.transform;
		const containerRect = this.container.getBoundingClientRect();
		return {
			x: scenePoint.x * scale + tx + containerRect.left,
			y: scenePoint.y * scale + ty + containerRect.top,
		};
	}

	// ─── Rendering ─────────────────────────────────────────────

	getRenderElement(): HTMLElement {
		return this.container;
	}

	// ─── Lifecycle ─────────────────────────────────────────────

	destroy(): void {
		this.elements.clear();
		this.domElements.clear();
		this.visualRects.clear();
		this.worldBoundsCache.clear();
		this.container.remove();
	}
}
