# tldraw Geometry Primitives — Reference for Adoption

## Object Hierarchy

```
                        ┌─────────────────────────────────────────────┐
                        │              Math Primitives                │
                        │                                             │
                        │   Vec          Box           Mat            │
                        │   (x,y,z)     (x,y,w,h)    (a,b,c,d,e,f)  │
                        │   point math   AABB math    2D affine xform│
                        └──────────┬──────────┬───────────┬──────────┘
                                   │          │           │
                        ┌──────────▼──────────▼───────────▼──────────┐
                        │            Geometry2d (abstract)            │
                        │                                             │
                        │  Uses Vec/Box/Mat to implement:             │
                        │  • hitTestPoint(point, margin, hitInside)   │
                        │  • distanceToPoint(point) → signed float    │
                        │  • nearestPoint(point) → Vec                │
                        │  • hitTestLineSegment(A, B, distance)       │
                        │  • intersectLineSegment / Circle / Polygon  │
                        │  • overlapsPolygon(polygon)                 │
                        │  • interpolateAlongEdge(t) → Vec            │
                        │  • vertices (lazy cached)                   │
                        │  • bounds (lazy cached Box from vertices)   │
                        │  • area, length (lazy cached)               │
                        │  • toSimpleSvgPath() → string               │
                        │  • transform(matrix) → TransformedGeometry  │
                        └───────┬──────────────────────┬─────────────┘
                                │                      │
               ┌────────────────┤                      │
               │                │                      │
    ┌──────────▼───┐  ┌────────▼────────┐   ┌─────────▼──────────────┐
    │   Edge2d     │  │   Polyline2d    │   │  TransformedGeometry2d │
    │              │  │                 │   │  (decorator)           │
    │  start, end  │  │  points: Vec[]  │   │                        │
    │  precomputed │  │  lazy segments  │   │  wraps any Geometry2d  │
    │  dx,dy,len2  │  │  (Edge2d[])    │   │  + a Mat transform     │
    └──────────────┘  └───────┬─────────┘   │                        │
                              │             │  Inverts queries into   │
                     ┌────────▼──────┐      │  local space, runs     │
                     │  Polygon2d    │      │  them on inner geom,   │
                     │  (isClosed)   │      │  transforms results    │
                     └───────┬───────┘      │  back out              │
                             │              └────────────────────────┘
                    ┌────────▼──────┐
                    │ Rectangle2d   │
                    │ (w,h shortcut)│
                    └───────────────┘

    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │  Circle2d    │  │  Ellipse2d   │  │  Arc2d       │
    │              │  │              │  │              │
    │  Analytical  │  │  Analytical  │  │  Sweep-based │
    │  nearestPt / │  │  vertex      │  │  vertex      │
    │  hitTest     │  │  sampling    │  │  sampling    │
    └──────────────┘  └──────────────┘  └──────────────┘

    ┌──────────────┐  ┌──────────────┐
    │ CubicBezier  │  │ CubicSpline  │
    │ 2d           │  │ 2d           │
    │              │  │              │
    │ Single curve │  │ Multi-segment│
    │ segment      │  │ spline       │
    └──────────────┘  └──────────────┘

    ┌──────────────────────────────────────────────────┐
    │                   Group2d                         │
    │                                                   │
    │  children: Geometry2d[]                           │
    │  Flattens nested groups on construction.          │
    │  Delegates all queries (hit test, nearest point,  │
    │  distance, intersection) across children.         │
    │  Auto-computes bounds as union of child bounds.   │
    └──────────────────────────────────────────────────┘
```

## Layer 1: Math Primitives

### Vec — 2D point / vector

A mutable class with `(x, y, z)` where `z` is typically 1 (or used as pressure for freehand drawing — **tldraw-specific, not relevant to us**).

**Dual API pattern**: every operation has both a mutating instance method and an immutable static method.

```typescript
// Mutating (chainable, zero allocations):
point.add(delta).mul(scale).rot(angle)

// Immutable (returns new Vec):
const result = Vec.Add(a, b)
```

