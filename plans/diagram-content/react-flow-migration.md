# ReactFlow Migration Reference

## Purpose

This document catalogs the specific ReactFlow features we want to keep, the exact xyflow implementations that provide them, and how they solve subtle interaction problems. This is a reference for reimplementing these features directly against our Scene interface, eliminating the coordinate system bifurcation between ReactFlow's Node positions and Scene element positions.

## Why We're Removing ReactFlow

ReactFlow forces a dual coordinate/update cycle:
1. Scene moves visual content (e.g., SVG `transform`) — happens immediately, animates via CSS
2. ReactFlow overlay Nodes must be separately updated via `applyNodeChanges()` — happens via React re-render, no animation

This creates a timing desync where selection highlights jump ahead of visual content, and requires a bridge layer (ReflowBridge) whose sole job is translating between two representations of the same positions. By implementing interaction directly on the Scene, we get one coordinate system, one update path, and no bridge.

## Features to Reimplement

### 1. Pan/Zoom Viewport

**What it does:** Drag-to-pan, scroll-to-zoom, pinch-to-zoom, keyboard zoom, momentum, viewport constraints.

**ReactFlow implementation:**
- **File:** `/home/john/xyflow/packages/system/src/xypanzoom/XYPanZoom.ts` (lines 36-301)
- **Approach:** Wraps D3-zoom (`d3-zoom` library). Calls `zoom()` to create a D3 zoom behavior, attaches it to a DOM element via `select(domNode).call(d3ZoomInstance)`. D3 handles all input events (mouse, touch, wheel) and produces a transform `{x, y, k}` (translate x, translate y, scale).
- **State:** Stored in a zustand store as `transform: [tx, ty, tScale]`.
- **DOM:** Applied as CSS on the viewport div: `transform: translate(${tx}px, ${ty}px) scale(${tScale})`.

**Key event handlers (all in `/home/john/xyflow/packages/system/src/xypanzoom/eventhandler.ts`):**

| Event | Handler | What it does |
|---|---|---|
| Drag start | `startHandler` (line 165) | Sets `isZoomingOrPanning=true`, fires `onPanZoomStart` |
| Drag move | `panZoomHandler` (line 188) | Extracts `event.transform.{x,y,k}`, calls `onTransformChange()` |
| Drag end | `panZoomEndHandler` (line 210) | Sets `isZoomingOrPanning=false`, fires `onPanZoomEnd` |
| Wheel (zoom mode) | `createZoomOnScrollHandler` (line 121) | `preventDefault()`, delegates to D3 zoom |
| Wheel (pan mode) | `createPanOnScrollHandler` (line 61) | Uses `d3Zoom.translateBy()` to pan |
| Pinch | Inside pan-on-scroll handler (line 86) | Detects `ctrlKey` (MacOS trackpad), calls `d3Zoom.scaleTo()` at touch point |

**Wheel delta formula** (`/home/john/xyflow/packages/system/src/xypanzoom/utils.ts` line 36):
```
delta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002) * (MacOS+ctrlKey ? 10 : 1)
```

**Filter logic** (`/home/john/xyflow/packages/system/src/xypanzoom/filter.ts` lines 86-94):
- `panOnDrag` can be `true` (left button) or `[0, 1, 2]` (specific buttons)
- When `selectionOnDrag`, sets D3 `clickDistance` to `Infinity` to prevent pan clicks

**Reimplementation approach:** Use D3-zoom directly on the Scene's render element (the same `<svg>` or container). The transform goes into a shared store. The Scene applies it as CSS `transform` on a wrapper div. This is exactly what `base.html` does with its viewBox manipulation, but using D3 instead of manual mouse handling.

---

### 2. Selection System

**What it does:** Click-select single element, shift+click multi-select, drag-select rectangle with partial/full containment modes.

#### 2a. Drag-Select Rectangle

**ReactFlow implementation:**
- **Selection logic:** `/home/john/xyflow/packages/react/src/container/Pane/index.tsx` (lines 61-292)
- **Selection visual:** `/home/john/xyflow/packages/react/src/components/UserSelection/index.tsx` (lines 11-29)

**How it works:**
1. `onPointerDownCapture` (line 123): Stores start position, calls `setPointerCapture()` to lock events to pane
2. `onPointerMove` (line 160): Computes selection rect `{x, y, width, height}` from start and current pointer positions. Calls `getNodesInside()` to find intersecting nodes. Updates store with selected node IDs
3. `onPointerUp` (line 242): Releases pointer capture, clears selection state

**Selection rectangle rendering:** Simple div with `transform: translate(x, y)` and explicit `width`/`height`. Positioned in screen space, not flow space.

**getNodesInside implementation** (`/home/john/xyflow/packages/system/src/utils/graph.ts` lines 257-296):
```
1. Convert screen-space rect to flow-space:
   flowX = (screenX - tx) / tScale
   flowY = (screenY - ty) / tScale
   flowW = screenW / tScale
   flowH = screenH / tScale

2. For each node:
   overlap = getOverlappingArea(flowRect, nodeBounds)
   if partial mode: include if overlap > 0
   if full mode: include if overlap >= nodeArea
```

**Reimplementation approach:** Implement against `scene.hitTestRect(rect, 'intersect' | 'contain')`. The pointer capture + rect computation stays the same. Instead of iterating ReactFlow nodes, call Scene's hit test which walks cached bounds. Render the selection rectangle as a screen-space div overlaying the Scene.

#### 2b. Click-Select

**ReactFlow implementation:**
- **File:** `/home/john/xyflow/packages/react/src/components/Nodes/utils.ts` (lines 13-44)
- **Function:** `handleNodeClick()`
- Single click: calls `addSelectedNodes([id])`
- Shift+click: toggles node in/out of selection (checks `multiSelectionActive` flag in store)

