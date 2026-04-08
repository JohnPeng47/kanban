# Kanban Integration - Diagram Viewer

## Overview

How the diagram viewer plugs into kanban's existing architecture: routing, workspace scoping, state management, and layout composition.

---

## 1. Page Routing

Kanban does **not** use React Router. Pages are toggled via boolean state flags in `App.tsx`:

```tsx
// Existing pattern (App.tsx:90)
const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);

// New - add alongside the git history toggle
const [isDiagramViewerOpen, setIsDiagramViewerOpen] = useState(false);
```

The diagram viewer replaces the KanbanBoard in the same conditional block where GitHistoryView is rendered (App.tsx ~line 863):

```tsx
{isDiagramViewerOpen ? (
  <DiagramViewer workspaceId={currentProjectId} />
) : isGitHistoryOpen ? (
  <GitHistoryView ... />
) : (
  <KanbanBoard ... />
)}
```

**Mutual exclusivity**: Only one of `isDiagramViewerOpen` / `isGitHistoryOpen` should be true at a time. The toggle handler should close the other:

```tsx
const handleToggleDiagramViewer = useCallback(() => {
  setIsDiagramViewerOpen((prev) => {
    if (!prev) setIsGitHistoryOpen(false); // close git history when opening diagrams
    return !prev;
  });
}, []);
```

---

## 2. Top Bar Entry Point

Add a toggle button to `TopBar` (`web-ui/src/components/top-bar.tsx`) following the same pattern as the git history toggle in `GitSummaryBar`:

- New prop: `onToggleDiagramViewer?: () => void`, `isDiagramViewerOpen?: boolean`
- Renders a button with a diagram-related Lucide icon (e.g. `<Network size={14} />` or `<LayoutDashboard size={14} />`)
- Uses the same `variant={isDiagramViewerOpen ? "primary" : "default"}` pattern as the git history button
- Placed in the right action group of the TopBar, near the git history button

---

## 3. Workspace Scoping

All diagram endpoints use `workspaceProcedure` from `src/trpc/app-router.ts` (line 362), which enforces:
- `x-kanban-workspace-id` header is present
- Workspace ID resolves to a valid `RuntimeTrpcWorkspaceScope` (with `workspacePath`)

The runtime uses `workspaceScope.workspacePath` to locate the `diagrams/` directory on disk. This is consistent with how every workspace-scoped endpoint already works.

On the frontend, the TRPC client is already workspace-scoped via `getRuntimeTrpcClient(currentProjectId)` in `web-ui/src/runtime/trpc-client.ts`.

---

## 4. TRPC Router Placement

Add a new sub-router `diagrams` at the top level of `runtimeAppRouter` (alongside `runtime`, `workspace`, `projects`, `hooks`):

```ts
// src/trpc/app-router.ts
export const runtimeAppRouter = t.router({
  runtime: t.router({ ... }),
  workspace: t.router({ ... }),
  projects: t.router({ ... }),
  hooks: t.router({ ... }),
  diagrams: t.router({
    list: workspaceProcedure
      .input(runtimeDiagramListRequestSchema)
      .output(runtimeDiagramListResponseSchema)
      .query(...),
    getContent: workspaceProcedure
      .input(runtimeDiagramContentRequestSchema)
      .output(runtimeDiagramContentResponseSchema)
      .query(...),
    navigate: workspaceProcedure
      .input(runtimeDiagramNavigateRequestSchema)
      .output(runtimeDiagramNavigateResponseSchema)
      .mutation(...),
    checkExtension: workspaceProcedure
      .output(runtimeDiagramExtensionStatusResponseSchema)
      .query(...),
  }),
});
```

---

## 5. Runtime Context Extension

The `RuntimeTrpcContext` interface (app-router.ts:174) needs a new `diagramsApi` section.

The third method is `callExtensionProvider` — an RPC-style dispatch to the code-viz VSCode extension. For now this only supports VSCode/code-viz, but the method name and shape are chosen so that a future IntelliJ or other provider can slot in without changing the TRPC surface.

```ts
export interface RuntimeTrpcContext {
  // ... existing fields ...
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
}
```

This follows the exact pattern of `runtimeApi`, `workspaceApi`, `projectsApi`, and `hooksApi`.