Key methods we'd use:
- `Vec.Add`, `Vec.Sub`, `Vec.Mul`, `Vec.Div` — basic arithmetic
- `Vec.Dist(a, b)` — Euclidean distance
- `Vec.Dist2(a, b)` — squared distance (avoids sqrt, for comparisons)
- `Vec.DistMin(a, b, n)` — `dist < n` check without sqrt
- `Vec.Lrp(a, b, t)` — linear interpolation
- `Vec.Angle(a, b)` — angle from a to b
- `Vec.NearestPointOnLineSegment(a, b, p)` — parametric projection
- `Vec.DistanceToLineSegment(a, b, p)` — inlined for zero-alloc perf
- `vec.rot(r)` / `vec.rotWith(center, r)` — rotation around origin / point
- `vec.per()` — perpendicular vector (90° rotation)
- `vec.uni()` — unit vector (normalize)

**tldraw-specific concerns**:
- The `z` field is used as pen pressure for freehand drawing. The `PointsBetween()` method simulates pressure curves. These are irrelevant for our SVG diagrams.
- `Vec.Snap()` and `snapToGrid()` are for grid-snapping in a drawing tool.

### Box — Axis-aligned bounding box

A mutable class with `(x, y, w, h)`.

```typescript
const b = new Box(10, 20, 100, 50)
b.minX   // 10
b.maxX   // 110
b.midX   // 60
b.center // Vec(60, 45)
b.corners // [topLeft, topRight, bottomRight, bottomLeft] as Vec[]
b.sides   // [[Vec, Vec], ...] four edge pairs
```

Key methods we'd use:
- `box.containsPoint(v, margin)` — point-in-box with optional margin
- `box.collides(other)` — AABB overlap test
- `box.contains(other)` — strict containment
- `box.expand(other)` — mutate to union with another box
- `Box.Common(boxes[])` — union of N boxes (static)
- `Box.FromPoints(points[])` — compute AABB from point cloud
- `box.translate(delta)` — shift by a Vec

**tldraw-specific concerns**:
- `SelectionHandle`, `SelectionCorner`, `SelectionEdge` types and the `resize()` / `Resize()` methods are for drag-handle resizing in the editor UI. `rotateSelectionHandle()` and `flipSelectionHandle*()` are also editor-specific. We wouldn't need any of these.
- `getHandlePoint()` maps named handles to corner/edge midpoints — useful for a selection overlay, but not for our hit testing.

### Mat — 2D affine transformation matrix

A 6-element matrix `(a, b, c, d, e, f)` representing:
```
| a  c  e |
| b  d  f |
| 0  0  1 |
```

This is the standard CSS `matrix(a, b, c, d, e, f)` format.

```typescript
// Build transforms:
Mat.Identity()                    // no-op
Mat.Translate(x, y)               // translation only
Mat.Rotate(r)                     // rotation around origin
Mat.Rotate(r, cx, cy)             // rotation around point
Mat.Scale(sx, sy)                 // uniform or non-uniform scale
Mat.Compose(parent, child, ...)   // chain N transforms left-to-right

// Apply:
mat.applyToPoint(vec)             // transform a point
mat.applyToPoints(vecs[])         // batch transform
Mat.applyToBounds(mat, box)       // transform a Box (translation only)

// Decompose:
mat.point()                       // extract translation as Vec(e, f)
mat.rotation()                    // extract rotation angle
mat.decompose()                   // → { x, y, scaleX, scaleY, rotation }
mat.invert()                      // in-place inverse (for coord conversion)
mat.toCssString()                 // → "matrix(a, b, c, d, e, f)"
```

**The key architectural pattern**: hierarchical transforms compose via `Mat.Compose(parentPageTransform, childLocalTransform)`, and coordinate conversion between spaces uses `mat.invert().applyToPoint(pagePoint)`. This is how tldraw resolves page-space ↔ local-space for nested shapes.

