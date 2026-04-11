# Selection — Lessons from tldraw

## Context

Our `interaction.md` defines a selection system: `Set<string>` of IDs, CSS `.selected` class, click/shift-click/drag-select, DOM-based hit testing via `.closest()`. This document examines how tldraw implements selection and identifies patterns we should adopt, patterns to defer, and patterns to skip.

## tldraw's selection architecture

### Data flow overview

```
Pointer event on canvas
  │
  ▼
Classify target (shape / canvas / selection handle)
  │
  ├─ Shape hit ──► PointingShape state
  │                  │
  │                  ├─ No drag ──► select shape (modifier-aware)
  │                  └─ Drag    ──► Translating state
  │
  ├─ Canvas hit ──► PointingCanvas state
  │                  │
  │                  ├─ No drag ──► clear selection
  │                  └─ Drag    ──► Brushing state
  │
  └─ Selection ──► PointingSelection / Resizing / Rotating
```

### Hit testing pipeline

tldraw uses a two-phase approach:

**Broad phase** — R-tree spatial index (RBush) returns candidate shapes whose bounding boxes overlap the click point. O(log n).

**Narrow phase** — For each candidate (iterated in reverse z-order, top-most first):
1. Transform the click point into the shape's local coordinate space
2. Check the shape's bounding box with an outer margin (cheap reject)
3. Call `geometry.distanceToPoint(localPoint, hitInside)` — returns a **signed distance**:
   - Negative → point is inside a filled/closed shape
   - Positive → distance to nearest edge
4. Compare against margin threshold

The signed distance is what makes this work for different shape types:

| Shape type | Hit behavior |
|---|---|
| Filled rect/circle | Click anywhere inside → hit (distance < 0) |
| Hollow rect (stroke only) | Only clicks near the border → hit (distance < margin) |
| Open path (line/arrow) | Only clicks near the path → hit (distance < margin/zoom) |

For our SVG diagrams:
- Reflow groups with background rects → **filled** (clicking inside selects)
- Stroke-only borders → **hollow** (only near the border)
- Arrows/connectors → **open paths** (margin-based)

### Outermost selectable shape + focused group

When you click a nested element, tldraw doesn't select that element — it walks **up** the parent chain and selects the outermost group. But it stops at a **focus boundary**:

```
Page
  └─ Group A               ← click selects this
       └─ Group B
            └─ Rect         ← actual click target
```

Double-clicking Group A "focuses" it, making its children directly selectable:

```
Page
  └─ Group A  [focused]
       └─ Group B          ← now click selects this
            └─ Rect         ← actual click target
```

The algorithm:

```
getOutermostSelectableShape(clickedShape):
  match = clickedShape
  node = clickedShape

  while node has parent:
    if node is a group AND node ≠ focusedGroup AND node is not ancestor of focusedGroup:
      match = node          // found a higher group, keep climbing
    else if node == focusedGroup:
      break                 // stop at focus boundary
    node = node.parent

  return match
```

This creates a hierarchical drill-down model:
- First click on a top-level group → selects the group
- Double-click (or second click) → focuses the group, making children selectable
- Click outside → pops focus back up

### Modifier keys captured at pointer-down

tldraw makes selection decisions at the moment of pointer-down, not pointer-up:

| Event | No modifier | Shift | Ctrl/Cmd |
|---|---|---|---|
| Pointer down on shape | Select immediately (replace) | Add to selection | Begin brush from shape position |
| Pointer down on canvas | Clear selection | Keep current selection | Begin brush |
| Pointer up (no drag) | — | Toggle shape in/out | — |
| Drag from canvas | Brush (contain mode) | Additive brush | Brush (intersect mode) |

The pointer-down handler classifies the interaction into a "child state" (PointingShape, PointingCanvas, Brushing) and the modifier keys are captured at that moment. This is a single decision point, not scattered checks.

### Brush selection: contain vs intersect

tldraw's brush (drag-select) supports two modes:

**Contain** (default): the shape's bounding box must be fully inside the brush rectangle.

