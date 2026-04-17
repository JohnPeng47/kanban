import { showAppToast } from "@/components/app-toaster";
import { mapSvgRectToAsciiText } from "../diagram-data";
import type { Scene } from "../rendering/scene";
import type { InteractiveData, Rect } from "../types";

/** Copy unique code refs from a set of interactive elements to the clipboard. */
export function copyCodeRefs(elements: InteractiveData[]): void {
	const refs = new Set<string>();
	for (const el of elements) {
		if (el.ref) refs.add(el.ref);
	}
	if (refs.size === 0) return;

	const text = Array.from(refs).join(" ");
	navigator.clipboard.writeText(text).then(
		() => {
			showAppToast({
				intent: "success",
				message: `Copied ${refs.size} ref(s)`,
				timeout: 3000,
			});
		},
		() => {
			showAppToast({
				intent: "warning",
				message: "Failed to copy paths to clipboard",
				timeout: 3000,
			});
		},
	);
}

/**
 * Copy the ASCII source text corresponding to an SVG rect selection.
 * Shows a warning toast if no ASCII source is embedded in the diagram.
 */
export function copyAsciiText(sceneRect: Rect, scene: Scene, asciiSource: string | null | undefined): void {
	if (!asciiSource) {
		showAppToast({
			intent: "warning",
			message: "No embedded ASCII source in this diagram",
			timeout: 3000,
		});
		return;
	}

	const asciiText = mapSvgRectToAsciiText(sceneRect, scene, asciiSource);
	if (!asciiText) return;

	const lineCount = asciiText.split("\n").length;
	navigator.clipboard.writeText(asciiText).then(
		() => {
			showAppToast({
				intent: "success",
				message: `Copied ${lineCount} line(s) of diagram source`,
				timeout: 3000,
			});
		},
		() => {
			showAppToast({
				intent: "warning",
				message: "Failed to copy diagram source to clipboard",
				timeout: 3000,
			});
		},
	);
}
