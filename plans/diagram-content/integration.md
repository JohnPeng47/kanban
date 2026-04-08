# Integration with Kanban

## Overview

How the diagram visualization framework integrates into the kanban application. The kanban app already has planning docs for a diagram viewer page (`/home/john/kanban/plans/`). This document describes how our framework — Scene, reflow engine, interaction layer — plugs into that page.

## Architecture Fit

The kanban app's diagram viewer has two panels:
- **DiagramTreePanel** (left): file tree of `diagrams/` directory
- **DiagramContentArea** (right): renders the selected diagram

Our framework replaces what goes inside `DiagramContentArea`. Currently the kanban plans describe rendering HTML diagrams in an `<iframe srcdoc>`. With our framework, the content area instead:

1. Calls `loadDiagram(html)` to parse the HTML into a `Scene`
2. Mounts the Scene's render element into the content area div
3. Initializes the interaction layer (D3-zoom, selection, click routing)
4. Wires up extension calls (navigate to source, etc.)

```
DiagramContentArea
  └── Scene render element (from scene.getRenderElement())
        ├── D3-zoom attached (pan/zoom)
        ├── InteractionLayer listening (selection, clicks)
        └── SVG diagram content (visual)
```

## Extension Calls

The interaction layer emits events when the user interacts with diagram elements. Applications register **extension calls** — named handlers that run when specific interactions occur. This is how the kanban app wires up "click element → navigate to source in VSCode."

### ExtensionCallRegistry Interface

```typescript
/** A named handler that the application registers with the interaction layer. */
interface ExtensionCall {
  /** Unique name for this extension call. */
  name: string;

  /** When this call triggers.
   *  'click' — user clicks an interactive element
   *  'select' — user selection changes (click-select or drag-select)
   *  'expand' — user clicks an expandable element */
  trigger: 'click' | 'select' | 'expand';

  /** Optional filter: only trigger for elements matching this category. */
  categoryFilter?: InteractiveCategory[];

  /** The handler function. */
  handler: (event: ExtensionCallEvent) => void;
}

/** Event data passed to extension call handlers. */
interface ExtensionCallEvent {
  /** The type of interaction that triggered this call. */
  trigger: 'click' | 'select' | 'expand';

  /** The SceneElement that was clicked (for 'click' and 'expand' triggers). */
  elementId: string | null;

  /** The element's metadata (data-* attributes). */
  metadata: Record<string, string> | null;

  /** The parsed interactive element, if the element has data-interactive.
   *  Null for non-interactive elements or for 'select' trigger. */
  interactiveElement: InteractiveElement | null;

  /** All currently selected element IDs (for 'select' trigger). */
  selectedIds: Set<string>;

  /** All currently selected interactive elements (for 'select' trigger). */
  selectedElements: InteractiveElement[];

  /** The original DOM event, if available. */
  domEvent: PointerEvent | null;
}

/** Registry for managing extension calls. */
interface ExtensionCallRegistry {
  /** Register an extension call. */
  register(call: ExtensionCall): void;

  /** Unregister by name. */
  unregister(name: string): void;

  /** Fire all registered calls matching the given trigger and element. */
  fire(trigger: 'click' | 'select' | 'expand', event: ExtensionCallEvent): void;
}
```

### How the Interaction Layer Uses It

The interaction layer holds an `ExtensionCallRegistry` and fires it at the appropriate points:

```typescript
// Inside InteractionLayer

// On click:
const elementId = scene.hitTest(scenePoint);
if (elementId) {
  const el = scene.getElement(elementId);
  const interactive = interactiveRegistry.get(elementId);
  extensionCalls.fire('click', {
    trigger: 'click',
    elementId,
    metadata: el?.metadata ?? null,
    interactiveElement: interactive,
    selectedIds: this.selectedIds,
    selectedElements: this.getSelectedElements(),
    domEvent: event,
  });
}

// On selection change:
extensionCalls.fire('select', {
  trigger: 'select',
  elementId: null,
  metadata: null,
  interactiveElement: null,
  selectedIds: this.selectedIds,
  selectedElements: this.getSelectedElements(),
  domEvent: null,
});

// On expandable click:
if (el?.metadata['expandable'] === 'true') {
  extensionCalls.fire('expand', {
    trigger: 'expand',
    elementId,
    metadata: el.metadata,
    interactiveElement: interactive,
    selectedIds: this.selectedIds,
    selectedElements: this.getSelectedElements(),
    domEvent: event,
  });
}
```

### Stubbing

The interaction layer works with zero registered extension calls. All `fire()` calls are no-ops when the registry is empty. This means:
- Pan/zoom works without any extensions
- Selection works without any extensions
- Click highlighting works without any extensions
- The framework is fully functional as a standalone diagram viewer; extensions add application-specific behavior on top

## Kanban Registration

The kanban app registers extension calls when it mounts the diagram viewer:

