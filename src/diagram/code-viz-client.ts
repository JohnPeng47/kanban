const DEFAULT_CODE_VIZ_PORT = 24680;

function getCodeVizPort(): number {
	const envPort = process.env.CODE_VIZ_PORT?.trim();
	if (!envPort) return DEFAULT_CODE_VIZ_PORT;
	const parsed = Number.parseInt(envPort, 10);
	return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : DEFAULT_CODE_VIZ_PORT;
}

function getCodeVizBaseUrl(): string {
	return `http://localhost:${getCodeVizPort()}`;
}

interface CodeVizHealthResponse {
	status: "ok";
	pid: number;
	isRouter: boolean;
	port: number;
}

interface CodeVizNavigateRequest {
	root: string;
	filePath: string;
	line?: number;
	newTab?: boolean;
}

interface CodeVizNavigateResult {
	ok: boolean;
	error?: string;
}

interface CodeVizWorkspaceEntry {
	root: string;
	port: number;
	isRouter: boolean;
}

interface CodeVizWorkspacesResponse {
	workspaces: CodeVizWorkspaceEntry[];
}

async function checkHealth(): Promise<CodeVizHealthResponse | null> {
	try {
		const response = await fetch(`${getCodeVizBaseUrl()}/api/health`, {
			signal: AbortSignal.timeout(2_500),
		});
		if (!response.ok) return null;
		return (await response.json()) as CodeVizHealthResponse;
	} catch {
		return null;
	}
}

async function checkWorkspace(workspacePath: string): Promise<boolean> {
	try {
		const response = await fetch(`${getCodeVizBaseUrl()}/api/workspaces`, {
			signal: AbortSignal.timeout(2_500),
		});
		if (!response.ok) return false;
		const data = (await response.json()) as CodeVizWorkspacesResponse;
		const normalizedTarget = workspacePath.replace(/\/+$/, "");
		return data.workspaces.some((ws) => ws.root.replace(/\/+$/, "") === normalizedTarget);
	} catch {
		return false;
	}
}

async function navigate(input: CodeVizNavigateRequest): Promise<CodeVizNavigateResult> {
	try {
		const response = await fetch(`${getCodeVizBaseUrl()}/api/navigate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(2_500),	
		});
		if (!response.ok) {
			return { ok: false, error: `Code Viz returned ${response.status}` };
		}
		return (await response.json()) as CodeVizNavigateResult;
	} catch (error) {
		if (error instanceof TypeError && /fetch/i.test(error.message)) {
			return { ok: false, error: "Code Viz extension is not running" };
		}
		if (error instanceof DOMException && error.name === "AbortError") {
			return { ok: false, error: "Navigation request timed out" };
		}
		return { ok: false, error: "Unexpected error communicating with Code Viz" };
	}
}

export const codeVizClient = {
	checkHealth,
	checkWorkspace,
	navigate,
} as const;
