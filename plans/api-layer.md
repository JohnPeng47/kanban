# API Layer - Diagram Viewer

## Overview

Defines the TRPC endpoints, their runtime implementations, and integration with the code-viz VSCode extension for source navigation.

---

## 1. API Contract Additions (`src/core/api-contract.ts`)

Add the following Zod schemas and inferred types at the end of the file, following the existing pattern:

```ts
// --- Diagram Viewer ---

export const runtimeDiagramNodeSchema: z.ZodType<RuntimeDiagramNode> = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory"]),
  children: z.lazy(() => z.array(runtimeDiagramNodeSchema)),
});
export type RuntimeDiagramNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children: RuntimeDiagramNode[];
};

export const runtimeDiagramListRequestSchema = z.object({
  root: z.string().optional(),
});
export type RuntimeDiagramListRequest = z.infer<typeof runtimeDiagramListRequestSchema>;

export const runtimeDiagramListResponseSchema = z.object({
  diagramsRoot: z.string(),
  diagramsRootExists: z.boolean(),
  tree: z.array(runtimeDiagramNodeSchema),
});
export type RuntimeDiagramListResponse = z.infer<typeof runtimeDiagramListResponseSchema>;

export const runtimeDiagramContentRequestSchema = z.object({
  path: z.string(),
});
export type RuntimeDiagramContentRequest = z.infer<typeof runtimeDiagramContentRequestSchema>;

export const runtimeDiagramContentResponseSchema = z.object({
  path: z.string(),
  contentType: z.enum(["html", "svg", "txt", "unknown"]),
  content: z.string(),
});
export type RuntimeDiagramContentResponse = z.infer<typeof runtimeDiagramContentResponseSchema>;

export const runtimeDiagramNavigateRequestSchema = z.object({
  root: z.string(),
  filePath: z.string(),
  line: z.number().int().positive().optional(),
  newTab: z.boolean().optional(),
});
export type RuntimeDiagramNavigateRequest = z.infer<typeof runtimeDiagramNavigateRequestSchema>;

export const runtimeDiagramNavigateResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type RuntimeDiagramNavigateResponse = z.infer<typeof runtimeDiagramNavigateResponseSchema>;

export const runtimeDiagramExtensionStatusResponseSchema = z.object({
  available: z.boolean(),
  workspaceRegistered: z.boolean(),
  error: z.string().optional(),
});
export type RuntimeDiagramExtensionStatusResponse = z.infer<
  typeof runtimeDiagramExtensionStatusResponseSchema
>;
```

---

## 2. TRPC Router (`src/trpc/app-router.ts`)

### 2.1 Import additions

Add the new schemas and types to the import blocks from `../core/api-contract`.

### 2.2 Context interface extension

Add `diagramsApi` to `RuntimeTrpcContext`:

```ts
diagramsApi: {
  listDiagrams: (
    scope: RuntimeTrpcWorkspaceScope,
    input: RuntimeDiagramListRequest,
  ) => Promise<RuntimeDiagramListResponse>;
  getDiagramContent: (
    scope: RuntimeTrpcWorkspaceScope,
    input: RuntimeDiagramContentRequest,
  ) => Promise<RuntimeDiagramContentResponse>;
  callExtensionProvider: (
    scope: RuntimeTrpcWorkspaceScope,
    input: RuntimeDiagramNavigateRequest,
  ) => Promise<RuntimeDiagramNavigateResponse>;
  checkExtensionStatus: (
    scope: RuntimeTrpcWorkspaceScope,
  ) => Promise<RuntimeDiagramExtensionStatusResponse>;
};
```

### 2.3 Router definition

Add a `diagrams` sub-router to `runtimeAppRouter`:

```ts
diagrams: t.router({
  list: workspaceProcedure
    .input(runtimeDiagramListRequestSchema)
    .output(runtimeDiagramListResponseSchema)
    .query(async ({ ctx, input }) => {
      return await ctx.diagramsApi.listDiagrams(ctx.workspaceScope, input);
    }),
  getContent: workspaceProcedure
    .input(runtimeDiagramContentRequestSchema)
    .output(runtimeDiagramContentResponseSchema)
    .query(async ({ ctx, input }) => {
      return await ctx.diagramsApi.getDiagramContent(ctx.workspaceScope, input);
    }),
  navigate: workspaceProcedure
    .input(runtimeDiagramNavigateRequestSchema)
    .output(runtimeDiagramNavigateResponseSchema)
    .mutation(async ({ ctx, input }) => {
      return await ctx.diagramsApi.callExtensionProvider(ctx.workspaceScope, input);
    }),
  checkExtension: workspaceProcedure
    .output(runtimeDiagramExtensionStatusResponseSchema)
    .query(async ({ ctx }) => {
      return await ctx.diagramsApi.checkExtensionStatus(ctx.workspaceScope);
    }),
}),
```