```typescript
// In DiagramContentArea or useDiagramViewer hook

// Navigate to source on click
interactionLayer.extensionCalls.register({
  name: 'kanban-navigate',
  trigger: 'click',
  categoryFilter: ['function', 'type', 'data', 'flow', 'call', 'module'],
  handler: (event) => {
    if (!event.interactiveElement) return;
    const { filePath, startLine } = event.interactiveElement.parsedRef;
    trpc.diagrams.navigate.mutate({
      root: workspacePath,
      filePath,
      line: startLine,
      newTab: event.domEvent?.ctrlKey || event.domEvent?.metaKey,
    });
  },
});

// Feed selected elements to LLM chat
interactionLayer.extensionCalls.register({
  name: 'kanban-selection',
  trigger: 'select',
  handler: (event) => {
    if (event.selectedElements.length === 0) return;
    onSelectionChange(event.selectedElements.map(el => el.parsedRef));
  },
});

// Handle expand/collapse
interactionLayer.extensionCalls.register({
  name: 'kanban-expand',
  trigger: 'expand',
  handler: async (event) => {
    if (!event.elementId) return;
    // Load expanded content, insert into scene, trigger reflow
    const expandSrc = event.metadata?.['expand-src'];
    if (!expandSrc) return;
    const content = await fetchExpandedContent(expandSrc);
    // ... insert into scene, call engine.groupResized()
  },
});
```

## Data Flow: Click to Navigate

```
User clicks on <text> inside <g data-interactive="scheduler-yield">
  │
  ▼
Browser fires pointerup on container
  │
  ▼
InteractionLayer.onPointerUp
  │  Checks didDrag flag (false → not a pan)
  │  scene.hitTest(scenePoint) via .closest() → "scheduler-yield"
  │  Updates selection state
  │
  ▼
extensionCalls.fire('click', { elementId: "scheduler-yield", ... })
  │
  ▼
'kanban-navigate' handler fires
  │  Reads interactiveElement.parsedRef:
  │    { filePath: "packages/scheduler/src/forks/Scheduler.js", startLine: 480 }
  │
  ▼
trpc.diagrams.navigate.mutate({
  root: "/home/john/code-viz/data/repos/react",
  filePath: "packages/scheduler/src/forks/Scheduler.js",
  line: 480
})
  │
  ▼
Kanban runtime → code-viz-client.ts
  │  POST http://localhost:24680/api/navigate
  │
  ▼
Code-viz router → internal server → VSCode opens file at line 480
```

## Data Flow: Drag-Select to LLM

```
User drag-selects region covering 3 interactive elements
  │
  ▼
InteractionLayer.onPointerMove
  │  scene.hitTestRect(sceneRect, 'intersect') → ["scheduler-yield", "scheduler-task-queue", "scheduler-work-loop"]
  │  Updates selection state (Set of 3 IDs)
  │
  ▼
InteractionLayer.onPointerUp
  │
  ▼
extensionCalls.fire('select', { selectedElements: [3 InteractiveElements] })
  │
  ▼
'kanban-selection' handler fires
  │  Maps to ParsedRefs:
  │    [ { filePath: "Scheduler.js", startLine: 480, endLine: 485 },
  │      { filePath: "Scheduler.js", startLine: 53 },
  │      { filePath: "Scheduler.js", startLine: 400, endLine: 480 } ]
  │
  ▼
Application resolves file paths → reads source lines → feeds to LLM chat
```

## Integration Checklist

| Step | Where | What |
|---|---|---|
| 1 | `DiagramContentArea` | Replace `<iframe srcdoc>` with `loadDiagram(html)` + mount Scene render element |
| 2 | `useDiagramViewer` | Initialize InteractionLayer with Scene + InteractiveElementRegistry |
| 3 | `useDiagramViewer` | Register 'kanban-navigate' extension call for click-to-source |
| 4 | `useDiagramViewer` | Register 'kanban-selection' extension call for drag-select-to-LLM |
| 5 | `useDiagramViewer` | Register 'kanban-expand' extension call for expand/collapse |
| 6 | `DiagramContentArea` | Cleanup: unregister extension calls on unmount |

## What Stays in Kanban's Domain

The framework does not own:
- Fetching diagram HTML from disk (kanban's TRPC `diagrams.getContent` does this)
- The file tree panel (kanban's `DiagramTreePanel`)
- Navigation to source (kanban's `code-viz-client.ts` via TRPC)
- Layout persistence (kanban's localStorage pattern)
- Error/fallback states (kanban's `DiagramViewerFallback`)

The framework owns:
- Parsing HTML into a Scene (`loadDiagram`)
- The Scene render element and its DOM structure
- Pan/zoom via D3-zoom on the root SceneElement
- Selection state and hit testing
- Reflow engine and animation scripts
- Extension call registry (the dispatch mechanism, not the handlers)