**Reimplementation approach:** On click, call `scene.hitTest(point)` to find which interactive region was clicked. Manage selection state in our own store (Set of selected IDs). Shift key toggles membership.

#### 2c. selectionOnDrag vs panOnDrag

**How ReactFlow decides "this drag is a selection" vs "this drag is a pan":**

```
isSelectionActive = (selectionOnDrag && clickedOnEmptySpace) || selectionKeyPressed
```

- If `selectionOnDrag=true` and click target is the pane (not a node), start selection
- If selection key (Ctrl/Cmd) is held, always start selection regardless of target
- When selection is active, D3-zoom handlers are **destroyed** (`XYPanZoom.ts` line 111-113) — completely disabling pan/zoom during selection

**Reimplementation approach:** Same logic. When selection mode is active, call `d3ZoomInstance.on('start', null)` etc. to disable pan. When selection ends, re-attach handlers.

---

### 3. Click Propagation / didPan Prevention

**What it does:** Prevents click events from firing after a drag (pan or selection). Without this, releasing the mouse after panning would trigger a click on whatever is under the cursor.

**ReactFlow implementation (two mechanisms):**

**Mechanism A — selectionInProgress ref** (Pane, lines 87-119):
```typescript
const selectionInProgress = useRef<boolean>(false);

// During pointer move, if distance > threshold:
selectionInProgress.current = true;

// On click capture phase:
if (selectionInProgress.current) {
  event.stopPropagation();  // Kill the click
  selectionInProgress.current = false;
}
```

**Mechanism B — D3 clickDistance** (XYPanZoom.ts line 118):
```typescript
d3ZoomInstance.clickDistance(selectionOnDrag ? Infinity : paneClickDistance)
```
D3 suppresses the `click` event if the pointer moved more than `clickDistance` pixels between mousedown and mouseup. Setting to `Infinity` means D3 never fires synthetic clicks.

**Why capture phase:** Pane uses `onPointerDownCapture` and `onClickCapture` (not bubble phase). This intercepts events before they reach child node elements, preventing nodes from seeing selection-related pointer events.

**Reimplementation approach:** Use a `didDrag` flag (similar to `base.html`'s `didPan`). Set it when pointer moves beyond threshold during a pan or selection gesture. Check it in click handlers and suppress. Also use D3-zoom's built-in `clickDistance` parameter.

---

### 4. Viewport Transform & Coordinate Conversion

**What it does:** Maps between screen coordinates (mouse events) and scene coordinates (element positions).

**ReactFlow implementation:**
- **Screen → Scene** (`/home/john/xyflow/packages/system/src/utils/general.ts` line 159):
  ```
  sceneX = (screenX - tx) / tScale
  sceneY = (screenY - ty) / tScale
  ```
- **Scene → Screen** (line 173):
  ```
  screenX = sceneX * tScale + tx
  screenY = sceneY * tScale + ty
  ```
- **DOM application** (`/home/john/xyflow/packages/react/src/container/Viewport/index.tsx` line 16):
  ```
  style={{ transform: `translate(${tx}px, ${ty}px) scale(${tScale})` }}
  ```

**Reimplementation approach:** These are trivial formulas. Store `{tx, ty, tScale}` in state. Apply as CSS transform on a wrapper div containing the Scene's render element. Use the formulas for hit testing and selection rect conversion.

---

### 5. Node Measurement (ResizeObserver)

**What it does:** Measures DOM dimensions of node elements so selection hit testing knows their actual size.

**ReactFlow implementation:**
- **ResizeObserver:** `/home/john/xyflow/packages/react/src/container/NodeRenderer/useResizeObserver.ts` (lines 9-38)
- Single `ResizeObserver` per ReactFlow instance, observes all node DOM elements
- Gets node ID from `data-id` attribute on the observed element
- On resize: calls `updateNodeInternals()` which reads `offsetWidth`/`offsetHeight` and stores in `node.measured`

**Reimplementation approach:** We don't need this. Scene elements are measured via `scene.getRegionBounds()` (which calls `getBBox()` for SVG). There are no separate overlay divs to measure — the interactive regions ARE the visual elements. This is one of the main wins of removing ReactFlow.

---

## What We Don't Need to Reimplement

| ReactFlow feature | Why we don't need it |
|---|---|
| Edge rendering | Arrows/connectors are in the SVG, not separate components |
| Node dragging (XYDrag) | Elements are positioned by the Scene, not user-dragged |
| Connection system | No connecting nodes with edges |
| Handle positioning | No connection handles |
| Node type registry | No custom node components — interaction is on Scene elements |
| Zustand store (full) | We need viewport + selection state only, not the full node/edge/connection store |
| MiniMap, Controls, Background | Can reimplement trivially if needed |

## Implementation Complexity Estimate

| Feature | Lines in xyflow | Our reimplementation |
|---|---|---|
| D3-zoom setup + event handlers | ~300 (XYPanZoom + eventhandler) | ~150 (no filter complexity, no edge cases we don't hit) |
| Selection rectangle + hit testing | ~250 (Pane + getNodesInside) | ~100 (delegate to `scene.hitTestRect()`) |
| Click propagation prevention | ~50 (spread across Pane) | ~20 (single `didDrag` flag) |
| Coordinate conversion | ~30 | ~15 |
| Selection state management | ~100 (zustand actions) | ~50 (simple Set + callbacks) |
| **Total** | **~730** | **~335** |

The savings come from not needing: node measurement (Scene handles it), overlay synchronization (no overlays), the bridge layer, and ReactFlow's generalized node/edge/connection architecture.