Our current `Transform { tx, ty, scale }` is a strict subset — it can only express translation + uniform scale. `Mat` can express rotation, skew, and non-uniform scale. Even if we never need rotation, the `Mat` abstraction gives us `Compose` and `invert` for free, which eliminates our manual `composeTransforms()` and `(screenX - tx) / scale` formulas.

**tldraw-specific concerns**:
- `Mat.Smooth()` rounds matrix values to avoid floating-point drift in undo/redo — not relevant to us.
- The `Absolute()` static method is used for collaborative editing transforms — not relevant.

## Layer 2: Geometry2d — Abstract Shape with Queries

The abstract base class that all geometric shapes implement. Provides a **uniform query interface** independent of the underlying shape type.

### Core abstract methods (subclasses must implement):

```typescript
abstract getVertices(filters: Geometry2dFilters): Vec[]
abstract nearestPoint(point: VecLike): Vec
abstract getSvgPathData(first: boolean): string
```

### Lazy-cached derived properties:

Every `Geometry2d` lazily computes and caches `vertices`, `bounds`, `area`, and `length` on first access. This means repeated hit tests against the same geometry don't recompute bounds.

```typescript
// Computed once, cached:
geom.vertices   // → Vec[] (from getVertices)
geom.bounds     // → Box (from Box.FromPoints(vertices))
geom.area       // → number (shoelace formula over vertices)
geom.length     // → number (perimeter from vertex-to-vertex distances)
```

### Hit testing pipeline:

```typescript
// 1. Point hit test (default implementation):
hitTestPoint(point, margin = 0, hitInside = false) {
  // If closed+filled and point is inside polygon → true
  if (this.isClosed && (this.isFilled || hitInside) && pointInPolygon(point, this.vertices))
    return true
  // Otherwise check distance to nearest edge
  return Vec.Dist2(point, this.nearestPoint(point)) <= margin * margin
}

// 2. Signed distance (negative = inside):
distanceToPoint(point, hitInside = false) {
  const dist = Vec.Dist(point, this.nearestPoint(point))
  const inside = this.isClosed && (this.isFilled || hitInside) && pointInPolygon(point, this.vertices)
  return inside ? -dist : dist
}

// 3. Line segment hit test (for brush selection):
hitTestLineSegment(A, B, distance = 0) {
  return this.distanceToLineSegment(A, B) <= distance
}
```

**Why signed distance matters**: it lets you distinguish "clicked inside a filled rect" (distance = -5) from "clicked near the border of an unfilled rect" (distance = 3). For our SVG diagrams, this means we can hit-test both filled shapes and stroke-only paths with a single API — just vary the `margin` parameter.

### The `isFilled` / `isClosed` flags:

These two booleans control hit testing behavior:
- `isClosed = true` + `isFilled = true` → clicks anywhere inside the shape register as hits
- `isClosed = true` + `isFilled = false` → only clicks near the perimeter register (within `margin`)
- `isClosed = false` → open path, only clicks near the line segments register

For our SVG diagrams, reflow groups with backgrounds would be `isFilled = true`, stroke-only borders would be `isFilled = false`.

### The filter system:

`Geometry2dFilters` controls which sub-geometries participate in queries:
```typescript
{ includeLabels?: boolean, includeInternal?: boolean }

// Predefined:
EXCLUDE_NON_STANDARD  // skip labels + internal
INCLUDE_ALL           // include everything
EXCLUDE_LABELS        // default for most queries
EXCLUDE_INTERNAL      // include labels, skip internal
```

**tldraw-specific concerns**: The label/internal distinction exists because tldraw shapes can have text labels embedded as sub-geometries (e.g., an arrow with a label). The label geometry is excluded from most hit tests so clicking near a label selects the arrow, not the label. For our diagrams, we might not need this distinction — but it's a clean pattern if we ever have compound elements (a box with a title region).

## Layer 3: Concrete Geometries

### Edge2d — Single line segment

The atomic unit. Precomputes `dx`, `dy`, `len²` on construction for zero-allocation `nearestPoint` and `distanceToPoint`.

