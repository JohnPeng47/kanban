import type { Scene } from "./rendering/scene";
import { SvgScene } from "./rendering/svg-scene";

export interface LoadedDiagram {
	scene: Scene;
}

/**
 * Parse an HTML string containing an SVG diagram and construct a Scene.
 *
 * The returned LoadedDiagram owns the Scene. Callers must call
 * scene.destroy() when the diagram is unloaded.
 *
 * Registries and engine are not created here — they are built in later phases
 * (reflow, interaction) and will be added to LoadedDiagram as the framework grows.
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

	return { scene };
}
