# useDiagramViewer

## Overview

`useDiagramViewer` is the core state management hook for the diagram viewer. It owns the file tree, diagram selection, content loading, cross-diagram navigation ("jumps"), and URL synchronization. All data flows through this hook — the UI components are stateless consumers of its return value.

## Data Flow

```
useDiagramViewer(workspaceId, initialPath?)
  │
  ├── Effect: fetch tree ──→ TRPC diagrams.list ──→ tree, workspacePath
  │
  ├── Effect: fetch content ──→ TRPC diagrams.getContent ──→ content
  │     (triggered by selectedPath change)
  │
  ├── Effect: sync URL ──→ history.replaceState (view=diagram&path=...)
  │
  ├── onSelectPath(path) ──→ setSelectedPath
  │
  ├── onToggleFolder(path) ──→ toggle in expandedFolders set
  │
  ├── requestJump(path, elementId) ──→ setSelectedPath + setPendingJumpElementId
  │     + history.pushState (for browser back)
  │
  └── consumeJump() ──→ clear pendingJumpElementId
```

## State

| State | Type | Description |
|-------|------|-------------|
| `tree` | `FileTreeNode[]` | Recursive file/directory tree from `{workspace}/diagrams/` |
| `diagramsRootExists` | `boolean` | Whether the diagrams directory exists at all |
| `isTreeLoading` | `boolean` | Tree fetch in progress |
| `selectedPath` | `string \| null` | Currently selected diagram file path |
| `expandedFolders` | `Set<string>` | Folder paths that are expanded in the tree panel |
| `content` | `string \| null` | HTML content of the selected diagram |
| `isContentLoading` | `boolean` | Content fetch in progress |
| `contentError` | `string \| null` | Error message from failed content fetch |
| `workspacePath` | `string \| null` | Workspace root (diagrams dir minus `/diagrams`) |
| `pendingJumpElementId` | `string \| null` | Element to center on after scene loads |

## Tree Loading

On mount (or workspace change), fetches the diagram file tree via `diagrams.list`:

1. Calls TRPC `diagrams.list` with the workspace ID
2. Sets `tree`, `diagramsRootExists`
3. Derives `workspacePath` by stripping `/diagrams` suffix from the root
4. Auto-expands top-level directories
5. If `initialPath` was provided, ancestor folders are pre-expanded

## Content Loading

When `selectedPath` changes, fetches HTML content via `diagrams.getContent`:

1. Clears previous content and error
2. Calls TRPC `diagrams.getContent` with the path
3. Sets `content` on success, `contentError` on failure
4. Both effects use cancellation flags to handle race conditions

## URL Synchronization

Two URL sync strategies:

- **Normal selection** (`onSelectPath`): Uses `history.replaceState` — updates `?view=diagram&path=...` without creating a history entry
- **Jump navigation** (`requestJump`): Uses `history.pushState` — creates a history entry so browser back works. Also sets `?at=elementId` when jumping to a specific element

## Cross-Diagram Jump Protocol

The jump mechanism enables navigation between diagrams (e.g. clicking a link element):

```
1. DiagramScene.executeJump(interactive)
     calls onRequestJump(resolvedPath, targetElementId)
2. useDiagramViewer.requestJump(path, elementId)
     sets selectedPath → triggers content fetch
     sets pendingJumpElementId
     pushes browser history entry
3. Content loads → useDiagram creates Scene
4. DiagramContentArea detects pendingJumpElementId + scene ready
     calls onJumpConsumed() after 50ms delay (Viewport mount time)
5. useDiagramViewer.consumeJump()
     clears pendingJumpElementId
```

The 50ms delay in step 4 allows the Viewport to mount and become available for `centerOn()`.

---

## Source References

```
web-ui/src/hooks/use-diagram-viewer.ts
  L6-24     UseDiagramViewerResult interface
  L27-34    getAncestorFolders helper
  L37-47    syncUrlState helper (replaceState)
  L49-224   useDiagramViewer hook
  L50-65      State declarations
  L68-116     Tree fetch effect (diagrams.list)
  L86-92        workspacePath derivation
  L94-104       Auto-expand top-level directories
  L119-148    Content fetch effect (diagrams.getContent)
  L151-153    URL sync effect (replaceState)
  L155-157    onSelectPath callback
  L159-172    requestJump callback (pushState + pendingJumpElementId)
  L174-176    consumeJump callback
  L178-188    onToggleFolder callback
  L190-224    Memoized return value

web-ui/src/utils/file-tree.ts
  L1-6      FileTreeNode interface (name, path, type, children)
```
