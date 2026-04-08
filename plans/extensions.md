# Extensions - Code-Viz Client & Extension Communication

## Overview

Defines how kanban's runtime communicates with the code-viz VSCode extension, including the workspace check logic. This is a separate module from the TRPC layer — it owns the HTTP contract between kanban and the external extension process.

---

## 1. Architecture Decision

Kanban already makes external HTTP calls in two patterns:
- **`fetch` + `AbortSignal.timeout()`** — silent failure, returns null (used in `src/update/update.ts` for npm registry)
- **`withTimeout` Promise.race wrapper** — throws on timeout with labeled error (used in `src/commands/hooks.ts`)

Neither has a shared "external provider client" abstraction. Code-viz communication is different enough (localhost HTTP to a well-known port, needs health + workspace checks) that it warrants its own module. But we adopt the same conventions:
- Use `AbortSignal.timeout(2_500)` for all code-viz calls (same 2.5s timeout as npm registry check in `update.ts:477`)
- Return structured `{ ok: false, error }` on failure instead of throwing (same silent-failure philosophy)
- Single focused file, not a framework

---

## 2. File: `src/diagram-providers/code-viz-client.ts`

### Configuration

```ts
const DEFAULT_CODE_VIZ_PORT = 24680;

function getCodeVizPort(): number {
  const envPort = process.env.CODE_VIZ_PORT?.trim();
  if (!envPort) return DEFAULT_CODE_VIZ_PORT;
  const parsed = Number.parseInt(envPort, 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : DEFAULT_CODE_VIZ_PORT;
}

function getCodeVizBaseUrl(): string {
  return `http://localhost:${getCodeVizPort()}`;
}
```

Port is configurable via `CODE_VIZ_PORT` env var, defaulting to `24680` (code-viz's well-known router port). Uses the same `parseRuntimePort`-style validation pattern from `src/core/runtime-endpoint.ts`.

### Health Check

```ts
interface CodeVizHealthResponse {
  status: "ok";
  pid: number;
  isRouter: boolean;
  port: number;
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
```

Returns `null` on any failure (connection refused, timeout, bad JSON). Follows the `fetchLatestVersionFromRegistry` pattern exactly.

### Workspace Check

```ts
interface CodeVizWorkspaceEntry {
  root: string;
  port: number;
  isRouter: boolean;
}

interface CodeVizWorkspacesResponse {
  workspaces: CodeVizWorkspaceEntry[];
}

async function checkWorkspace(workspacePath: string): Promise<boolean> {
  try {
    const response = await fetch(`${getCodeVizBaseUrl()}/api/workspaces`, {
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as CodeVizWorkspacesResponse;
    // Normalize paths for comparison (trailing slashes, case on macOS)
    const normalizedTarget = workspacePath.replace(/\/+$/, "");
    return data.workspaces.some(
      (ws) => ws.root.replace(/\/+$/, "") === normalizedTarget
    );
  } catch {
    return false;
  }
}
```

Calls `GET /api/workspaces` on the code-viz router. Returns `true` if the current kanban workspace path appears in the registered workspaces list. The path comparison normalizes trailing slashes.

### Navigate

```ts
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
```

Differentiates between connection refused (TypeError from fetch), timeout (AbortError from AbortSignal), and other errors.

### Exported API

```ts
export const codeVizClient = {
  checkHealth,
  checkWorkspace,
  navigate,
} as const;
```

Single named export. Consumed by `src/runtime/diagrams-api.ts`.

---

## 3. Extension Status Check Flow

The `checkExtensionStatus` method in `diagrams-api.ts` combines health + workspace checks:

```ts
async function checkExtensionStatus(
  scope: RuntimeTrpcWorkspaceScope,
): Promise<RuntimeDiagramExtensionStatusResponse> {
  // Step 1: Is code-viz running?
  const health = await codeVizClient.checkHealth();
  if (!health) {
    return { available: false, workspaceRegistered: false };
  }

  // Step 2: Is this workspace registered?
  const registered = await codeVizClient.checkWorkspace(scope.workspacePath);
  return {
    available: true,
    workspaceRegistered: registered,
    error: registered
      ? undefined
      : "This workspace is not open in a VSCode window with Code Viz active.",
  };
}
```

**Two-step check**:
1. `GET /api/health` — Is the code-viz router process alive?
2. `GET /api/workspaces` — Does the router know about this specific workspace path?

Both must pass for full functionality. If step 1 fails, skip step 2 (no point checking workspaces if the extension isn't running).

---

## 4. Frontend Integration

The `useDiagramViewer` hook calls `trpc.diagrams.checkExtension.useQuery()` on mount. The result drives the fallback UI:

```ts
// Inside useDiagramViewer
const extensionStatus = trpc.diagrams.checkExtension.useQuery(undefined, {
  // Re-check every 30 seconds in case user starts the extension
  refetchInterval: 30_000,
  // Don't block initial render
  refetchOnWindowFocus: true,
});

// Derive fallback reason
const fallbackReason = useMemo(() => {
  if (treeQuery.data && !treeQuery.data.diagramsRootExists) {
    return "no-diagrams-dir" as const;
  }
  // Extension status is informational, not blocking (see ui-layer.md note)
  return null;
}, [treeQuery.data]);

// Extension warning (shown as dismissible banner, not blocking)
const extensionWarning = useMemo(() => {
  if (!extensionStatus.data) return null;
  if (!extensionStatus.data.available) return "extension-unavailable" as const;
  if (!extensionStatus.data.workspaceRegistered) return "workspace-not-registered" as const;
  return null;
}, [extensionStatus.data]);
```

The extension check polls every 30 seconds so the banner auto-dismisses once the user starts the extension. `refetchOnWindowFocus: true` gives faster feedback when switching back from VSCode.

---

## 5. Error Handling Philosophy

Follows the kanban codebase conventions:

| Pattern | Source | Applied here |
|---|---|---|
| `AbortSignal.timeout(2_500)` | `update.ts:477` | All code-viz fetch calls |
| Silent null return on failure | `fetchLatestVersionFromRegistry` | `checkHealth`, `checkWorkspace` |
| Structured `{ ok, error }` return | Original code-viz API contract | `navigate` |
| No throwing from external calls | General kanban pattern | All methods catch and return |

Extension unavailability is never a hard error — it degrades gracefully. Users can still browse diagrams; they just can't click-to-navigate until the extension is running.

---

## 6. Files

| File | Purpose |
|---|---|
| `src/diagram-providers/code-viz-client.ts` | HTTP client for code-viz extension |

This is intentionally a single file, not a framework. If a second provider (e.g. IntelliJ) is needed later, the pattern would be:
1. Extract the `checkHealth` / `checkWorkspace` / `navigate` signatures into an interface in `src/diagram-providers/provider-interface.ts`
2. Create `src/diagram-providers/intellij-client.ts` implementing that interface
3. Add a resolver in `diagrams-api.ts` that picks the right client

But that abstraction is premature today with only one provider.
