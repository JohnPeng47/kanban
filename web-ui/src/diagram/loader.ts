import { InteractionLayer } from "./interaction/interaction-layer";
import { InteractiveElementRegistry } from "./interaction/interactive-registry";
import { ReflowEngine } from "./reflow/engine";
import type { Scene } from "./rendering/scene";
import { SvgScene } from "./rendering/svg-scene";

export interface LoadedDiagram {
	scene: Scene;
	interactiveRegistry: InteractiveElementRegistry;
	reflowEngine: ReflowEngine;
	interactionLayer: InteractionLayer;
}

/**
 * Parse an HTML string containing an SVG diagram and construct a fully
 * initialized diagram with Scene, registries, reflow engine, and interaction layer.
 *
 * Callers must call `destroyDiagram(diagram)` when the diagram is unloaded.
 */
export function loadDiagram(html: string): LoadedDiagram {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const svg = doc.querySelector("svg");
	if (!svg) {
		throw new Error("No <svg> element found in diagram HTML");
	}

	// Move SVG into the live document so getBBox() works during SvgScene construction
	document.body.appendChild(svg);
	let scene: Scene;
	try {
		scene = new SvgScene(svg);
	} finally {
		// SvgScene moves the SVG into its own container, but if construction
		// fails, clean up the temporarily-appended SVG
		if (svg.parentElement === document.body) {
			document.body.removeChild(svg);
		}
	}

	// Build registries from Scene
	const interactiveRegistry = new InteractiveElementRegistry();
	interactiveRegistry.buildFromScene(scene);

	// Initialize reflow engine (parses scripts from DOM)
	const reflowEngine = new ReflowEngine();
	reflowEngine.initialize(scene);

	// Initialize interaction layer (attaches event listeners)
	const interactionLayer = new InteractionLayer();
	interactionLayer.initialize(scene, interactiveRegistry);

	return { scene, interactiveRegistry, reflowEngine, interactionLayer };
}

/** Tear down all components of a loaded diagram. */
export function destroyDiagram(diagram: LoadedDiagram): void {
	diagram.interactionLayer.destroy();
	diagram.reflowEngine.destroy();
	diagram.scene.destroy();
}
