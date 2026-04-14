# SceneInput

## Overview

`SceneInput` is the interaction layer between raw pointer events and application-level semantics. It wraps `Viewport`, adding hit testing, selection management, tooltips, and navigation dispatch. It does not decide *what* to do with clicks — it classifies them and fires callbacks.

## Architecture

```
SceneInput (forwardRef → ViewportHandle)
├── Tooltip div (fixed position, pointer-events: none)
├── Viewport
│   ├── Transform div + SVG
│   ├── OverLayer (badges)
│   └── Selection overlay
└── Tooltip CSS styles
```

SceneInput forwards its ref to Viewport, so consumers get a `ViewportHandle` for programmatic `centerOn()`.

## Event Flow

```
#comment: should get a diagram to clarify this relationship
Pointer event on container
  → Viewport classifies:
      drag → onSelectionDrag / onSelectionDragEnd (if ctrl/selectMode)
      drag → pan (otherwise)
      click → onSceneClick
      right-click → onContextMenu
  → SceneInput handles:
      onSceneClick → hitTest → selection update → onNavigate
      onSelectionDrag → hitTestRect → preview visuals
      onSelectionDragEnd → hitTestRect → final selection → clipboard copy
      onContextMenu → forwarded to consumer
```

## Tooltips

Tooltips show on hover (desktop) and tap (touch) for elements with `data-tt` attributes.

**Desktop**: SVG `mouseover` → find closest `[data-tt]` ancestor → parse tooltip text → show near cursor. `mousemove` repositions. `mouseout` hides.

**Touch**: SVG `pointerdown` with `pointerType === "touch"` → same show logic. Tap elsewhere dismisses.

Tooltip content structure:
```
<span class="tt-file">file/path:lines</span>
<div class="tt-hint">optional description</div>
<div class="tt-action">click/tap to jump to code</div>
```

Positioned at `clientX + 14, clientY - 10`. Fixed positioning, z-index 100.

## Selection Management

### State

- `selectedIds: Set<string>` — currently selected element IDs (React state)
- `dragPreviewIds: Set<string>` — elements highlighted during active lasso drag
- Visual feedback applied by toggling `.selected` CSS class on DOM elements

### Click Selection

| Input | Behavior |
|-------|----------|
| Click on interactive element | Clear previous, select it |
| Shift+click on interactive element | Toggle it in/out of selection |
| Click on empty space | Deselect all |
| Click on non-interactive element | Deselect all |

### Lasso Selection

1. **During drag** (`handleSelectionDrag`):
   - `scene.hitTestRect(sceneRect, "intersect")` finds overlapping interactive elements
   - Apply `.selected` class to preview hits
   - Remove `.selected` from elements no longer in the rect

2. **On drag end** (`handleSelectionDragEnd`):
   - Final `hitTestRect` determines selected set
   - Clear old selection visuals, apply new ones
   - Fire `onSelectionChange` callback
   - Collect unique `ref` strings from selected elements
   - Copy refs to clipboard, show toast notification

### Selection Overlay Paths

During lasso drag, `dragPreviewPaths` provides truncated file paths displayed to the left of the lasso rectangle (via Viewport's `selectionOverlayPaths` prop). Paths are truncated to 20 characters, showing `parent/filename` or just `filename`.

## Navigation Dispatch

When a click hits an interactive element, `onNavigate(interactive, domEvent)` fires with the full `InteractiveData` and the raw DOM event. The consumer (typically `DiagramScene`) decides the action based on modifiers and element metadata:

- Alt+click → jump to code editor
- Modal element → open popup diagram overlay
- Link element → navigate to target diagram/element
- Default → jump to code editor

## Props

| Prop | Type | Description |
|------|------|-------------|
| `scene` | `Scene` | The scene to interact with |
| `onNavigate` | `(interactive, domEvent) => void` | Fired on interactive element click |
| `onSelectionChange` | `(elements: InteractiveData[]) => void` | Fired when selection changes |
| `onContextMenu` | `(event: ViewportSceneEvent) => void` | Right-click handler |
| `badges` | `OverlayBadge[]` | Passed through to Viewport/OverLayer |
| `children` | `ReactNode` | Rendered inside Viewport |

---

## Source References

```
web-ui/src/diagram/input/scene-input.tsx
  L16       PATH_DISPLAY_MAX_LEN constant (20)
  L20-30    truncatePath helper
  L32-40    SceneInputProps interface
  L45-47    Component doc comment
  L48-357   SceneInput component
  L52        selectedIds state
  L53        tooltipRef
  L57        touchTooltipTargetRef
  L59-118    Tooltip effect: mouseover, mousemove, mouseout, pointerdown handlers
  L64-73       showTooltip helper
  L75-93       Desktop mouse handlers
  L96-106      Touch tooltip handler
  L120-129   applySelectionVisual: toggle .selected class on DOM
  L131-143   getSelectedInteractiveData: map IDs to InteractiveData
  L147       dragPreviewIds state
  L149-173   handleSelectionDrag: hitTestRect + preview visuals
  L175-184   dragPreviewPaths memo: truncated paths for overlay
  L186-243   handleSelectionDragEnd: final selection + clipboard copy
  L214-240     Clipboard copy + toast notification
  L245-312   handleSceneClick: hitTest → selection update → onNavigate
  L250        hitTest at screenPoint
  L269-293     Selection logic: shift+click toggle vs single-select
  L306-309     onNavigate dispatch
  L314-357   JSX: tooltip div + Viewport + tooltip CSS

web-ui/src/diagram/rendering/viewport.tsx
  L20-24    ViewportSceneEvent (passed to SceneInput handlers)
  L26-39    ViewportProps (consumed by SceneInput)
  L41-44    ViewportHandle (re-exported by SceneInput)
```
