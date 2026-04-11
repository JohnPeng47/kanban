# tldraw Rendering Pipeline & Layer Architecture

How shapes go from store records to pixels on screen.

## Data flow: Store to DOM

```
TLStore (reactive records)
    │
    │  shape record: { id, x, y, rotation, parentId, index, props, meta }
    │
    ▼
Editor.getRenderingShapes()
    │  Depth-first traversal of parent→children tree
    │  Assigns z-index (incrementing counter)
    │  Accumulates opacity (parent * child * erasing)
    │  Allocates z-index gaps for container shapes (frames)
    │
    │  Returns: { id, shape, util, index, backgroundIndex, opacity }[]
    │           sorted by ID (not visual order — DOM stability)
    │
    ▼
<Shape> React component (one per shape, memoized)
    │
    ├── useQuickReactor ──► Direct DOM mutation (bypasses React render):
    │       │                  - transform: matrix(a,b,c,d,e,f)   ← Mat.toCssString(pageTransform)
    │       │                  - width/height                      ← geometry.bounds
    │       │                  - clip-path                         ← ancestor frame masks
    │       │                  - z-index                           ← from getRenderingShapes
    │       │
    │       └── getShapePageTransform(id)
    │             = pageTransform(parent) × localTransform(shape)
    │             = recursive Mat.Compose up the ancestor chain
    │
    └── <InnerShape> ──► util.component(shape)  → JSX
            │              (custom memo: only re-renders if props/meta changed)
            │
            └── Returns <SVGContainer> or <HTMLContainer> with shape visuals
```

## DOM layer structure

```
<div class="tl-canvas">                               z-index layers
    │                                                  ──────────────
    ├── <svg class="tl-svg-context" aria-hidden>       (not visible)
    │       └── <defs> patterns, gradients, cursors
    │
    ├── <div class="tl-background__wrapper">           100
    │       └── Background component (grid)
    │
    ├── <div class="tl-html-layer tl-shapes">          300
    │   │   CSS: 1px × 1px, overflow visible
    │   │   transform: scale(zoom) translate(camX, camY)
    │   │
    │   ├── OnTheCanvas components
    │   ├── SelectionBackground
    │   └── <ShapesLayer>
    │       ├── Shape A  (z-index: 8001)
    │       ├── Shape B  (z-index: 8002)
    │       ├── Shape C  (z-index: 8003, frame)
    │       │   └── children get z-index: 8004..12003 (4000 gap)
    │       └── Shape D  (z-index: 12004)
    │
    ├── <div class="tl-overlays">                      500
    │   ├── <canvas> CanvasShapeIndicators             (Path2D stroke)
    │   └── <div class="tl-html-layer">
    │       │   transform: scale(zoom) translate(camX, camY)
    │       │
    │       ├── Geometry debug view
    │       ├── Brush rectangle
    │       ├── Scribble paths
    │       ├── SVG shape indicators (legacy)
    │       ├── Snap lines
    │       ├── Selection foreground (resize handles)
    │       ├── Shape handles
    │       └── Live collaborator cursors
    │
    └── <div class="tl-canvas__in-front">
            └── InFrontOfTheCanvas components
```

## Camera transform application

```
Camera record: { x: -panX, y: -panY, z: zoom }
                 (negated page coordinates)

                     ┌─────────────────────────────────┐
                     │  tl-html-layer (1px × 1px div)  │
                     │                                  │
                     │  CSS transform:                  │
                     │    scale(z)                      │  ← zoom first
                     │    translate(x + offset, y + offset) │  ← then pan
                     │                                  │
                     │  (offset = zoom-dependent        │
                     │   precision stabilization)       │
                     └─────────────────────────────────┘
                                    │
            Applied to BOTH shape layer AND overlay layer
            (two separate divs, identical transform)
```

## Culling system

```
CullingController (single React component)
    │
    │  useQuickReactor ──► editor.getCulledShapes()
    │                       returns Set<TLShapeId>
    │
    ▼
ShapeCullingProvider.updateCulling(culledSet)
    │
    │  For each registered shape container:
    │    if shouldBeCulled !== wasCulled:
    │      container.style.display = culled ? 'none' : 'block'
    │
    │  O(changed shapes), not O(all shapes)
    │  One centralized pass — no per-shape subscriptions
    │
    ▼
Result: off-screen shapes hidden from layout/paint
        but still in DOM (preserves React state)
```

## ShapeUtil contract (extension point)

```
abstract class ShapeUtil<Shape>
    │
    │  MUST implement:
    │  ├── getDefaultProps(): Shape['props']
    │  ├── getGeometry(shape): Geometry2d        ← bounds + hit testing
    │  ├── component(shape): JSX                 ← visual rendering
    │  └── indicator(shape): SVG JSX             ← selection outline
    │
    │  CAN override:
    │  ├── Capabilities ──► canEdit, canResize, canBind, canSnap, canCull
    │  ├── Handles ──────► getHandles, hideResizeHandles, hideRotateHandle
    │  ├── Containers ───► getClipPath, shouldClipChild, providesBackgroundForChildren
    │  ├── Events ───────► onBeforeCreate, onBeforeUpdate, onResize, onDragShapesIn/Out
    │  ├── Export ───────► toSvg, toBackgroundSvg, getCanvasSvgDefs
    │  ├── Performance ──► getIndicatorPath (canvas Path2D instead of SVG)
    │  └── Animation ────► getInterpolatedProps
    │
    │  Concrete examples:
    │  ├── BaseBoxShapeUtil ──► GeoShapeUtil, FrameShapeUtil, ImageShapeUtil
    │  ├── ArrowShapeUtil (complex: bindings, handles, elbow routing)
    │  └── GroupShapeUtil (transparent container, auto-deletes when empty)
```

## Key file locations

```
packages/editor/src/lib/
├── components/
│   ├── Shape.tsx                          ← Shape wrapper (transform, culling)
│   └── default-components/
│       ├── DefaultCanvas.tsx              ← Layer structure, camera transform
│       ├── DefaultShapeIndicator.tsx      ← SVG indicators
│       └── CanvasShapeIndicators.tsx      ← Canvas indicators (Path2D)
├── editor/
│   ├── Editor.ts                          ← getRenderingShapes, getCulledShapes
│   └── shapes/
│       ├── ShapeUtil.ts                   ← Abstract base class
│       └── BaseBoxShapeUtil.tsx           ← Rectangle shape base
└── hooks/
    ├── useShapeCulling.tsx                ← Culling context/provider
    └── useZoomCss.ts                      ← --tl-zoom CSS variable

packages/tldraw/src/lib/shapes/
├── geo/GeoShapeUtil.tsx                   ← Rectangles, ellipses, etc.
├── arrow/ArrowShapeUtil.tsx               ← Arrows with bindings
├── frame/FrameShapeUtil.tsx               ← Container with clipping
├── group/GroupShapeUtil.tsx                ← Transparent grouping
├── draw/DrawShapeUtil.tsx                 ← Freehand drawing
├── text/TextShapeUtil.tsx                 ← Text labels
└── image/ImageShapeUtil.tsx               ← Images (with alpha hit testing)
```
