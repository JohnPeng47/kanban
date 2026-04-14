# DiagramViewer Layout

## Overview

`DiagramViewer` is the top-level component that composes the three-panel diagram viewing UI: a file tree on the left, the diagram content area in the center, and an optional agent panel on the right. It wires together `useDiagramViewer`, layout state, resize handles, and the Code Viz status indicator.

## Panel Layout

```
#comment: keep this diagram
┌──────────┬─┬──────────────────────────────┬─┬────────────────┐
│          │R│                              │R│                │
│  Tree    │e│   DiagramContentArea         │e│  Agent Panel   │
│  Panel   │s│                              │s│  (optional)    │
│          │i│   ┌────────────────────────┐  │i│                │
│ 250px    │z│   │  SceneInput/Viewport   │  │z│  420px default │
│ default  │e│   │  + popup overlays      │  │e│                │
│          │ │   └────────────────────────┘  │ │                │
│          │ │                    [CodeViz]  │ │                │
└──────────┴─┴──────────────────────────────┴─┴────────────────┘
```

## Panel Sizing

Panel widths are managed by `useDiagramViewerLayout` and persisted to localStorage:

| Panel | Min | Default | Max |
|-------|-----|---------|-----|
| Tree | 180px | 250px | (dynamic, leaves room for content + agent) |
| Content | 340px | flex-1 (remaining space) | — |
| Agent | 320px | 420px | (dynamic, leaves room for content + tree) |

The clamp functions (`clampDiagramTreePanelWidth`, `clampDiagramAgentPanelWidth`) enforce that resizing one panel cannot squeeze the content area below its minimum or overlap with the sibling panel.

## Resize Interaction

Each `ResizeHandle` fires `onMouseDown` → `useResizeDrag` tracks pointer movement → clamp function enforces constraints → setter updates stored width.

The tree separator drag adds delta to tree width. The agent separator drag subtracts delta (dragging left grows the agent panel).

## Component Wiring

```
DiagramViewer
├── useDiagramViewer(workspaceId, initialPath)
│     → tree, selectedPath, content, requestJump, pendingJumpElementId, ...
├── useCodeVizStatus(workspaceId)
│     → state: "connected" | "disconnected" | "workspace-not-registered"
├── useDiagramAgentPanel(agentPanelInput)
│     → ReactElement | null (agent chat or terminal panel)
├── useDiagramViewerLayout({ containerWidth })
│     → displayTreePanelWidth, displayAgentPanelWidth, setters
│
├── DiagramTreePanel ← tree, selectedPath, expandedFolders, callbacks
├── ResizeHandle ← handleTreeSeparatorMouseDown
├── DiagramContentArea ← content, selectedPath, workspaceId, jump props
│   └── CodeVizStatusIndicator (absolute top-right, z-10)
├── ResizeHandle ← handleAgentSeparatorMouseDown (if agent panel exists)
└── Agent Panel div (if agentPanel !== null)
```

## Fallback State

If the diagrams directory doesn't exist (`!diagramsRootExists` after tree loads), renders `DiagramViewerFallback` with a "no-diagrams-dir" message instead of the three-panel layout.

## App Mount Point

The diagram viewer is activated by URL parameters:
- `?view=diagram` opens the viewer
- `?path=<diagram-path>` sets the initial diagram
- `?at=<elementId>` (set by jump navigation) targets a specific element

Rendered conditionally in `App.tsx` when `isDiagramViewerOpen` is true.

---

## Source References

```
web-ui/src/components/diagram-viewer.tsx
  L1-17     Imports: panel components, hooks, resize utilities
  L19-27    DiagramViewer props (workspaceId, initialPath, agentPanelInput)
  L28-35    Hook calls: useDiagramViewer, useCodeVizStatus, useDiagramAgentPanel, layout
  L37-47    Container width tracking (ref + resize listener)
  L49-75    handleTreeSeparatorMouseDown: drag → clamp → setTreePanelWidth
  L77-104   handleAgentSeparatorMouseDown: drag → clamp → setAgentPanelWidth
  L106-108  Fallback check: diagramsRootExists
  L110-156  JSX: flex container > tree panel > resize > content area > resize > agent panel

web-ui/src/resize/use-diagram-viewer-layout.ts
  Panel width constants, clamp functions, localStorage persistence

web-ui/src/components/diagram-panels/diagram-tree-panel.tsx
  Recursive tree rendering with expand/collapse, file selection

web-ui/src/components/diagram-panels/diagram-viewer-fallback.tsx
  "No diagrams directory" placeholder UI

web-ui/src/components/diagram-panels/code-viz-status-indicator.tsx
  Radix popover showing Code Viz extension connection state
```
