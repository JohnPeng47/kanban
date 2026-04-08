import { useCallback, useMemo, useRef, useState } from "react";
import { ReflowGroupRegistry } from "./reflow/registry";
import type { Scene } from "./rendering/scene";
import type { ReflowScript } from "./types";

/** Parse a reflow script from a <script type="application/reflow+json"> inside a <g>. */
function parseScriptFromDom(g: SVGGElement): ReflowScript | null {
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

function parseAllScripts(scene: Scene, registry: ReflowGroupRegistry): Map<string, ReflowScript> {
	const scripts = new Map<string, ReflowScript>();
	const svgEl = scene.getSvgElement();

	for (const [id, node] of registry.groupsById) {
		if (!node.expandable) continue;
		const g = svgEl.querySelector<SVGGElement>(`[data-reflow-group="${id}"]`);
		if (!g) continue;
		const script = parseCompactScript(g) ?? parseScriptFromDom(g);
		if (script) {
			scripts.set(id, script);
		}
	}
	return scripts;
}

export interface UseReflowEngineResult {
	toggleExpand: (groupId: string) => boolean;
	isExpanded: (groupId: string) => boolean;
	registry: ReflowGroupRegistry;
}

/** Hook that manages reflow for a Scene. Script playback only, no constraint solver. */
export function useReflowEngine(scene: Scene | null): UseReflowEngineResult | null {
	const [, forceUpdate] = useState(0);
	const expandedRef = useRef(new Set<string>());

	const { registry, scripts } = useMemo(() => {
		if (!scene) return { registry: null, scripts: null };
		const reg = new ReflowGroupRegistry();
		reg.buildFromScene(scene);
		const scr = parseAllScripts(scene, reg);
		return { registry: reg, scripts: scr };
	}, [scene]);

	const toggleExpand = useCallback(
		(groupId: string): boolean => {
			if (!scene || !registry || !scripts) return false;

			const expanded = expandedRef.current;
			const isExpanding = !expanded.has(groupId);
			const script = scripts.get(groupId);

			if (!script) {
				console.warn(`[useReflowEngine] No pre-computed script for "${groupId}". Skipping reflow.`);
				return false;
			}

			if (isExpanding) {
				expanded.add(groupId);
			} else {
				expanded.delete(groupId);
			}

			// Apply script
			const sign = isExpanding ? 1 : -1;
			for (const t of script.translations) {
				const dx = (t.dx ?? 0) * sign;
				const dy = t.dy * sign;
				const groupNode = registry.groupsById.get(t.id);
				const arrowNode = registry.arrowsById.get(t.id);
				const target = groupNode ?? arrowNode;
				if (target) {
					target.displacement.dx += dx;
					target.displacement.dy += dy;
					scene.setTransform(t.id, {
						tx: target.displacement.dx,
						ty: target.displacement.dy,
						scale: 1,
					});
				}
			}
			for (const g of script.growths) {
				scene.growVisualBounds(g.id, (g.dw ?? 0) * sign, g.dh * sign);
			}

			forceUpdate((n) => n + 1);
			return isExpanding;
		},
		[scene, registry, scripts],
	);

	const isExpanded = useCallback((groupId: string): boolean => {
		return expandedRef.current.has(groupId);
	}, []);

	if (!scene || !registry) return null;

	return { toggleExpand, isExpanded, registry };
}