---

## 3. Runtime Implementation (`src/runtime/diagrams-api.ts`)

### 3.1 `listDiagrams`

```
Input:  { root?: string }
Output: { diagramsRoot: string, diagramsRootExists: boolean, tree: RuntimeDiagramNode[] }
```

**Logic**:
1. Resolve diagrams directory: `path.join(scope.workspacePath, "diagrams", input.root ?? "")`
2. Validate resolved path is within `{workspacePath}/diagrams/` (path traversal check)
3. Recursively read directory with `fs.readdir({ withFileTypes: true })`
4. Filter to relevant extensions: `.html`, `.svg`, `.txt`
5. Build `RuntimeDiagramNode[]` tree, sorted: directories first, then alphabetical
6. Return the tree, the absolute `diagramsRoot` path, and `diagramsRootExists: true`

**Error handling**:
- If `diagrams/` doesn't exist: return `{ diagramsRootExists: false, tree: [] }`. The UI layer renders a **full-area fallback state** (see ui-layer.md Section 3.5) — not a subtle message, but a prominent centered display replacing the entire viewer area.
- If `root` subfolder doesn't exist: throw `TRPCError` with `NOT_FOUND`

### 3.2 `getDiagramContent`

```
Input:  { path: string }
Output: { path: string, contentType: "html"|"svg"|"txt"|"unknown", content: string }
```

**Logic**:
1. Resolve full path: `path.join(scope.workspacePath, "diagrams", input.path)`
2. **Security check**: reject paths containing `..`, null bytes, or resolving outside diagrams root
3. Read file as UTF-8 string
4. Detect content type from extension: `.html` -> `"html"`, `.svg` -> `"svg"`, `.txt` -> `"txt"`, else `"unknown"`
5. Return content

**Error handling**:
- File not found: throw `TRPCError` with `NOT_FOUND`
- File too large (>5MB): throw `TRPCError` with `PAYLOAD_TOO_LARGE`

### 3.3 `callExtensionProvider` (navigate)

```
Input:  { root: string, filePath: string, line?: number, newTab?: boolean }
Output: { ok: boolean, error?: string }
```

**Logic**: Delegates to `code-viz-client.ts` (see `extensions.md` for details). The client POSTs to `http://localhost:{CODE_VIZ_PORT}/api/navigate`.

**Error handling** (all handled by code-viz-client, returned as `{ ok: false, error }`):
- Connection refused (code-viz not running): `{ ok: false, error: "Code Viz extension is not running" }`
- Timeout (2.5s): `{ ok: false, error: "Navigation request timed out" }`
- Non-JSON response: `{ ok: false, error: "Unexpected response from Code Viz" }`

### 3.4 `checkExtensionStatus`

```
Input:  (none, workspace scope is implicit)
Output: { available: boolean, workspaceRegistered: boolean, error?: string }
```

**Logic**: Delegates to `code-viz-client.ts`. See `extensions.md` Section 3 for the full check flow.

---

## 4. Code-Viz Integration Details

The code-viz VSCode extension (`/home/john/code-viz`) exposes:

| Endpoint | Method | Purpose |
|---|---|---|
| `GET /api/health` | Health check | Verify code-viz is running |
| `GET /api/workspaces` | List workspaces | Verify current workspace has an open VSCode window |
| `POST /api/navigate` | Navigate to file | Opens file in VSCode at specified line |
| `GET /diagrams/{path}` | Serve diagram | Static file serving (not needed - we read from disk directly) |

### Navigate flow

```
[Browser: Diagram SVG click]
  -> onClick handler calls trpc.diagrams.navigate.mutate({ root, filePath, line })
  -> [Kanban Runtime: diagrams-api.ts]
    -> callExtensionProvider delegates to code-viz-client.ts
      -> HTTP POST http://localhost:24680/api/navigate
        -> { root: "/home/john/kanban", filePath: "src/foo.ts", line: 42 }
      -> [Code-Viz Router]
        -> Looks up registry for window owning that workspace root
        -> Forwards to internal server
        -> VSCode opens file at line 42
  -> Response: { ok: true }
```

