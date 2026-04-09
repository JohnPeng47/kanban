import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export type CodeVizConnectionState = "connected" | "workspace-not-registered" | "disconnected";

export interface CodeVizStatus {
	state: CodeVizConnectionState;
	error?: string;
}

const POLL_INTERVAL_MS = 30_000;

export function useCodeVizStatus(workspaceId: string | null): CodeVizStatus {
	const [status, setStatus] = useState<CodeVizStatus>({ state: "disconnected" });
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const check = useCallback(() => {
		if (!workspaceId) {
			setStatus({ state: "disconnected" });
			return;
		}
		const trpc = getRuntimeTrpcClient(workspaceId);
		void trpc.diagrams.checkExtension.query().then(
			(result) => {
				if (!result.available) {
					setStatus({ state: "disconnected" });
				} else if (!result.workspaceRegistered) {
					setStatus({ state: "workspace-not-registered", error: result.error });
				} else {
					setStatus({ state: "connected" });
				}
			},
			() => {
				setStatus({ state: "disconnected" });
			},
		);
	}, [workspaceId]);

	useEffect(() => {
		check();

		timerRef.current = setInterval(check, POLL_INTERVAL_MS);
		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, [check]);

	return status;
}