**Intersect** (Ctrl held): the shape's geometry must touch any edge of the brush rectangle. This uses `geometry.hitTestLineSegment(A, B)` against each of the brush rect's 4 edges — which correctly handles rotated elements, non-rectangular shapes, and complex paths.

With shift held, new hits are unioned with the selection that existed when the brush started.

### Selection rendering

tldraw renders selection as **separate overlay layers**, not CSS classes on the shapes:

- **Background layer**: solid color behind selected shapes
- **Foreground layer**: SVG overlay with selection outline, resize handles, rotation handles

The overlay is positioned using the union bounding box of all selected shapes (`Box.Common(selectedBounds[])`), and transforms to follow the shapes via CSS.

## What we should adopt

### 1. Focused group + outermost selectable

This maps directly to our nested reflow groups. Without it, clicking any element inside a collapsed group requires the user to know the nesting structure. With it:

- Click a reflow group → selects the group
- Double-click (or configured gesture) → "focuses" it, children become individually selectable
- Click outside or press Escape → pops focus back up

Implementation in our InteractionLayer:

```typescript
// New state
let focusedGroupId: string | null = null

// Modified hit resolution
function resolveClickTarget(elementId: string): string {
  // Walk up from clicked element to outermost selectable,
  // stopping at focusedGroupId
  let match = elementId
  let current = elementId

  while (current) {
    const el = scene.getElement(current)
    if (!el) break
    const parentId = el.parentId
    if (!parentId || parentId === focusedGroupId) break

    const parent = scene.getElement(parentId)
    if (parent?.metadata['data-reflow-group']) {
      match = parentId  // found a higher reflow group
    }
    current = parentId
  }

  return match
}

// Double-click handler
function onDoubleClick(elementId: string) {
  const el = scene.getElement(elementId)
  if (el?.metadata['data-reflow-group']) {
    focusedGroupId = elementId
    // Now clicks inside this group select children directly
  }
}
```

This requires no new data structures — it uses the existing SceneElement tree and `parentId` relationships. The focusedGroupId is just one piece of ephemeral state.

### 2. Modifier keys as a single decision point at pointer-down

Our current `interaction.md` checks shift at pointer-up (for toggle) and has a separate code path for drag-select. Consolidating into a pointer-down decision:

```typescript
function onPointerDown(e: PointerEvent) {
  const scenePoint = scene.screenToScene({ x: e.clientX, y: e.clientY })
  const hitId = scene.hitTest(scenePoint)
  const target = hitId ? resolveClickTarget(hitId) : null

  if (target) {
    // Pointing at a shape
    if (e.shiftKey) {
      // Shift: add to selection immediately
      selection.add(target)
    } else if (!selection.has(target)) {
      // Replace selection
      selection.clear()
      selection.add(target)
    }
    // In all cases: might become a drag (translate), so record origin
    pointerState = { type: 'pointing-shape', target, origin: scenePoint }
  } else {
    // Pointing at empty canvas
    if (!e.shiftKey) {
      selection.clear()
    }
    // Start brush
    pointerState = { type: 'pointing-canvas', origin: scenePoint, shiftKey: e.shiftKey }
  }
}

function onPointerMove(e: PointerEvent) {
  if (!pointerState) return

  if (pointerState.type === 'pointing-canvas' && movedPastThreshold(e)) {
    // Transition to brushing
    pointerState = {
      type: 'brushing',
      origin: pointerState.origin,
      additive: pointerState.shiftKey,
      initialSelection: new Set(selection),
    }
  }
  // ... brush rect update, hit test, etc.
}

function onPointerUp(e: PointerEvent) {
  if (pointerState?.type === 'pointing-shape') {
    if (e.shiftKey && selection.has(pointerState.target)) {
      // Shift+click on already-selected: toggle off
      selection.delete(pointerState.target)
    }
  }
  pointerState = null
}
```

This is essentially a 3-state mini-machine (`pointing-shape`, `pointing-canvas`, `brushing`) — simple enough that it doesn't need a formal state machine abstraction, but structured enough that modifier logic isn't scattered.

### 3. Contain vs intersect brush modes

Our `interaction.md` currently specifies `hitTestRect(sceneRect, 'intersect')` as the only mode. We should support both:

