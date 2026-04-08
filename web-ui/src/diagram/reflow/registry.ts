import type { Scene, SceneElement } from "../rendering/scene";
import { isArrow, isReflowGroup } from "../rendering/scene";
import type { Rect } from "../types";

/** A node in the reflow containment tree. */
export interface ReflowGroupNode {
	id: string;
	parent: ReflowGroupNode | null;
	children: ReflowGroupNode[];
	originalBounds: Rect;
	currentBounds: Rect;
	hasVisualRect: boolean;
	expandable: boolean;
	displacement: { dx: number; dy: number };
}

/** A tracked arrow/connector between reflow groups. */
export interface ArrowNode {
	id: string;
	originalBounds: Rect;
	displacement: { dx: number; dy: number };
}

/** Registry of all reflow groups and arrows in a diagram. */
export class ReflowGroupRegistry {
	roots: ReflowGroupNode[] = [];
	groupsById = new Map<string, ReflowGroupNode>();
	arrows: ArrowNode[] = [];
	arrowsById = new Map<string, ArrowNode>();

	buildFromScene(scene: Scene): void {
		this.roots = [];
		this.groupsById.clear();
		this.arrows = [];
		this.arrowsById.clear();

		const allElements = scene.getAllElements();

		// First pass: create all group nodes
		for (const [id, element] of allElements) {
			if (isReflowGroup(element)) {
				const bounds = scene.getLocalBounds(id);
				const node: ReflowGroupNode = {
					id,
					parent: null,
					children: [],
					originalBounds: { ...bounds },
					currentBounds: { ...bounds },
					hasVisualRect: element.hasVisualRect,
					expandable: element.metadata.expandable === "true",
					displacement: { dx: 0, dy: 0 },
				};
				this.groupsById.set(id, node);
			} else if (isArrow(element)) {
				const bounds = scene.getLocalBounds(id);
				const arrow: ArrowNode = {
					id,
					originalBounds: { ...bounds },
					displacement: { dx: 0, dy: 0 },
				};
				this.arrows.push(arrow);
				this.arrowsById.set(id, arrow);
			}
		}

		// Second pass: build containment tree from SceneElement parentId relationships
		for (const [id, node] of this.groupsById) {
			const element = allElements.get(id);
			if (!element) continue;

			const parentGroupNode = this.findNearestGroupAncestor(element, allElements);
			if (parentGroupNode) {
				node.parent = parentGroupNode;
				parentGroupNode.children.push(node);
			} else {
				this.roots.push(node);
			}
		}
	}

	/** Walk up the SceneElement tree to find the nearest ancestor that is a reflow group. */
	private findNearestGroupAncestor(
		element: SceneElement,
		allElements: Map<string, SceneElement>,
	): ReflowGroupNode | null {
		let currentParentId = element.parentId;
		while (currentParentId) {
			const parentNode = this.groupsById.get(currentParentId);
			if (parentNode) return parentNode;
			const parentElement = allElements.get(currentParentId);
			currentParentId = parentElement?.parentId ?? null;
		}
		return null;
	}

	getSiblings(groupId: string): ReflowGroupNode[] {
		const node = this.groupsById.get(groupId);
		if (!node) return [];
		const siblings = node.parent ? node.parent.children : this.roots;
		return siblings.filter((s) => s.id !== groupId);
	}
}
