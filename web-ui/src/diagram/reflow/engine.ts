import type { Scene } from "../rendering/scene";
import type { ReflowScript } from "../types";
import type { ArrowNode, ReflowGroupNode } from "./registry";
import { ReflowGroupRegistry } from "./registry";

/** Parse a reflow script from a <script type="application/reflow+json"> inside a <g>. */
function parseScriptFromElement(g: SVGGElement): ReflowScript | null {
	const scriptEl = g.querySelector('script[type="application/reflow+json"]');
	if (!scriptEl?.textContent) return null;
	try {
		return JSON.parse(scriptEl.textContent) as ReflowScript;
	} catch {
		return null;
	}
}

/** Parse the compact data-reflow-displace format. */
function parseCompactScript(g: SVGGElement): ReflowScript | null {
	const displaceAttr = g.getAttribute("data-reflow-displace");
	const dyAttr = g.getAttribute("data-reflow-dy");
	const triggerId = g.getAttribute("data-reflow-group");
	if (!displaceAttr || !dyAttr || !triggerId) return null;

	const dy = Number.parseFloat(dyAttr);
	if (!Number.isFinite(dy)) return null;

	const ids = displaceAttr
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		trigger: triggerId,
		deltaH: dy,
		translations: ids.map((id) => ({ id, dy })),
		growths: [],
	};
}

export class ReflowEngine {
	private scene: Scene | null = null;
	private registry = new ReflowGroupRegistry();
	private scripts = new Map<string, ReflowScript>();
	private expanded = new Set<string>();

	initialize(scene: Scene): void {
		this.scene = scene;
		this.registry.buildFromScene(scene);
		this.parseAllScripts();
	}

	destroy(): void {
		this.scene = null;
		this.scripts.clear();
		this.expanded.clear();
	}

	/** Parse reflow scripts from DOM elements for all expandable groups. */
	private parseAllScripts(): void {
		if (!this.scene) return;

		for (const [id, node] of this.registry.groupsById) {
			if (!node.expandable) continue;

			const element = this.scene.getElement(id);
			if (!element) continue;

			// Access the underlying SVG <g> via getRenderElement + querySelector
			const renderEl = this.scene.getRenderElement();
			const g = renderEl.querySelector<SVGGElement>(`[data-reflow-group="${id}"]`);
			if (!g) continue;

			// Try compact format first, then script block
			const script = parseCompactScript(g) ?? parseScriptFromElement(g);
			if (script) {
				this.scripts.set(id, script);
			}
		}
	}

	/** Toggle expand/collapse for a group. Returns whether the group is now expanded. */
	toggleExpand(groupId: string): boolean {
		if (this.expanded.has(groupId)) {
			this.collapse(groupId);
			return false;
		}
		this.expand(groupId);
		return true;
	}

	private expand(groupId: string): void {
		if (!this.scene || this.expanded.has(groupId)) return;
		this.expanded.add(groupId);

		const script = this.scripts.get(groupId);
		if (script) {
			this.applyScript(script, true);
		} else {
			console.warn(`[ReflowEngine] No pre-computed script for expandable group "${groupId}". Skipping reflow.`);
		}
	}

	private collapse(groupId: string): void {
		if (!this.scene || !this.expanded.has(groupId)) return;
		this.expanded.delete(groupId);

		const script = this.scripts.get(groupId);
		if (script) {
			this.applyScript(script, false);
		}
	}

	private applyScript(script: ReflowScript, expanding: boolean): void {
		if (!this.scene) return;
		const sign = expanding ? 1 : -1;

		for (const t of script.translations) {
			const dx = (t.dx ?? 0) * sign;
			const dy = t.dy * sign;

			// Accumulate displacement on group or arrow
			const groupNode = this.registry.groupsById.get(t.id);
			const arrowNode = this.registry.arrowsById.get(t.id);
			const target: ReflowGroupNode | ArrowNode | undefined = groupNode ?? arrowNode;

			if (target) {
				target.displacement.dx += dx;
				target.displacement.dy += dy;
				this.scene.setTransform(t.id, {
					tx: target.displacement.dx,
					ty: target.displacement.dy,
					scale: 1,
				});
			}
		}

		for (const g of script.growths) {
			const dw = (g.dw ?? 0) * sign;
			const dh = g.dh * sign;
			this.scene.growVisualBounds(g.id, dw, dh);
		}
	}

	isExpanded(groupId: string): boolean {
		return this.expanded.has(groupId);
	}

	getRegistry(): ReflowGroupRegistry {
		return this.registry;
	}
}
