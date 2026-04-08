import { FileText } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useRef } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Spinner } from "@/components/ui/spinner";
import { InteractionLayer } from "@/diagram/interaction/interaction-layer";
import type { InteractiveElement } from "@/diagram/interaction/interactive-registry";
import { InteractiveElementRegistry } from "@/diagram/interaction/interactive-registry";
import type { Scene } from "@/diagram/rendering/scene";
import { useDiagram } from "@/diagram/use-diagram";
import { useReflowEngine } from "@/diagram/use-reflow-engine";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

/** Resolve a relative expand-src path against the current diagram's directory. */
function resolveExpandSrc(selectedPath: string, expandSrc: string): string {
	const dirIndex = selectedPath.lastIndexOf("/");
	if (dirIndex === -1) return expandSrc;
	return `${selectedPath.slice(0, dirIndex)}/${expandSrc}`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function DiagramScene({
	scene,
	workspaceId,
	workspacePath,
	selectedPath,
}: {
	scene: Scene;
	workspaceId: string | null;
	workspacePath: string | null;
	selectedPath: string;
}): ReactElement {
	const interactiveRegistry = useMemo(() => {
		const reg = new InteractiveElementRegistry();
		reg.buildFromScene(scene);
		return reg;
	}, [scene]);

	const reflow = useReflowEngine(scene);
	const expandingRef = useRef(new Set<string>());

	const handleNavigate = useCallback(
		(element: InteractiveElement, domEvent: PointerEvent) => {
			if (!workspaceId || !workspacePath) return;
			const trpc = getRuntimeTrpcClient(workspaceId);
			const { filePath, startLine } = element.navTarget;
			void trpc.diagrams.navigate
				.mutate({
					root: workspacePath,
					filePath,
					line: startLine,
					newTab: domEvent.ctrlKey || domEvent.metaKey,
				})
				.then((result) => {
					if (!result.ok && result.error) {
						showAppToast({ intent: "danger", message: result.error });
					}
				});
		},
		[workspaceId, workspacePath],
	);

	const handleExpand = useCallback(
		(elementId: string) => {
			if (!reflow || !workspaceId) return;

			// If already expanded, collapse (synchronous)
			if (reflow.isExpanded(elementId)) {
				const svg = scene.getSvgElement();
				const g = svg.querySelector(`[data-reflow-group="${elementId}"]`);
				if (g) {
					const collapsedG = g.querySelector(".collapsed-content") as SVGGElement | null;
					const expandedG = g.querySelector(".expanded-content") as SVGGElement | null;
					if (collapsedG) collapsedG.classList.remove("hidden");
					if (expandedG) {
						expandedG.classList.remove("visible");
						setTimeout(() => {
							expandedG.innerHTML = "";
						}, 400);
					}
				}
				reflow.toggleExpand(elementId);
				return;
			}

			// Prevent double-expand
			if (expandingRef.current.has(elementId)) return;
			expandingRef.current.add(elementId);

			// Read expand metadata from the DOM element
			const svg = scene.getSvgElement();
			const g = svg.querySelector(`[data-reflow-group="${elementId}"]`);
			if (!g) {
				expandingRef.current.delete(elementId);
				return;
			}
			const expandSrc = g.getAttribute("data-expand-src");
			const expandW = Number.parseFloat(g.getAttribute("data-expand-w") ?? "0");
			const expandH = Number.parseFloat(g.getAttribute("data-expand-h") ?? "0");
			if (!expandSrc || !expandW || !expandH) {
				expandingRef.current.delete(elementId);
				return;
			}

			// Fetch sub-diagram content
			const trpc = getRuntimeTrpcClient(workspaceId);
			const contentPath = resolveExpandSrc(selectedPath, expandSrc);

			void trpc.diagrams.getContent
				.query({ path: contentPath })
				.then((result) => {
					// Parse the sub-diagram SVG
					const doc = new DOMParser().parseFromString(result.content, "text/html");
					const innerSvg = doc.querySelector("svg");
					if (!innerSvg) return;

					const expandedG = g.querySelector(".expanded-content") as SVGGElement | null;
					const collapsedG = g.querySelector(".collapsed-content") as SVGGElement | null;
					if (!expandedG || !collapsedG) return;

					// Get collapsed bounds for positioning
					const element = scene.getElement(elementId);
					if (!element) return;
					const bounds = element.localBounds;

					// Create nested <svg> container
					const nested = document.createElementNS(SVG_NS, "svg");
					nested.setAttribute("x", String(bounds.x));
					nested.setAttribute("y", String(bounds.y));
					nested.setAttribute("width", String(expandW));
					nested.setAttribute("height", String(expandH));
					const innerViewBox = innerSvg.getAttribute("viewBox");
					if (innerViewBox) {
						nested.setAttribute("viewBox", innerViewBox);
					}
					// Move children from parsed SVG into nested element
					while (innerSvg.firstChild) {
						nested.appendChild(innerSvg.firstChild);
					}

					expandedG.innerHTML = "";
					expandedG.appendChild(nested);

					// Toggle visibility
					collapsedG.classList.add("hidden");
					expandedG.classList.add("visible");

					// Apply displacement script
					reflow.toggleExpand(elementId);
				})
				.catch((err) => {
					console.error(`[DiagramScene] Failed to load expand content for "${elementId}":`, err);
				})
				.finally(() => {
					expandingRef.current.delete(elementId);
				});
		},
		[scene, reflow, workspaceId, selectedPath],
	);

	return (
		<InteractionLayer
			scene={scene}
			interactiveRegistry={interactiveRegistry}
			onNavigate={handleNavigate}
			onExpand={handleExpand}
		/>
	);
}

export function DiagramContentArea({
	content,
	isLoading,
	error,
	selectedPath,
	workspaceId,
	workspacePath,
}: {
	content: string | null;
	isLoading: boolean;
	error: string | null;
	selectedPath: string | null;
	workspaceId: string | null;
	workspacePath: string | null;
}): ReactElement {
	const scene = useDiagram(content);

	if (!selectedPath) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-1 text-text-tertiary">
				<FileText size={40} />
				<span className="text-xs">Select a diagram from the tree</span>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-1">
				<Spinner size={24} />
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 bg-surface-1">
				<span className="text-sm text-status-red">{error}</span>
			</div>
		);
	}

	if (!scene) {
		return <div className="flex flex-1 bg-surface-1" />;
	}

	return (
		<div className="flex flex-1 min-w-0 min-h-0 bg-surface-1">
			<DiagramScene
				scene={scene}
				workspaceId={workspaceId}
				workspacePath={workspacePath}
				selectedPath={selectedPath}
			/>
		</div>
	);
}