---

## 6. Runtime Implementation

Create `src/runtime/diagrams-api.ts` to implement the `diagramsApi` methods. The extension communication layer lives in a separate module — see `extensions.md` for details on `src/diagram-providers/code-viz-client.ts`.

| Method | Implementation |
|---|---|
| `listDiagrams` | `fs.readdir` recursive on `{workspacePath}/diagrams/`, build tree, filter to `.html`, `.svg`, `.txt` |
| `getDiagramContent` | `fs.readFile` with path validation (reject `..` segments), detect content type from extension |
| `callExtensionProvider` | Delegates to `code-viz-client.ts` which POSTs to `http://localhost:24680/api/navigate` |
| `checkExtensionStatus` | Delegates to `code-viz-client.ts` which calls `GET /api/health` + `GET /api/workspaces` and checks if current workspace is registered |

**Path security**: Mirror code-viz's `security.ts` - reject `..`, null bytes, and paths outside the diagrams root. Use `path.resolve()` + boundary check.

---

## 7. State Management

Follow the **hook-driven orchestration** pattern used throughout the app, implemented as a **single hook**:

```
web-ui/src/hooks/use-diagram-viewer.ts
```

This single hook encapsulates all diagram viewer concerns:
- Fetching the diagram tree on mount via `trpc.diagrams.list.useQuery()`
- Tracking selected path and expanded folders
- Fetching content on selection via `trpc.diagrams.getContent.useQuery()`
- Extension status check via `trpc.diagrams.checkExtension.useQuery()`
- Exposing `callExtensionProvider()` mutation
- Layout resize state via `useDiagramViewerLayout()` (called internally)

The hook is called from `App.tsx` and its return value is passed as props to `<DiagramViewer />`. This mirrors patterns like `useGitActions()`, `useTaskSessions()`, etc. The consumer in `App.tsx` only sees the single `useDiagramViewer(workspaceId)` call.

---

## 8. Layout Integration

The diagram viewer occupies the **same slot** as the KanbanBoard / GitHistoryView in the home layout area. It uses a **horizontal split layout** (tree panel left, content area right) with a `ResizeHandle` from `web-ui/src/resize/resize-handle.tsx`.

Layout hook: `web-ui/src/resize/use-diagram-viewer-layout.ts` (follows the `useGitHistoryLayout` / `useCardDetailLayout` pattern). Persists the tree panel width ratio to localStorage via `local-storage-store.ts`. Called internally by `useDiagramViewer`.

---

## 9. Keyboard Shortcuts

Register a shortcut to toggle the diagram viewer in the existing `useKeyboardShortcuts` hook (wherever git history toggle is registered): `Cmd+Shift+D` / `Ctrl+Shift+D`.

---

## 10. Files to Create

| File | Purpose |
|---|---|
| `src/diagram-providers/code-viz-client.ts` | HTTP client for code-viz extension (health, workspaces, navigate) |
| `src/runtime/diagrams-api.ts` | Server-side implementation (fs reads, delegates to code-viz-client) |
| `web-ui/src/components/diagram-viewer.tsx` | Top-level page component |
| `web-ui/src/components/diagram-panels/diagram-tree-panel.tsx` | Left tree panel |
| `web-ui/src/components/diagram-panels/diagram-content-area.tsx` | Right content panel (placeholder renderer) |
| `web-ui/src/components/diagram-panels/diagram-viewer-fallback.tsx` | Full-area error/empty states |
| `web-ui/src/hooks/use-diagram-viewer.ts` | Single state orchestration hook |
| `web-ui/src/resize/use-diagram-viewer-layout.ts` | Resize/layout persistence |

## 11. Files to Modify

| File | Change |
|---|---|
| `src/core/api-contract.ts` | Add diagram schemas and types |
| `src/trpc/app-router.ts` | Add `diagrams` sub-router + `diagramsApi` to context interface |
| `web-ui/src/App.tsx` | Add `isDiagramViewerOpen` state, toggle handler, conditional render |
| `web-ui/src/components/top-bar.tsx` | Add diagram viewer toggle button |
| `web-ui/src/runtime/trpc-client.ts` | No changes needed (auto-discovers new routes) |
