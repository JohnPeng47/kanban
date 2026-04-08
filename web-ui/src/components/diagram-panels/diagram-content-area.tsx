import { FileText } from "lucide-react";
import { type ReactElement, useEffect, useRef } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Spinner } from "@/components/ui/spinner";
import { destroyDiagram, type LoadedDiagram, loadDiagram } from "@/diagram/loader";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

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
	const mountRef = useRef<HTMLDivElement | null>(null);
	const diagramRef = useRef<LoadedDiagram | null>(null);

	// Mount/unmount diagram when content changes
	useEffect(() => {
		const mountEl = mountRef.current;
		if (!mountEl || !content) {
			if (diagramRef.current) {
				destroyDiagram(diagramRef.current);
				diagramRef.current = null;
			}
			if (mountEl) {
				mountEl.innerHTML = "";
			}
			return;
		}

		// Tear down previous diagram
		if (diagramRef.current) {
			destroyDiagram(diagramRef.current);
			diagramRef.current = null;
			mountEl.innerHTML = "";
		}

		// Load new diagram
		try {
			const diagram = loadDiagram(content);
			diagramRef.current = diagram;

			// Register navigate extension call
			if (workspaceId && workspacePath) {
				const trpc = getRuntimeTrpcClient(workspaceId);
				diagram.interactionLayer.extensionCalls.register({
					name: "kanban-navigate",
					trigger: "click",
					categoryFilter: ["function", "type", "data", "flow", "call", "module"],
					handler: (event) => {
						if (!event.interactiveElement) return;
						const { filePath, startLine } = event.interactiveElement.navTarget;
						void trpc.diagrams.navigate
							.mutate({
								root: workspacePath,
								filePath,
								line: startLine,
								newTab: event.domEvent?.ctrlKey || event.domEvent?.metaKey,
							})
							.then((result) => {
								if (!result.ok && result.error) {
									showAppToast({ intent: "danger", message: result.error });
								}
							});
					},
				});
			}

			// Register expand extension call
			diagram.interactionLayer.extensionCalls.register({
				name: "kanban-expand",
				trigger: "expand",
				handler: (event) => {
					if (!event.elementId) return;
					diagram.reflowEngine.toggleExpand(event.elementId);
				},
			});

			const renderEl = diagram.scene.getRenderElement();
			renderEl.style.width = "100%";
			renderEl.style.height = "100%";
			mountEl.appendChild(renderEl);
		} catch (err) {
			console.error("[DiagramContentArea] Failed to load diagram:", err);
			mountEl.innerHTML = "";
			const iframe = document.createElement("iframe");
			iframe.srcdoc = content;
			iframe.sandbox.add("allow-scripts");
			iframe.title = "Diagram preview";
			iframe.style.cssText = "flex:1;border:none;width:100%;height:100%";
			mountEl.appendChild(iframe);
		}

		return () => {
			if (diagramRef.current) {
				destroyDiagram(diagramRef.current);
				diagramRef.current = null;
			}
			if (mountEl) {
				mountEl.innerHTML = "";
			}
		};
	}, [content, workspaceId, workspacePath]);

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

	if (!content) {
		return <div className="flex flex-1 bg-surface-1" />;
	}

	return <div ref={mountRef} className="flex flex-1 min-w-0 min-h-0 bg-surface-1" />;
}
