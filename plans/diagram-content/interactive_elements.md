# Interactive Elements

## Purpose

Interactive elements expose regions of the diagram to user interaction — selection, hover, drag-select, and application-defined actions. They are `SceneElement`s (see `rendering.md`) with the `data-interactive` role.

**This is a separate concern from reflow groups.** A reflow group controls spatial layout; an interactive element controls user interaction. They may be the same underlying `SceneElement` (a single `<g>` with both `data-reflow-group` and `data-interactive`), but the two roles are annotated and processed independently.

## The `data-interactive` Contract

### Attribute: `data-interactive="<id>"`

Applied to a `<g>` element that should be selectable/interactive. The `<g>` defines the interactive region — its bounding box becomes the hit area.

```xml
<g data-interactive="scheduler-work-loop"
   data-ref="packages/scheduler/src/forks/Scheduler.js:400-480"
   data-category="function"
   data-label="workLoop">
  <!-- visual content (may also be a reflow group) -->
  <rect ... />
  <text ...>workLoop</text>
</g>
```

### Required Attributes

| Attribute | Type | Description |
|---|---|---|
| `data-interactive` | `string` | Unique interactive element ID |
| `data-ref` | `string` | Source code reference. Format: `<filepath>:<line>` or `<filepath>:<startLine>-<endLine>` |
| `data-category` | `string` | Element classification (see Categories below) |

### Optional Attributes

| Attribute | Type | Description |
|---|---|---|
| `data-label` | `string` | Human-readable label for the element (used in selection UI, tooltips) |
| `data-tt` | `string` | Tooltip text. Format: `<file:line> — <description>` |
| `data-nav` | `string` | Override navigation target if different from `data-ref`. Format: `<filepath>:<line>` |

## Categories

Interactive elements are classified by `data-category` to enable applications to filter, style, and handle them differently. Categories are semantic — they describe what the code element *is*, not how it looks.

| Category | Description | Example |
|---|---|---|
| `module` | A file or module boundary | A box representing `Scheduler.js` |
| `function` | A function or method | The `workLoop` function block |
| `type` | A type, interface, or class definition | A `Task` type definition |
| `data` | A variable, constant, or data structure | `taskQueue`, `timerQueue` |
| `flow` | A control flow construct (branch, loop, condition) | The yield-check decision block |
| `call` | A function call or invocation site | `advanceTimers()` call annotation |
| `concept` | An abstract concept or pattern, not a single code location | "continuation pattern", "preemption" |
| `annotation` | Explanatory text that references code but isn't a code element | A note about browser timing |

### Why Categories Matter

Applications built on top need to differentiate elements. For example:
- A "select and ask LLM" feature might want to resolve all `function` and `data` elements in a selection to their source lines, but skip `annotation` elements.
- A code coverage overlay might color `function` elements by coverage percentage.
- A dependency viewer might only care about `call` elements.

## Interaction Model

Interactive elements are `SceneElement`s — the same elements that the Scene renders visually. There are no overlay nodes, no separate position tracking, no bridge layer. The interaction layer operates directly on the Scene via `scene.hitTest()` and `scene.hitTestRect()`.

### How Interaction Works

1. **Click:** User clicks → interaction layer detects via pointer events → `scene.hitTest()` resolves to the deepest SceneElement → interaction layer updates selection state → fires registered extension calls (see `integration.md` for the `ExtensionCallRegistry`)
2. **Drag-select:** User drags rectangle → interaction layer converts to scene coordinates → `scene.hitTestRect(sceneRect, 'intersect')` → returns matching IDs → updates selection state → fires 'select' extension calls
3. **Selection visual:** The interaction layer applies/removes a CSS class (e.g., `.selected`) directly on the SceneElement's underlying DOM node. For SVG backend: adds a highlight rect or changes stroke. No overlay divs.
4. **After reflow:** Interactive elements that were displaced move automatically (they ARE the visual elements). Hit testing calls `scene.hitTest()` / `scene.getWorldBounds()` which read current bounds from the Scene — no cached state to invalidate.
5. **Extension calls:** Applications register named handlers for click, select, and expand events. The interaction layer dispatches to them. With zero handlers registered, the framework is still fully functional (pan/zoom/selection work standalone). See `integration.md` for the `ExtensionCallRegistry` interface.

