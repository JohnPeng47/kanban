import type { Scene, SceneElement } from "../rendering/scene";
import { isInteractiveRegion } from "../rendering/scene";
import { type InteractiveCategory, type ParsedRef, parseRef } from "../types";

/** A single interactive element with parsed metadata. */
export interface InteractiveElement {
	id: string;
	ref: string;
	parsedRef: ParsedRef;
	category: InteractiveCategory;
	label: string;
	tooltip: string | null;
	navTarget: ParsedRef;
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

function parseCategory(value: string | undefined): InteractiveCategory {
	if (value && VALID_CATEGORIES.has(value as InteractiveCategory)) {
		return value as InteractiveCategory;
	}
	return "annotation";
}

/** Registry of all interactive elements in a diagram. */
export class InteractiveElementRegistry {
	elements = new Map<string, InteractiveElement>();

	buildFromScene(scene: Scene): void {
		this.elements.clear();

		for (const [id, sceneElement] of scene.getAllElements()) {
			if (!isInteractiveRegion(sceneElement)) continue;

			const element = this.parseInteractiveElement(id, sceneElement);
			if (element) {
				this.elements.set(id, element);
			}
		}
	}

	get(id: string): InteractiveElement | null {
		return this.elements.get(id) ?? null;
	}

	private parseInteractiveElement(id: string, sceneElement: SceneElement): InteractiveElement | null {
		const ref = sceneElement.metadata.ref;
		if (!ref) return null;

		const parsedRef = parseRef(ref);
		const category = parseCategory(sceneElement.metadata.category);
		const label = sceneElement.metadata.label ?? id;
		const tooltip = sceneElement.metadata.tt ?? null;

		const navOverride = sceneElement.metadata.nav;
		const navTarget = navOverride ? parseRef(navOverride) : parsedRef;

		return {
			id,
			ref,
			parsedRef,
			category,
			label,
			tooltip,
			navTarget,
		};
	}
}
