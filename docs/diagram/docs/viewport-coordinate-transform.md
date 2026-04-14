# Viewport & Coordinate Transform

## Overview

The `Viewport` component is the pan/zoom container for the diagram. It wraps the Scene's SVG element in a CSS-transformed `<div>` and converts pointer events between screen and scene coordinate spaces.

## Architecture

```
#comment: keep this diagram
#comment: we should also add coordinate systems to this
+--------------------------------------------------+
|  Container div  (overflow: hidden, touch-none)    |
|  ┌──────────────────────────────────────────────┐ |
|  │  Transform div  (CSS transform applied here) │ |
|  │  ┌──────────────────────────────────────────┐ │ |
|  │  │  SVG element  (scene.getSvgElement())    │ │ |
|  │  └──────────────────────────────────────────┘ │ |
|  └──────────────────────────────────────────────┘ |
|  OverLayer (badges, z-index 10)                   |
|  Selection rect overlay (when lasso active)       |
|  {children}                                       |
+--------------------------------------------------+
```

The container clips the visible area. The transform div receives a CSS `translate(tx, ty) scale(scale)` with `transform-origin: 0 0`. The SVG itself has no `viewBox` — `SvgScene` strips it at construction and sets explicit `width`/`height` for 1:1 rendering.

## Coordinate Spaces

| Space       | Origin                        | Usage                                                |
|-------------|-------------------------------|------------------------------------------------------|
| **Screen**  | Browser viewport top-left     | Pointer events (`clientX`, `clientY`)                |
| **Container** | Viewport container top-left | Intermediate: screen minus container offset          |
| **Scene**   | SVG coordinate origin (0,0)   | Element positions, bounds, hit-test results          |

## Transform

The viewport state is a single `Transform` value stored in `transformRef`:

```ts
interface Transform {
  tx: number;   // horizontal translation (pixels)
  ty: number;   // vertical translation (pixels)
  scale: number; // uniform zoom factor
}
```

Applied to the transform div as: `translate(${tx}px, ${ty}px) scale(${scale})`

The root Scene element's transform is kept in sync via `syncRootTransform()` so that `scene.getWorldBounds()` and `scene.getWorldTransform()` produce correct results for overlay positioning and hit testing.

## Screen-to-Scene Conversion

```
screenToScene(screenPoint):
  containerX = screenPoint.x - container.rect.left
  containerY = screenPoint.y - container.rect.top
  sceneX = (containerX - tx) / scale
  sceneY = (containerY - ty) / scale
```

The inverse (scene-to-screen, used by `centerOn` and the OverLayer) is:

```
screenX = sceneX * scale + tx
screenY = sceneY * scale + ty
```

## Pan

Normal pointer drag (no modifier keys):

1. `pointerDown` records start position + current transform snapshot
2. `pointerMove` computes delta from start, applies: `tx = start.tx + dx`, `ty = start.ty + dy`
3. Drag threshold of 4px prevents accidental pans from clicks

## Wheel Zoom

Zoom pivots around the cursor position so the point under the cursor stays fixed:

```
newScale = clamp(MIN_SCALE, scale * (1 + delta), MAX_SCALE)
newTx = cursorX - (cursorX - tx) * (newScale / scale)
newTy = cursorY - (cursorY - ty) * (newScale / scale)
```

Scale range: 0.1 to 5. Sensitivity: `0.002` per pixel of wheel delta.

## Pinch-to-Zoom (Multi-touch)

When a second pointer arrives:

1. Record initial distance, midpoint, and transform snapshot
2. On move, compute `scaleFactor = currentDistance / startDistance`
3. New scale = `startScale * scaleFactor`, clamped to [0.1, 5]
4. Zoom pivots around the pinch midpoint, plus a pan offset for midpoint drift
5. Pinch ends when a finger lifts; no click fires after a pinch gesture

## Programmatic Navigation (`centerOn`)

The imperative `ViewportHandle.centerOn(scenePoint, opts?)` pans/zooms so that `scenePoint` appears at the container center:

```
tx = containerWidth/2 - scenePoint.x * scale
ty = containerHeight/2 - scenePoint.y * scale
```

With `animate: true`, applies a 220ms CSS transition.

## Selection Lasso

Ctrl+drag (desktop) or selectMode+touch draws a screen-space rectangle:

1. Start and current screen positions define the rect
2. Both endpoints are converted to scene space and passed to `onSelectionDrag(sceneRect)`
3. On pointer up, `onSelectionDragEnd(sceneRect)` fires with the final rect
4. The visual overlay is a semi-transparent accent-colored div with `pointer-events: none`
5. File path labels from selected elements display to the left of the lasso box

---

## Source References

```
web-ui/src/diagram/rendering/viewport.tsx
  L15-18    Constants: ZOOM_SENSITIVITY, MIN_SCALE, MAX_SCALE, DRAG_THRESHOLD
  L17-44    ViewportSceneEvent, ViewportProps, ViewportHandle interfaces
  L46-463   Viewport component
  L62-64    Refs: containerRef, transformDivRef, transformRef
  L78-88    SVG mount/unmount effect
  L90-96    applyTransform — writes CSS transform string
  L98-107   screenToScene — coordinate conversion
  L110-115  syncRootTransform — keeps Scene root in sync
  L118-148  centerOn imperative handle
  L151-176  Wheel zoom effect
  L178-196  Pinch helpers: getPointerDistance, getPointerMidpoint
  L198-233  onPointerDown — pan/pinch/selection initiation
  L235-334  onPointerMove — pinch zoom, selection lasso, pan
  L338-399  onWindowPointerUp — click dispatch, selection end, cleanup
  L419-463  JSX: container > transformDiv > SVG, OverLayer, selection overlay

web-ui/src/diagram/types.ts
  L17-22    Transform interface
  L12-15    Point interface
  L4-9      Rect interface
  L203-210  composeTransforms
  L212-220  transformRect
```