- **Contain** (default drag): only selects elements fully inside the brush
- **Intersect** (Ctrl+drag or configurable): selects elements touching the brush edges

If we adopt `Geometry2d`, the intersect test becomes:

```typescript
function brushHitTest(brush: Box, elementGeom: Geometry2d, mode: 'contain' | 'intersect'): boolean {
  if (mode === 'contain') {
    return brush.contains(elementGeom.bounds)
  }
  // Intersect: test brush edges against element geometry
  const corners = brush.corners
  for (let i = 0; i < 4; i++) {
    if (elementGeom.hitTestLineSegment(corners[i], corners[(i + 1) % 4])) {
      return true
    }
  }
  // Also check if element is fully inside brush (no edge intersection but contained)
  return brush.containsPoint(elementGeom.bounds.center)
}
```

Without `Geometry2d`, we can still do this with AABB checks — contain is `brush.contains(elementBounds)`, intersect is `brush.collides(elementBounds)`. Less precise for rotated elements, but functional.

### 4. Signed-distance hit testing (with Geometry2d adoption)

This is covered in `geometry.md` but directly impacts selection: if we give each SceneElement a `Geometry2d`, the hit test becomes:

```typescript
// Instead of:
scene.hitTest(point)  // DOM walk via .closest()

// We do:
for (const element of elementsInReverseZOrder) {
  const localPoint = element.pageTransform.invert().applyToPoint(point)
  const distance = element.geometry.distanceToPoint(localPoint, /* hitInside */ true)
  if (distance <= margin) return element.id
}
```

This decouples selection from the SVG DOM, respects filled-vs-hollow semantics, and works with the focused-group boundary (just filter which elements to test).

## What to defer

### Spatial index (R-tree)

tldraw uses RBush for O(log n) candidate filtering. Our diagrams have <200 elements — linear scan through the SceneElement array is fine. If we see hit-test latency on large diagrams, add a simple spatial index then.

### Separate overlay layer for selection

tldraw renders selection indicators in a separate SVG layer with resize/rotate handles. Our CSS `.selected` class approach is simpler and sufficient — we don't need handles. If we later add interactive resize for reflow groups, escalate to a separate overlay then.

### Reactive/computed selection state

tldraw stores `selectedShapeIds` in a reactive record so computed values (`getSelectedShapes()`, `getSelectionPageBounds()`) auto-update. Our `Set<string>` with manual CSS class toggling is correct for our case — we don't have derived computations that depend on selection.

## What to skip

### State machine for tool modes

tldraw's `SelectTool` has 10+ child states (Idle, PointingShape, PointingCanvas, Brushing, Translating, Resizing, Rotating, Cropping, DraggingHandle, EditingShape). We have 3 interaction modes (idle, pointing, brushing). The 3-state approach in the code above is a flat `pointerState` discriminated union — no framework needed.

### Selection handles (resize, rotate, crop)

We don't interactively resize or rotate diagram elements. Skip all handle rendering, handle hit testing, and handle interaction states.

### Selected-shape-at-point (for dragging)

tldraw has a separate `getSelectedShapeAtPoint()` for detecting drags on already-selected shapes. We don't drag shapes — our shapes are positioned by the reflow engine. Skip this.

### Multi-shape rotation and aspect-ratio-locked resize

All the `getSelectionRotation()`, `getSelectionRotatedPageBounds()`, and aspect-ratio logic in tldraw's selection system is for its drawing tool. Not relevant.

## Changes to interaction.md

If we adopt these patterns, the main changes to `interaction.md` would be:

1. **Add `focusedGroupId` state** alongside the `Set<string>` selection state
2. **Add `resolveClickTarget()` function** that walks up to outermost selectable, stopping at focused group
3. **Add double-click handler** that focuses reflow groups
4. **Restructure pointer handlers** around the pointer-down decision point pattern (pointing-shape / pointing-canvas / brushing)
5. **Add contain/intersect brush mode** parameter to `hitTestRect`
6. **Note the Geometry2d upgrade path** — current DOM-based hit testing works, but if we adopt `Geometry2d` per `geometry.md`, hit testing becomes DOM-independent and gains signed-distance semantics
