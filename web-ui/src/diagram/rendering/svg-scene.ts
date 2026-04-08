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
	private svg: SVGSVGElement;
	private elements = new Map<string, SceneElement>();
	private domElements = new Map<string, SVGGElement>();
	private visualRects = new Map<string, SVGRectElement>();
	private worldBoundsCache = new Map<string, Rect>();
	private rootId = "root";

	constructor(svg: SVGSVGElement) {
		this.svg = svg;

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

		// Inject framework interaction styles
		this.injectInteractionStyles(svg);

		this.buildElementTree();
	}

	private injectInteractionStyles(svg: SVGSVGElement): void {
		const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
		style.textContent = `
			[data-interactive] { cursor: pointer; transition: filter 0.15s ease; }
			[data-interactive]:hover { filter: brightness(1.5) drop-shadow(0 0 6px currentColor); }
			[data-expandable] .collapsed-content { cursor: pointer; }
			[data-expandable] .collapsed-content:hover > rect:first-child {
				filter: brightness(1.3) drop-shadow(0 0 8px rgba(210, 153, 34, 0.4));
			}
			.selected > rect:first-of-type {
				stroke: #4C9AFF;
				stroke-width: 2;
				filter: drop-shadow(0 0 4px rgba(76, 154, 255, 0.4));
			}
		`;
		svg.insertBefore(style, svg.firstChild);
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

			let parentId = this.rootId;
			let ancestor: Element | null = g.parentElement;
			while (ancestor && ancestor !== (this.svg as Element)) {
				if (ancestor instanceof SVGGElement && domToId.has(ancestor)) {
					parentId = domToId.get(ancestor)!;
					break;
				}
				ancestor = ancestor.parentElement;
			}

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

			const parent = this.elements.get(parentId);
			if (parent) {
				parent.childIds.push(id);
			}
		}

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

		const parentTransform = this.getAncestorTransform(id);
		const bounds = transformRect(element.localBounds, parentTransform);
		this.worldBoundsCache.set(id, bounds);
		return bounds;
	}

	private getAncestorTransform(id: string): Transform {
		const chain: Transform[] = [];
		let current = this.elements.get(id);
		while (current && current.parentId !== null) {
			const parent = this.elements.get(current.parentId);
			if (parent && parent.id !== this.rootId) {
				chain.push(parent.transform);
			}
			current = parent ?? undefined;
		}
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

		// Only apply CSS for non-root elements (reflow displacements).
		// Root transform CSS is managed by the Viewport component.
		if (id !== this.rootId) {
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

	hitTest(screenPoint: Point): string | null {
		const domElement = document.elementFromPoint(screenPoint.x, screenPoint.y);
		if (!domElement || !this.svg.contains(domElement)) return null;

		const closest = (domElement as Element).closest?.(SCENE_ELEMENT_SELECTOR);
		if (!closest || !(closest instanceof SVGGElement)) return null;

		for (const [id, g] of this.domElements) {
			if (g === closest) return id;
		}
		return null;
	}

	hitTestRect(sceneRect: Rect, mode: "intersect" | "contain"): string[] {
		const matches: string[] = [];

		for (const [id, element] of this.elements) {
			if (!("interactive" in element.metadata)) continue;
			const worldBounds = this.getWorldBounds(id);
			if (mode === "contain") {
				if (rectContains(sceneRect, worldBounds)) {
					matches.push(id);
				}
			} else if (rectsIntersect(sceneRect, worldBounds)) {
				matches.push(id);
			}
		}
		return matches;
	}

	// ─── Rendering ─────────────────────────────────────────────

	getSvgElement(): SVGSVGElement {
		return this.svg;
	}

	// ─── Lifecycle ─────────────────────────────────────────────

	destroy(): void {
		this.elements.clear();
		this.domElements.clear();
		this.visualRects.clear();
		this.worldBoundsCache.clear();
	}
}