### Category Type

```typescript
type InteractiveCategory =
  | 'module'
  | 'function'
  | 'type'
  | 'data'
  | 'flow'
  | 'call'
  | 'concept'
  | 'annotation';
```

## Overlap with Reflow Groups

A single `SceneElement` can carry both `data-reflow-group` and `data-interactive` attributes — it has both roles simultaneously:

```xml
<g data-reflow-group="work-loop"
   data-interactive="scheduler-work-loop"
   data-ref="packages/scheduler/src/forks/Scheduler.js:400-480"
   data-category="function"
   data-label="workLoop">
  ...
</g>
```

This is the common case for top-level diagram blocks. The `ReflowGroupRegistry` sees this element as a reflow group node. The `InteractiveElementRegistry` sees it as an interactive element. Both reference the same `SceneElement` by ID.

Nested elements might be interactive without being reflow groups (e.g., a single clickable label inside a larger block). Conversely, some reflow groups might not be interactive (e.g., a decorative separator).

## Data Structures

### InteractiveElementRegistry

Built during diagram loading by filtering `SceneElement`s that have the `data-interactive` role.

```typescript
/** Registry of all interactive elements in a diagram.
 *  Provides metadata lookup for SceneElement IDs returned by scene.hitTest(). */
interface InteractiveElementRegistry {
  /** All interactive elements, keyed by their SceneElement ID. */
  elements: Map<string, InteractiveElement>;

  /** Build from Scene. Filters SceneElements for those with
   *  data-interactive in metadata, parses their attributes. */
  buildFromScene(scene: Scene): void;

  /** Look up an interactive element by SceneElement ID.
   *  Returns null if the ID is not an interactive element. */
  get(id: string): InteractiveElement | null;
}
```

The registry's only job is to parse `data-interactive` SceneElements into `InteractiveElement` structs so the interaction layer can look up metadata (ref, category, label) when `scene.hitTest()` returns a SceneElement ID. It does not need to know about reflow groups — the containment relationship is already in the SceneElement tree (`parentId`/`childIds`). It does not reference SVG DOM — it only knows SceneElement IDs and metadata.

### InteractiveElement

The parsed representation of a single interactive `SceneElement`.

```typescript
/** A single interactive element.
 *  Wraps a SceneElement with parsed interaction metadata. */
interface InteractiveElement {
  /** The SceneElement ID (same as data-interactive value). */
  id: string;

  /** Raw data-ref string. */
  ref: string;

  /** Parsed source reference. */
  parsedRef: ParsedRef;

  /** Element category. */
  category: InteractiveCategory;

  /** Display label (from data-label, falls back to id). */
  label: string;

  /** Tooltip text (from data-tt). */
  tooltip: string | null;

  /** Navigation override (from data-nav, falls back to ref). */
  navTarget: ParsedRef;
}

/** Parsed source code reference. */
interface ParsedRef {
  filePath: string;
  startLine: number;
  endLine: number | null;
}
```

Note: `InteractiveElement` no longer caches bounds. Bounds are read on demand from `scene.getWorldBounds(id)` — the Scene owns all spatial state.

## Selection and the Application Layer

The interaction layer (see `overview.md`) manages selection state as a `Set<string>` of SceneElement IDs:
- **Click** on interactive element → select it, deselect others
- **Shift+click** → toggle element in/out of selection
- **Drag-select** → `scene.hitTestRect()` → select all matching elements

The framework exposes selected elements to the application layer:

```typescript
// Application code — provided by the interaction layer
function getSelectedRefs(
  selectedIds: Set<string>,
  registry: InteractiveElementRegistry
): ParsedRef[] {
  return Array.from(selectedIds)
    .map(id => registry.elements.get(id))
    .filter((el): el is InteractiveElement => el != null)
    .map(el => el.parsedRef);
}
```

This is the integration point for the target use case: "user drag-selects diagram elements → resolve to source code lines → feed to LLM chat."