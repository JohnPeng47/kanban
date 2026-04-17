import { useEffect, useState } from "react";

import { extractAsciiSource } from "./diagram-data";
import type { Scene } from "./rendering/scene";
import { SvgScene } from "./rendering/svg-scene";

/** Parse HTML containing an SVG diagram and return a Scene.
 *  Creates/destroys the Scene when html changes. */
export function useDiagram(html: string | null): Scene | null {
	const [scene, setScene] = useState<Scene | null>(null);

	useEffect(() => {
		if (!html) {
			setScene(null);
			return;
		}

		const doc = new DOMParser().parseFromString(html, "text/html");
		const svg = doc.querySelector("svg");
		if (!svg) {
			console.error("[useDiagram] No <svg> element found in diagram HTML");
			setScene(null);
			return;
		}

		// Temporarily append to document.body so getBBox() works during construction
		document.body.appendChild(svg);
		let newScene: SvgScene;
		try {
			newScene = new SvgScene(svg);
		} catch (err) {
			console.error("[useDiagram] Failed to construct SvgScene:", err);
			if (svg.parentElement === document.body) {
				document.body.removeChild(svg);
			}
			setScene(null);
			return;
		} finally {
			// SvgScene doesn't move the SVG anymore (Viewport does), so clean up
			if (svg.parentElement === document.body) {
				document.body.removeChild(svg);
			}
		}

		// Log ASCII source detection
		const asciiSource = html ? extractAsciiSource(html) : null;
		if (asciiSource) {
			const lines = asciiSource.split("\n");
			console.log(`[useDiagram] ASCII source detected: ${lines.length} lines`);
			console.log(asciiSource.slice(0, 200) + (asciiSource.length > 200 ? "..." : ""));
		} else {
			console.log("[useDiagram] No embedded ASCII source found");
		}

		setScene(newScene);

		return () => {
			newScene.destroy();
		};
	}, [html]);

	return scene;
}