```typescript
const edge = new Edge2d({ start: new Vec(0, 0), end: new Vec(100, 50) })
edge.nearestPoint({ x: 30, y: 60 })  // → Vec on the segment
edge.distanceToPoint({ x: 30, y: 60 }) // → scalar
```

Performance detail: `nearestPoint` uses parametric t-projection (`t = dot(AP, AB) / dot(AB, AB)`) with clamping, entirely inlined (no intermediate Vec allocations).

### Polyline2d → Polygon2d → Rectangle2d

Inheritance chain:
```
Polyline2d(points[])   — open path, isClosed = false
  └─ Polygon2d(points[]) — forces isClosed = true
       └─ Rectangle2d(w, h) — generates 4 corner points, overrides getBounds() for O(1)
```

`Polyline2d` lazily constructs `Edge2d[]` segments. Its `nearestPoint()` iterates all segments with fully inlined math (no per-segment Vec allocation).

`Rectangle2d` is an optimization: instead of computing bounds from 4 vertices, it returns `new Box(x, y, w, h)` directly.

### Circle2d — Analytical circle

Does NOT inherit from Polygon2d. Overrides `nearestPoint`, `distanceToPoint`, and `hitTestPoint` with analytical formulas (no vertex iteration). `getVertices()` samples the perimeter into N points for polygon-based queries that need vertices (intersection tests).

`hitTestPoint` uses squared-distance comparisons throughout — zero sqrt calls.

### Group2d — Composite geometry

The composite pattern. Takes `children: Geometry2d[]`, **flattens nested groups** on construction, and delegates all queries:

```typescript
// Construction flattens:
new Group2d({ children: [rect, Group2d([circle, edge])] })
// Internal: children = [rect, circle, edge]  (flat)

// Queries delegate:
group.hitTestPoint(p, margin, hitInside)
  → children.find(c => c.hitTestPoint(p, margin, hitInside))

group.nearestPoint(p)
  → children.map(c => c.nearestPoint(p)), pick closest

group.distanceToPoint(p)
  → children.map(c => c.distanceToPoint(p)), pick smallest

group.bounds
  → Box.FromPoints(children.flatMap(c => c.boundsVertices))
```

Groups auto-clean: `ignore` flag on children moves them to `ignoredChildren` (excluded from queries but preserved for reference).

### TransformedGeometry2d — The decorator

This is the most architecturally significant class. It wraps any `Geometry2d` + a `Mat` transform, creating a geometry that exists in a different coordinate space **without modifying the original**.

```typescript
const rect = new Rectangle2d({ width: 100, height: 50, isFilled: true })
const rotated = rect.transform(Mat.Rotate(Math.PI / 4))
// rotated is a TransformedGeometry2d

// All queries work in the outer (transformed) space:
rotated.hitTestPoint(pageSpacePoint)
// Internally: inverse-transforms point → local space, queries rect, transforms result back
```

**The key insight**: it precomputes `Mat.Inverse(matrix)` and `Mat.Decompose(matrix)` once. Every query method:
1. Transforms input points from outer space → inner space via the inverse matrix
2. Delegates to the wrapped geometry
3. Transforms output points back to outer space

Margins/distances are scaled by `decomposed.scaleX` to remain correct after transformation.

**Limitation**: asserts `scaleX ≈ scaleY` (uniform scale only). Non-uniform scaling would require different margin scaling per axis.

**Chaining**: calling `.transform()` on a `TransformedGeometry2d` composes the matrices (`Mat.Multiply(newTransform, existingMatrix)`) rather than nesting decorators. This keeps the chain flat.

## How tldraw Wires These Together

In tldraw, each shape has a `ShapeUtil` with a `getGeometry(shape): Geometry2d` method. The editor then uses these geometries for:

