import { FileText } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { PopupDiagramOverlay } from "@/components/diagram-panels/popup-diagram-overlay";
import { Spinner } from "@/components/ui/spinner";
import { SceneInput, type ViewportHandle } from "@/diagram/input/scene-input";
import type { Scene } from "@/diagram/rendering/scene";
import type { ViewportSceneEvent } from "@/diagram/rendering/viewport";
import type { InteractiveData, OverlayBadge, OverlayPosition, Point, Rect } from "@/diagram/types";
import { useDiagram } from "@/diagram/use-diagram";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

/** Resolve a relative path against the current diagram's directory. */
function resolveDiagramPath(selectedPath: string, relativePath: string): string {
	const dirIndex = selectedPath.lastIndexOf("/");
	if (dirIndex === -1) return relativePath;
	return `${selectedPath.slice(0, dirIndex)}/${relativePath}`;
}

interface PopupEntry {
	path: string;
	content: string;
	position: OverlayPosition;
	anchorBounds: Rect;
}

function DiagramScene({
	scene,
	workspaceId,
	workspacePath,
	selectedPath,
	onRequestJump,
}: {
	scene: Scene;
	workspaceId: string | null;
	workspacePath: string | null;
	selectedPath: string;
	onRequestJump?: (path: string, elementId: string | null) => void;
}): ReactElement {
	const viewportRef = useRef<ViewportHandle>(null);
	const [popupStack, setPopupStack] = useState<PopupEntry[]>([]);
	const [userBadges, setUserBadges] = useState<OverlayBadge[]>([]);
	const [contextMenu, setContextMenu] = useState<{ screenX: number; screenY: number; scenePoint: Point } | null>(null);
	const userBadgeCounter = useRef(0);

	// Clear popup stack when the diagram changes
	useEffect(() => {
		setPopupStack([]);
		setUserBadges([]);
		setContextMenu(null);
	}, [selectedPath]);

	const fireCodeJump = useCallback(
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

	const openPopup = useCallback(
		(interactive: InteractiveData) => {
			if (!workspaceId || !interactive.modal) return;

			const resolvedPath = resolveDiagramPath(selectedPath, interactive.modal.target.path);
			const trpc = getRuntimeTrpcClient(workspaceId);

			// Get anchor bounds for positioning
			const el = scene.getElement(interactive.modal.source.elementId);
			const anchorBounds = el
				? scene.getWorldBounds(interactive.modal.source.elementId)
				: { x: 0, y: 0, width: 0, height: 0 };

			void trpc.diagrams.getContent.query({ path: resolvedPath }).then(
				(result) => {
					setPopupStack((prev) => [
						...prev,
						{
							path: resolvedPath,
							content: result.content,
							position: interactive.modal!.target.position,
							anchorBounds,
						},
					]);
				},
				(err) => {
					console.error(`[DiagramScene] Failed to load modal content for "${resolvedPath}":`, err);
					showAppToast({ intent: "danger", message: `Failed to load diagram: ${resolvedPath}` });
				},
			);
		},
		[workspaceId, selectedPath, scene],
	);

	const executeJump = useCallback(
		(interactive: InteractiveData) => {
			if (!interactive.link) return;

			const resolvedPath = resolveDiagramPath(selectedPath, interactive.link.target.path);
			const targetElementId = interactive.link.target.elementId;

			// Same-diagram jump: smooth pan to target
			if (resolvedPath === selectedPath) {
				if (targetElementId) {
					const targetEl = scene.getElement(targetElementId);
					if (targetEl) {
						const bounds = scene.getWorldBounds(targetElementId);
						viewportRef.current?.centerOn(
							{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
							{ animate: true },
						);
					}
				}
				return;
			}

			// Cross-diagram jump: request path change from parent
			onRequestJump?.(resolvedPath, targetElementId);
		},
		[selectedPath, scene, onRequestJump],
	);

	const handleNavigate = useCallback(
		(interactive: InteractiveData, domEvent: PointerEvent) => {
			// Alt+click always goes to editor
			if (domEvent.altKey) {
				fireCodeJump(interactive, domEvent);
				return;
			}

			// Modal takes precedence
			if (interactive.modal) {
				openPopup(interactive);
				return;
			}

			// Then link/jump
			if (interactive.link) {
				executeJump(interactive);
				return;
			}

			// Fallthrough: code-jump
			fireCodeJump(interactive, domEvent);
		},
		[fireCodeJump, openPopup, executeJump],
	);

	// Build overlay badges for elements with modal or link connections
	const badges = useMemo((): OverlayBadge[] => {
		const result: OverlayBadge[] = [];
		for (const [id, el] of scene.getAllElements()) {
			if (el.interactive?.modal) {
				result.push({
					id: `badge-modal-${id}`,
					anchor: { space: "element", elementId: id, corner: "top-right" },
					text: "⬡",
					onClick: () => {
						openPopup(el.interactive!);
					},
					style: { background: "#A371F7", color: "#fff" },
				});
			}
			if (el.interactive?.link) {
				result.push({
					id: `badge-link-${id}`,
					anchor: { space: "element", elementId: id, corner: "top-right" },
					text: "→",
					onClick: () => {
						executeJump(el.interactive!);
					},
					style: { background: "#D4A72C", color: "#fff" },
				});
			}
		}
		return result;
	}, [scene, openPopup, executeJump]);

	const allBadges = useMemo(() => [...badges, ...userBadges], [badges, userBadges]);

	const handleContextMenu = useCallback((event: ViewportSceneEvent) => {
		setContextMenu({
			screenX: event.screenPoint.x,
			screenY: event.screenPoint.y,
			scenePoint: event.scenePoint,
		});
	}, []);

	const handleAddBadge = useCallback(() => {
		if (!contextMenu) return;
		const id = `user-badge-${userBadgeCounter.current++}`;
		const scenePoint = contextMenu.scenePoint;
		setUserBadges((prev) => [
			...prev,
			{
				id,
				anchor: { space: "scene" as const, x: scenePoint.x, y: scenePoint.y },
				text: "📌",
				onClick: () => {
					// Remove this badge on click
					setUserBadges((p) => p.filter((b) => b.id !== id));
				},
				style: { background: "#3FB950", color: "#fff" },
			},
		]);
		setContextMenu(null);
	}, [contextMenu]);

	// Close context menu on any click outside
	useEffect(() => {
		if (!contextMenu) return;
		const dismiss = () => setContextMenu(null);
		window.addEventListener("pointerdown", dismiss);
		return () => window.removeEventListener("pointerdown", dismiss);
	}, [contextMenu]);

	return (
		<>
			<SceneInput
				ref={viewportRef}
				scene={scene}
				onNavigate={handleNavigate}
				onContextMenu={handleContextMenu}
				badges={allBadges}
			/>
			{popupStack.map((entry, i) => (
				<PopupDiagramOverlay
					key={entry.path}
					content={entry.content}
					anchorBounds={entry.anchorBounds}
					position={entry.position}
					zIndex={50 + i * 2}
					onClose={() => setPopupStack((prev) => prev.slice(0, i))}
					onNavigate={handleNavigate}
				/>
			))}
			{contextMenu && (
				<div
					className="fixed z-[200] min-w-[140px] rounded-md border border-border-bright bg-surface-2 py-1 shadow-xl"
					style={{ left: contextMenu.screenX, top: contextMenu.screenY }}
					onPointerDown={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-surface-3 cursor-pointer"
						onClick={handleAddBadge}
					>
						<span>📌</span>
						<span>Add Badge</span>
					</button>
				</div>
			)}
		</>
	);
}

export interface DiagramContentAreaProps {
	content: string | null;
	isLoading: boolean;
	error: string | null;
	selectedPath: string | null;
	workspaceId: string | null;
	workspacePath: string | null;
	/** Called when a cross-diagram link is clicked. Parent should change selectedPath. */
	onRequestJump?: (path: string, elementId: string | null) => void;
	/** Pending jump target after a cross-diagram navigation. Consumed after Scene loads. */
	pendingJumpElementId?: string | null;
	/** Called after a pending jump is consumed. */
	onJumpConsumed?: () => void;
}

export function DiagramContentArea({
	content,
	isLoading,
	error,
	selectedPath,
	workspaceId,
	workspacePath,
	onRequestJump,
	pendingJumpElementId,
	onJumpConsumed,
}: DiagramContentAreaProps): ReactElement {
	const scene = useDiagram(content);

	// Consume pending jump after scene loads
	useEffect(() => {
		if (!scene || !pendingJumpElementId) return;
		const el = scene.getElement(pendingJumpElementId);
		if (el) {
			// We need a brief delay for the Viewport to mount
			const timer = setTimeout(() => {
				onJumpConsumed?.();
			}, 50);
			return () => clearTimeout(timer);
		}
		// Element not found — consume anyway to avoid stuck state
		onJumpConsumed?.();
	}, [scene, pendingJumpElementId, onJumpConsumed]);

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
				onRequestJump={onRequestJump}
			/>
		</div>
	);
}
