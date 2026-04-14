# Kanban Integration Layer

## Overview

This document covers how the diagram feature connects to the rest of the Kanban application: the TRPC API boundary, the Code Viz extension client, the app mount point, and supporting hooks.

## System Architecture

```
#comment: keep this diagram
#comment: should add link here to DiagramContentArea
┌─────────────────────────────────────────────────────────────────┐
│  Browser (web-ui)                                               │
│                                                                 │
│  App.tsx ──(?view=diagram)──→ DiagramViewer                     │
│                                   │                             │
│                        ┌──────────┼──────────┐                  │
│                        │          │          │                  │
│                   TreePanel  ContentArea  AgentPanel             │
│                        │          │          │                  │
│               useDiagramViewer  useDiagram  useDiagramAgentPanel│
│                   │                              │              │
│                   ▼                              ▼              │
│              TRPC Client                    ClineAgent          │
│                   │                                             │
└───────────────────┼─────────────────────────────────────────────┘
                    │ HTTP
┌───────────────────┼─────────────────────────────────────────────┐
│  Node.js Server   │                                             │
│                   ▼                                             │
│             TRPC Router (app-router.ts)                         │
│                   │                                             │
│             diagrams-api.ts                                     │
│              ├── listDiagrams ──→ fs.readdir({workspace}/diagrams/)
│              ├── getDiagramContent ──→ fs.readFile (HTML, 5MB max)
│              ├── navigateToDiagramSource ──→ CodeVizClient       │
│              └── checkExtensionStatus ──→ CodeVizClient          │
│                                              │                  │
└──────────────────────────────────────────────┼──────────────────┘
                                               │ HTTP :24680
┌──────────────────────────────────────────────┼──────────────────┐
│  Code Viz VSCode Extension (optional)        │                  │
│                                              ▼                  │
│              /api/health  ← checkHealth()                       │
│              /api/workspaces ← checkWorkspace(path)             │
│              /api/navigate ← navigate(root, file, line, newTab) │
└─────────────────────────────────────────────────────────────────┘
```

## TRPC API (diagrams router)

All procedures are workspace-scoped (require `workspaceId` in context).

### `diagrams.list` (Query)

Lists all HTML diagram files from `{workspace}/diagrams/`.

- **Input**: `RuntimeDiagramListRequest` (empty object)
- **Output**: `RuntimeDiagramListResponse`
  - `diagramsRoot: string` — absolute path to diagrams directory
  - `diagramsRootExists: boolean` — whether the directory exists
  - `tree: RuntimeDiagramNode[]` — recursive file/directory tree
- **Security**: Validates paths for `..` traversal and null bytes

### `diagrams.getContent` (Query)

Reads HTML content of a specific diagram file.

- **Input**: `RuntimeDiagramContentRequest` — `{ path: string }`
- **Output**: `RuntimeDiagramContentResponse` — `{ content: string }`
- **Limits**: 5MB file size maximum
- **Security**: Path validation (no traversal, no null bytes)

### `diagrams.navigate` (Mutation)

Opens a source file in the Code Viz VSCode extension.

- **Input**: `RuntimeDiagramNavigateRequest` — `{ root, filePath, line?, newTab? }`
- **Output**: `RuntimeDiagramNavigateResponse` — `{ ok: boolean, error?: string }`
- **Mechanism**: Delegates to `CodeVizClient.navigate()`

### `diagrams.checkExtension` (Query)

Checks Code Viz extension connectivity and workspace registration.

- **Output**: `RuntimeDiagramExtensionStatusResponse` — `{ extensionRunning, workspaceRegistered }`

## Code Viz Client

HTTP client for the Code Viz VSCode extension (`src/diagram/code-viz-client.ts`).

- **Port**: 24680 (configurable via `CODE_VIZ_PORT` env var)
- **Timeout**: 2.5s for all requests
- **Endpoints**:
  - `GET /api/health` — extension alive check
  - `GET /api/workspaces` — list registered workspaces, match by realpath
  - `POST /api/navigate` — open file at line in editor

All methods fail gracefully (return `false`/error states, never throw to caller).

## App Mount Point

The diagram viewer is conditionally rendered in `App.tsx`:

```
URL: ?view=diagram&path=<diagram-path>&at=<elementId>
  → isDiagramViewerOpen = true
  → initialPath = searchParams.get("path")
  → DiagramViewer rendered with workspaceId, initialPath, agentPanelInput
```

The viewer replaces the main kanban board view when active.

## Agent Panel Integration

`useDiagramAgentPanel` composes a side panel for AI-assisted diagram exploration:

- Receives `UseDiagramAgentPanelInput`: project ID, runtime config, task sessions, workspace git info
- Returns a React element (chat panel or terminal panel) or `null`
- The agent panel is a general-purpose Kanban agent panel reused in diagram context — not diagram-specific logic

## Type Contracts

Shared types between frontend and backend are defined in `src/core/api-contract.ts`:

```ts
RuntimeDiagramNode       // { name, path, type: "file"|"directory", children }
RuntimeDiagramListRequest/Response
RuntimeDiagramContentRequest/Response
RuntimeDiagramNavigateRequest/Response
RuntimeDiagramExtensionStatusResponse
```

The frontend `FileTreeNode` type mirrors `RuntimeDiagramNode` — both have the same shape (`name`, `path`, `type`, `children`).

## Status Polling

`useCodeVizStatus` polls every 30 seconds via `diagrams.checkExtension`:

```
State machine:
  extensionRunning && workspaceRegistered → "connected"
  extensionRunning && !workspaceRegistered → "workspace-not-registered"
  !extensionRunning → "disconnected"
```

Displayed by `CodeVizStatusIndicator` in the content area's top-right corner.

---

## Source References

```
src/trpc/app-router.ts
  L680-702  Diagram TRPC router: list, getContent, navigate, checkExtension procedures

src/trpc/diagrams-api.ts
  L75-103   listDiagrams: fs.readdir + tree building + path validation
  L105-130  getDiagramContent: fs.readFile + 5MB limit + path validation
  L132-137  navigateToDiagramSource: delegates to CodeVizClient
  L139-153  checkExtensionStatus: health + workspace check

src/diagram/code-viz-client.ts
  L45-54    checkHealth: GET /api/health with 2.5s timeout
  L66-82    checkWorkspace: GET /api/workspaces, realpath comparison
  L84-106   navigate: POST /api/navigate with root, filePath, line, newTab

src/core/api-contract.ts
  L1109-1158  RuntimeDiagram* type definitions

src/server/runtime-server.ts
  L239      diagramsApi instantiation in TRPC context

web-ui/src/App.tsx
  L92-99    URL param parsing: ?view=diagram, ?path=, ?at=
  L894-907  Conditional DiagramViewer render

web-ui/src/hooks/use-code-viz-status.ts
  L1-50     useCodeVizStatus: 30s polling, 3-state result

web-ui/src/hooks/use-diagram-agent-panel.tsx
  L1-178    useDiagramAgentPanel: compose agent chat/terminal panel

web-ui/src/resize/use-diagram-viewer-layout.ts
  Panel width constants (180/250/320/340/420px), clamp functions, localStorage persistence
```