**Why proxy through TRPC instead of direct browser fetch?**
- The browser may be remote (e.g. kanban over SSH tunnel) while code-viz runs on the same machine as the kanban runtime
- Keeps all external API calls server-side behind the TRPC boundary
- Avoids CORS issues

### HTML diagram rewriting

When serving HTML diagram content via `getDiagramContent`, the runtime needs to **rewrite the `nav()` function** in the HTML so that click-to-navigate calls go through kanban's TRPC layer instead of directly to `localhost:24680`:

**Option A (recommended)**: The `DiagramContentArea` React component injects a patched `nav()` function into the iframe's `srcdoc` before rendering. This keeps the runtime simple (just serves raw content) and moves the integration logic to the UI layer.

```ts
// In DiagramContentArea, before setting srcdoc:
const patchedHtml = rawHtml.replace(
  /function nav\(.*?\{[\s\S]*?\}/,
  `function nav(filePath, line) {
    window.parent.postMessage({
      type: 'diagram-navigate',
      root: '${workspacePath}',
      filePath,
      line: line || undefined,
      newTab: event && (event.ctrlKey || event.metaKey),
    }, '*');
  }`
);
```

The parent window listens for `diagram-navigate` messages and calls `trpc.diagrams.navigate.mutate(...)`.

**Option B**: The runtime rewrites the HTML server-side before returning it. Simpler client code but mixes concerns.

---

## 5. Frontend TRPC Usage

In the `useDiagramViewer` hook:

```ts
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export function useDiagramViewer(workspaceId: string) {
  const trpc = getRuntimeTrpcClient(workspaceId);

  // Check extension availability on mount
  const extensionQuery = trpc.diagrams.checkExtension.useQuery();

  // Fetch tree on mount
  const treeQuery = trpc.diagrams.list.useQuery({ root: undefined });

  // Fetch content when path changes
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const contentQuery = trpc.diagrams.getContent.useQuery(
    { path: selectedPath! },
    { enabled: selectedPath !== null },
  );

  // Navigate mutation
  const navigateMutation = trpc.diagrams.navigate.useMutation();

  const navigateToSource = useCallback(
    (filePath: string, line?: number, newTab?: boolean) => {
      navigateMutation.mutate({ root: workspacePath, filePath, line, newTab });
    },
    [navigateMutation, workspacePath],
  );

  // ...state management for expandedFolders, layout, etc.
}
```

---

## 6. Error States & Full-Area Fallbacks

Kanban uses three tiers of error display. The diagram viewer follows the same patterns:

### Full-area fallback states (replace entire diagram viewer area)

These follow the visual pattern established by `RuntimeDisconnectedFallback` and `KanbanAccessBlockedFallback` — centered layout, 48px Lucide icon, title, subtitle. Scoped to the diagram viewer slot (TopBar remains visible).

| Scenario | Icon | Color | Title | Subtitle |
|---|---|---|---|---|
| No `diagrams/` directory | `FolderOpen` | `text-text-tertiary` | "No diagrams directory" | "Create a `diagrams/` folder in your workspace to get started." |
| Extension not available | `Unplug` | `text-status-orange` | "Code Viz extension is not running" | "Start the Code Viz extension in VSCode to enable diagram navigation." |
| Extension running but workspace not registered | `AlertCircle` | `text-status-orange` | "Workspace not open in VSCode" | "Open this workspace in VSCode with the Code Viz extension active." |

**Priority**: These are checked in order. "No diagrams" takes precedence (no point checking the extension if there's nothing to view). Extension status is secondary.

**Implementation**: A single `DiagramViewerFallback` component in `web-ui/src/components/diagram-panels/diagram-viewer-fallback.tsx` that takes a `reason` discriminant and renders the appropriate state. Pattern matches `KanbanAccessBlockedFallback` exactly.

### Inline / toast errors (within the working viewer)

| Scenario | Behavior |
|---|---|
| Navigate call fails (`{ ok: false }`) | Toast via `showAppToast({ intent: "danger", message })` |
| Diagram file deleted | Content area shows inline error: "File not found" with `text-status-red` |
| Large file (>5MB) | Content area shows inline warning |

Toast notifications use `sonner` via `showAppToast` from `@/components/app-toaster`, consistent with the rest of kanban.
