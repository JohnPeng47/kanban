# Data Structures - Diagram Viewer

## Overview

New data structures to support listing, selecting, and displaying repository diagrams within a workspace-scoped page.

---

## 1. Diagram Tree Node

Represents a single entry in the diagram file tree (folder or diagram file). Reuses the same shape as the existing `FileTreeNode` in `web-ui/src/utils/file-tree.ts` but with diagram-specific metadata.

```ts
// src/core/api-contract.ts (new schemas)

const runtimeDiagramNodeSchema = z.object({
  /** Display name (e.g. "scheduler-detail", "base.html") */
  name: z.string(),
  /** Relative path from the diagrams root (e.g. "layout3/scheduler-detail/base.html") */
  path: z.string(),
  /** Whether this is a renderable diagram or a grouping folder */
  type: z.enum(["file", "directory"]),
  /** Child nodes (populated for directories) */
  children: z.lazy(() => z.array(runtimeDiagramNodeSchema)),
});
type RuntimeDiagramNode = z.infer<typeof runtimeDiagramNodeSchema>;
```

### Why a dedicated type instead of reusing `FileTreeNode`?

The existing `FileTreeNode` is built client-side from a flat path list via `buildFileTree()`. For diagrams, the tree is built **server-side** (the runtime reads the diagrams directory from disk) and ret rned pre-built. Keeping a separate schema lets us add diagram-specific metadata later (e.g. `hasHtml`, `hasTxt`, thumbnail preview) without polluting the generic file tree.

#comment: wait what do you mean its built "client-side"? 
Btw, I might not have addressed this, but the diagrams/ folder where all the diagrams for this workspace are kept will be created in a worktree -> this is "client-side" no?
Not sure if this changes things for you ...
So basically, reassess honestly whether we want to use FileTreeNode or not

---

## 2. Diagram Listing Request / Response

Used by the tree panel to fetch the available diagram structure for a workspace.

```ts
// Request - workspace scope is implicit (workspaceProcedure), so minimal input
const runtimeDiagramListRequestSchema = z.object({
  /** Optional subfolder filter (e.g. "layout3/scheduler-detail") to fetch a subtree */
  root: z.string().optional(),
});
type RuntimeDiagramListRequest = z.infer<typeof runtimeDiagramListRequestSchema>;

// Response
const runtimeDiagramListResponseSchema = z.object({
  /** Absolute path to the diagrams root on disk */
  diagramsRoot: z.string(),
  /** Top-level tree nodes */
  tree: z.array(runtimeDiagramNodeSchema),
});
type RuntimeDiagramListResponse = z.infer<typeof runtimeDiagramListResponseSchema>;
```

---

## 3. Diagram Content Request / Response

Fetches the content of a single diagram for rendering. Supports both HTML/SVG diagrams and raw ASCII source files.

#comment: We actually only want to support HTML files
-> the format of the diagram file is rather unstable (depends on the diagram rendering component), so maybe be careful when designing around this but can assume its *only* HTML file for now 

```ts
const runtimeDiagramContentRequestSchema = z.object({
  /** Relative path from diagrams root */
  path: z.string(),
});
type RuntimeDiagramContentRequest = z.infer<typeof runtimeDiagramContentRequestSchema>;

const runtimeDiagramContentResponseSchema = z.object({
  /** The relative path requested */
  path: z.string(),
  /** Detected content type */
  contentType: z.enum(["html", "svg", "txt", "unknown"]), #comment: again, look at above, and we are *not* gonna be supprot random ass unkniown ttypes lol wtf
  /** Raw file content as a string */
  content: z.string(),
});
type RuntimeDiagramContentResponse = z.infer<typeof runtimeDiagramContentResponseSchema>;
```

---

## 4. Navigate-to-Source Request / Response

Proxies the code-viz `POST /api/navigate` call through kanban's TRPC layer so the diagram viewer can trigger "open file in editor" without the browser making direct localhost fetch calls.

```ts
const runtimeDiagramNavigateRequestSchema = z.object({
  /** Absolute workspace root that owns the source file */
  root: z.string(),
  /** Relative file path within the repo */
  filePath: z.string(),
  /** Optional line number (1-indexed) */
  line: z.number().int().positive().optional(),
  /** Open in a new editor tab */
  newTab: z.boolean().optional(),
});
type RuntimeDiagramNavigateRequest = z.infer<typeof runtimeDiagramNavigateRequestSchema>;

const runtimeDiagramNavigateResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
type RuntimeDiagramNavigateResponse = z.infer<typeof runtimeDiagramNavigateResponseSchema>;
```

---

## 5. UI State (client-side only, not persisted via API)

Managed in a custom hook (`useDiagramViewer`) inside the web-ui:

```ts
interface DiagramViewerState {
  /** The full tree returned by the listing endpoint */
  tree: RuntimeDiagramNode[];
  /** Currently selected diagram path (relative) */
  selectedPath: string | null;
  /** Loaded diagram content for the selected path */
  content: RuntimeDiagramContentResponse | null;
  /** Set of expanded folder paths in the tree panel */
  expandedFolders: Set<string>;
  /** Loading / error status */
  isTreeLoading: boolean;
  isContentLoading: boolean;
  error: string | null;
}
```

This state is local to the diagram viewer page and does not need to persist across sessions (though `expandedFolders` could optionally be saved to localStorage later using the existing `local-storage-store.ts` pattern).

---

## 6. Relationship to Existing Types

| Existing type | Relationship |
|---|---|
| `FileTreeNode` (`web-ui/src/utils/file-tree.ts`) | Same conceptual shape. We reuse the tree-building logic for client-side sorting but the data comes pre-structured from the server. |
| `RuntimeWorkspaceFileChange` | Not reused - diagrams are static assets, not git diff entries. |
| `RuntimeTrpcWorkspaceScope` | All diagram endpoints are workspace-scoped (use `workspaceProcedure`). The workspace path tells the runtime where to find `diagrams/`. |
| `RuntimeOpenFileRequest` | Similar to `DiagramNavigateRequest` but navigate goes through code-viz HTTP API rather than VSCode's built-in file opener. | #comment -> what the hell is this?