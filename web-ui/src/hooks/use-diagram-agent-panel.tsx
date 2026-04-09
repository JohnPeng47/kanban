// Composes the diagram-viewer agent surface for the current workspace.
// Mirrors useHomeSidebarAgentPanel but targets the right-hand panel of the
// diagram viewer rather than the left sidebar.
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { ClineAgentChatPanel } from "@/components/detail-panels/cline-agent-chat-panel";
import { Spinner } from "@/components/ui/spinner";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { useClineChatRuntimeActions } from "@/hooks/use-cline-chat-runtime-actions";
import { useHomeAgentSession } from "@/hooks/use-home-agent-session";
import { selectLatestTaskChatMessageForTask } from "@/runtime/native-agent";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeConfigResponse,
	RuntimeGitRepositoryInfo,
	RuntimeStateStreamTaskChatMessage,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { useTerminalThemeColors } from "@/terminal/theme-colors";

export interface UseDiagramAgentPanelInput {
	currentProjectId: string | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	clineSessionContextVersion: number;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null;
	taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>;
}

async function stopDiagramTaskSession(workspaceId: string, taskId: string): Promise<void> {
	try {
		await getRuntimeTrpcClient(workspaceId).runtime.stopTaskSession.mutate({
			taskId,
		});
	} catch {
		// Ignore stop errors during stale-session cleanup.
	}
}

export function useDiagramAgentPanel({
	currentProjectId,
	runtimeProjectConfig,
	clineSessionContextVersion,
	taskSessions,
	workspaceGit,
	latestTaskChatMessage,
	taskChatMessagesByTaskId,
}: UseDiagramAgentPanelInput): ReactElement | null {
	const terminalThemeColors = useTerminalThemeColors();
	const [sessionSummaries, setSessionSummaries] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const upsertSessionSummary = useCallback((summary: RuntimeTaskSessionSummary) => {
		setSessionSummaries((currentSessions) => {
			const previousSummary = currentSessions[summary.taskId] ?? null;
			const newestSummary = selectNewestTaskSessionSummary(previousSummary, summary);
			if (newestSummary !== summary) {
				return currentSessions;
			}
			return {
				...currentSessions,
				[summary.taskId]: newestSummary,
			};
		});
	}, []);
	const effectiveSessionSummaries = useMemo(() => {
		const mergedSessionSummaries = { ...taskSessions };
		for (const [taskId, summary] of Object.entries(sessionSummaries)) {
			const newestSummary = selectNewestTaskSessionSummary(mergedSessionSummaries[taskId] ?? null, summary);
			if (newestSummary) {
				mergedSessionSummaries[taskId] = newestSummary;
			}
		}
		return mergedSessionSummaries;
	}, [sessionSummaries, taskSessions]);
	const { panelMode, taskId } = useHomeAgentSession({
		currentProjectId,
		runtimeProjectConfig,
		workspaceGit,
		clineSessionContextVersion,
		sessionSummaries: effectiveSessionSummaries,
		setSessionSummaries,
		upsertSessionSummary,
	});
	const currentTaskIdRef = useRef<string | null>(null);

	useEffect(() => {
		currentTaskIdRef.current = taskId;
	}, [taskId]);
	const { sendTaskChatMessage, loadTaskChatMessages, cancelTaskChatTurn } = useClineChatRuntimeActions({
		currentProjectId,
		onSessionSummary: upsertSessionSummary,
	});

	const homeAgentPanelSummary = taskId ? (effectiveSessionSummaries[taskId] ?? null) : null;
	const homeTaskChatMessages = taskId ? (taskChatMessagesByTaskId[taskId] ?? []) : [];
	const latestHomeTaskChatMessage = selectLatestTaskChatMessageForTask(taskId, latestTaskChatMessage);

	const handleSendChatMessage = useCallback(
		async (messageTaskId: string, text: string, options?: { mode?: "act" | "plan" }) => {
			const result = await sendTaskChatMessage(messageTaskId, text, options);
			if (!result.ok) {
				return result;
			}
			if (currentProjectId) {
				if (currentTaskIdRef.current !== messageTaskId) {
					await stopDiagramTaskSession(currentProjectId, messageTaskId);
				}
			}
			return result;
		},
		[currentProjectId, sendTaskChatMessage],
	);

	const handleLoadChatMessages = useCallback(
		async (messageTaskId: string) => await loadTaskChatMessages(messageTaskId),
		[loadTaskChatMessages],
	);

	const handleCancelChatTurn = useCallback(
		async (messageTaskId: string) => await cancelTaskChatTurn(messageTaskId),
		[cancelTaskChatTurn],
	);

	if (!currentProjectId) {
		return null;
	}

	if (!runtimeProjectConfig) {
		return (
			<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 py-6">
				<Spinner size={20} />
			</div>
		);
	}

	if (panelMode === "chat" && taskId) {
		return (
			<ClineAgentChatPanel
				key={taskId}
				taskId={taskId}
				summary={homeAgentPanelSummary ?? createIdleTaskSession(taskId)}
				defaultMode="act"
				showComposerModeToggle={false}
				workspaceId={currentProjectId}
				runtimeConfig={runtimeProjectConfig}
				onSendMessage={handleSendChatMessage}
				onCancelTurn={handleCancelChatTurn}
				onLoadMessages={handleLoadChatMessages}
				incomingMessage={latestHomeTaskChatMessage}
				incomingMessages={homeTaskChatMessages}
				composerPlaceholder="Ask about the diagram or codebase"
			/>
		);
	}

	if (panelMode === "terminal" && taskId) {
		return (
			<AgentTerminalPanel
				key={taskId}
				taskId={taskId}
				workspaceId={currentProjectId}
				summary={homeAgentPanelSummary}
				onSummary={upsertSessionSummary}
				showSessionToolbar={false}
				autoFocus={false}
				panelBackgroundColor={terminalThemeColors.surfaceRaised}
				terminalBackgroundColor={terminalThemeColors.surfaceRaised}
				cursorColor={terminalThemeColors.textPrimary}
			/>
		);
	}

	return null;
}