1. **Hit testing** — `editor.getShapeAtPoint(point)` calls `geom.hitTestPoint()` on each shape
2. **Bounds computation** — `editor.getShapeBounds(shape)` reads `geom.bounds`
3. **Brush selection** — `geom.overlapsPolygon(brushVertices)` checks overlap
4. **Arrow binding** — `geom.nearestPoint(anchorPoint)` finds where to connect
5. **Clip masking** — frame geometry provides clip polygon for children

The `TransformedGeometry2d` decorator is used when building `Group2d` for group shapes — each child's geometry is wrapped with the child's local transform so the group can query them all in a unified coordinate space.

---

## Why We Should Adopt This

### 1. It replaces scattered utility code with a single coherent abstraction

Our current approach uses plain `Rect` objects and standalone functions like `composeTransforms()`, `rectContains()`, `rectsIntersect()`, and `(screenX - tx) / scale` formulas. These are spread across the Scene interface, the ReflowEngine, and the InteractionLayer. tldraw's primitives consolidate all of this:

- `Rect` → `Box` (same data, but with `.containsPoint()`, `.collides()`, `.contains()`, `.expand()`, `.center`, `.corners`, `.sides` built in)
- `Point` → `Vec` (same data, but with distance, interpolation, rotation, projection built in)
- `Transform { tx, ty, scale }` → `Mat` (superset — can express rotation/skew if needed, and `.invert()` / `.applyToPoint()` / `.toCssString()` / `Compose()` replace our manual formulas)

### 2. Geometry2d decouples hit testing from the DOM

Our `SvgScene.hitTest()` walks the SVG DOM via `.closest()`. This works but ties us to SVG. With `Geometry2d` per SceneElement:

- Hit testing works without DOM access (enables potential canvas/WebGL backends, or headless testing)
- We get **signed distance** for free — distinguishing "inside a filled rect" from "near the border of a stroke"
- We can adjust click tolerance with the `margin` parameter instead of inflating SVG hit areas
- Brush selection becomes `geom.overlapsPolygon(selectionRect.corners)` instead of computing rect intersections manually

### 3. TransformedGeometry2d solves the coordinate-space problem elegantly

When our ReflowEngine moves groups, child elements' screen positions change. If we want to hit-test a child element, we currently need to walk up the DOM to compose transforms manually. `TransformedGeometry2d` handles this — wrap a geometry with the element's page transform and all queries work in page space automatically. The inverse matrix math is precomputed once.

### 4. Lazy caching prevents redundant computation

Every `Geometry2d` caches `vertices`, `bounds`, `area`, and `length` on first access. In our current architecture, calling `getBBox()` on SVG elements re-measures from the DOM each time. With cached geometry objects, repeated queries during a single reflow pass are free after the first call.

### 5. The performance patterns are production-proven

tldraw runs these primitives on every frame during drawing/selection with hundreds of shapes. The codebase includes deliberate micro-optimizations:
- `Vec.Dist2()` avoids sqrt for distance comparisons
- `Edge2d` precomputes `dx`, `dy`, `len²` to avoid per-query recomputation
- `Circle2d.hitTestPoint()` uses squared-distance throughout (zero sqrt calls)
- `Polyline2d.nearestPoint()` fully inlines the parametric projection (no per-segment Vec allocation)

These aren't premature optimizations — they're necessary for real-time interaction and they come for free with adoption.

### 6. Group2d maps directly to our SceneElement tree

Our SceneElements form a tree where reflow groups contain child elements. `Group2d` is exactly this pattern — a composite geometry that delegates queries to children. When the ReflowEngine needs to answer "does this click land inside this reflow group or any of its contents?", a `Group2d` gives us the answer in one call.

### 7. The cost of adoption is low

These primitives have no external dependencies — they're pure math classes that depend only on each other. `Vec`, `Box`, `Mat`, and the `Geometry2d` hierarchy are self-contained in `packages/editor/src/lib/primitives/`. We can extract and adapt them without pulling in tldraw's reactive state system, store, or editor infrastructure.

The main adaptation needed: strip tldraw-specific features (pen pressure on Vec.z, selection handles on Box, label/internal filters on Geometry2d) to keep the API surface minimal for our use case.
