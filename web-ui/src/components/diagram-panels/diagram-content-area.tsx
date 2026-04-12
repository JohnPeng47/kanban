import { FileText } from "lucide-react";
import { type ReactElement, useCallback } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Spinner } from "@/components/ui/spinner";
import { SceneInput } from "@/diagram/input/scene-input";
import type { Scene } from "@/diagram/rendering/scene";
import type { InteractiveData } from "@/diagram/types";
import { useDiagram } from "@/diagram/use-diagram";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

function DiagramScene({
	scene,
	workspaceId,
	workspacePath,
}: {
	scene: Scene;
	workspaceId: string | null;
	workspacePath: string | null;
}): ReactElement {
	const handleNavigate = useCallback(
		(interactive: InteractiveData, domEvent: PointerEvent) => {
			if (!workspaceId || !workspacePath) return;
			const trpc = getRuntimeTrpcClient(workspaceId);
			const { filePath, startLine } = interactive.navTarget;
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

	return <SceneInput scene={scene} onNavigate={handleNavigate} />;
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
			<DiagramScene scene={scene} workspaceId={workspaceId} workspacePath={workspacePath} />
		</div>
	);
}
