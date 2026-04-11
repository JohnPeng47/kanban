# tldraw Geometry Primitives & Hit Testing

The math layer that underlies all spatial operations.

## Primitive class hierarchy

```
VecLike (interface: { x, y, z? })
    │
    ▼
Vec (class, mutable instance + immutable static)
    ├── Instance methods (mutate self, return this for chaining):
    │   add, sub, mul, div, rot, rotWith, per, uni, tan, lrp, set, setTo
    │
    ├── Static methods (return new Vec):
    │   Add, Sub, Mul, Div, Rot, RotWith
    │   Dist, Dist2 (squared — avoids sqrt for comparisons)
    │   Dpr (dot), Cpr (cross), Len, Len2
    │   Angle, AngleBetween, FromAngle, ToAngle
    │   NearestPointOnLineSegment, DistanceToLineSegment
    │   Lrp (lerp), Med (median), Average, PointsBetween
    │   Equals (epsilon 0.0001), EqualsXY (exact)
    │
    └── z component = pressure (for drawing), default 1


BoxLike (interface: { x, y, w, h })
    │
    ▼
Box (class, mutable)
    ├── Getters: minX/maxX/midX, minY/maxY/midY, center, corners,
    │            cornersAndCenter, sides, size, aspectRatio
    │
    ├── Mutation: expand(box), expandBy(n), translate(delta), resize(handle, dx, dy)
    │
    ├── Static: FromPoints, FromCenter, Common (union all),
    │           Collides, Contains, ContainsPoint, ExpandBy
    │
    └── Box.Resize(box, handle, dx, dy, isAspectLocked)
        → returns { box, scaleX, scaleY }  (handles flipping)


MatLike (interface: { a, b, c, d, e, f })
    │                    ┌       ┐
    ▼                    │ a c e │   2D affine:
Mat (class, mutable)     │ b d f │   (a,b,c,d) = linear transform
    │                    │ 0 0 1 │   (e,f) = translation
    │                    └       ┘
    ├── Instance (mutate self): multiply, translate, rotate, scale, invert
    │
    ├── Static: Identity, Translate, Rotate, Scale, Inverse, Multiply
    │           Compose(...matrices)  ← chains left-to-right
    │           Decompose → { x, y, scaleX, scaleY, rotation }
    │           applyToPoint, applyToPoints, applyToBounds
    │           toCssString → "matrix(a, b, c, d, e, f)"
    │
    └── Composition: Mat.Compose(parent, child) = parent × child
        Apply: point_page = Mat.applyToPoint(pageTransform, point_local)
        Invert: point_local = Mat.applyToPoint(pageTransform.invert(), point_page)
```

## Geometry2d class hierarchy

```
Geometry2d (abstract base)
    │
    │  Core cached properties (lazy, computed once):
    │  ├── vertices: Vec[]          ← polygonal approximation
    │  ├── bounds: Box              ← AABB from vertices
    │  ├── area: number             ← shoelace formula
    │  ├── length: number           ← perimeter
    │  └── center: Vec              ← bounds.center
    │
    │  Flags:
    │  ├── isClosed: boolean        ← polygon (filled) vs polyline (stroke only)
    │  ├── isFilled: boolean        ← interior is solid for hit testing
    │  ├── isLabel: boolean         ← can be excluded via filters
    │  ├── ignore: boolean          ← excluded from Group2d queries
    │  └── debugColor: string
    │
    │  Abstract (subclass must implement):
    │  ├── getVertices(): Vec[]
    │  ├── nearestPoint(point): Vec
    │  └── getSvgPathData(): string
    │
    │  Hit testing:
    │  ├── hitTestPoint(point, margin, hitInside)
    │  │     1. if closed+filled: pointInPolygon(point, vertices) → true
    │  │     2. else: Vec.Dist2(point, nearestPoint) <= margin²
    │  │
    │  ├── hitTestLineSegment(A, B, distance)
    │  │     → distanceToLineSegment(A, B) <= distance
    │  │
    │  ├── distanceToPoint(point)
    │  │     → signed: negative if inside filled shape
    │  │
    │  └── distanceToLineSegment(A, B)
    │        → min distance from any edge to segment [A,B]
    │
    │  Intersection:
    │  ├── intersectLineSegment(A, B)
    │  ├── intersectCircle(center, radius)
    │  └── intersectPolygon(points[])
    │
    │  Edge queries:
    │  ├── interpolateAlongEdge(t) → point at fraction t of perimeter
    │  └── uninterpolateAlongEdge(point) → t fraction of nearest point
    │
    │  Transform:
    │  └── transform(matrix) → TransformedGeometry2d (decorator)
    │
    ├── Edge2d
    │     start, end, precomputed dx/dy/len2
    │     nearestPoint: parametric t = dot(P-start, delta)/len2, clamp [0,1]
    │
    ├── Polyline2d
    │   │ _points: Vec[], lazy _segments: Edge2d[]
    │   │ nearestPoint: iterate segments, track closest
    │   │
    │   └── Polygon2d (extends Polyline2d, isClosed = true)
    │       │ Validates >= 3 points
    │       │
    │       └── Rectangle2d
    │             Stores _x, _y, _w, _h directly
    │             Overrides getBounds() for exact box (no vertex computation)
    │
    ├── Circle2d
    │     center, radius
    │     nearestPoint: direction from center, scale by radius
    │     hitTestPoint: squared distance < (radius + margin)²  (no sqrt!)
    │     getVertices: polygonal approximation (N sides based on perimeter)
    │
    ├── Group2d (composite)
    │     Recursively flattens nested Group2d children in constructor
    │     Delegates all queries to children via iteration
    │     No bounds caching — computed fresh from children
    │     Used for: shapes with multiple geometric parts (body + label)
    │
    └── TransformedGeometry2d (decorator)
          Wraps geometry + Mat, precomputes inverse + decomposition
          Every query:
            1. Transform input to original space (via inverse)
            2. Delegate to wrapped geometry
            3. Transform output to transformed space
            4. Adjust distances by decomposed.scaleX
          Composable: transform(newMat) → new wrapper with Mat.Multiply(new, existing)
```

## Hit test pipeline (pointer click → shape)

```
Pointer event at screen position (sx, sy)
    │
    │  editor.screenToPage(point)
    │  formula: px = (sx - screenBounds.x) / zoom - cameraX
    │           py = (sy - screenBounds.y) / zoom - cameraY
    │
    ▼
editor.getShapeAtPoint(pagePoint, opts)
    │
    │  opts: { margin, hitInside, hitLabels, renderingOnly }
    │
    ├── 1. SPATIAL INDEX QUERY (broad phase)
    │      _spatialIndex.getShapeIdsAtPoint(point, searchMargin)
    │      └── RBush R-tree: O(log n) AABB intersection
    │          Returns candidate shape IDs (typically 5-20)
    │
    ├── 2. SORT CANDIDATES by z-order (top to bottom)
    │
    ├── 3. FOR EACH CANDIDATE (narrow phase):
    │   │
    │   ├── Skip if hidden, locked, or filtered out
    │   │
    │   ├── Check shape mask (ancestor frame clipping):
    │   │   pageMask = intersect all ancestor clip polygons
    │   │   if pageMask && !pointInPolygon(point, pageMask) → skip
    │   │
    │   ├── Convert to shape local space:
    │   │   localPoint = pageTransform.invert().applyToPoint(pagePoint)
    │   │
    │   ├── Get geometry: editor.getShapeGeometry(shape)
    │   │
    │   ├── Frame label special case:
    │   │   if frame → check label geometry first (outside bounds)
    │   │
    │   ├── Geometry hit test:
    │   │   distance = geometry.distanceToPoint(localPoint)
    │   │   │
    │   │   ├── distance < 0 (inside filled shape):
    │   │   │   Check geometry.ignoreHit(point) → skip if transparent pixel
    │   │   │   → RETURN this shape (immediate for filled)
    │   │   │
    │   │   ├── |distance| < margin (within tolerance):
    │   │   │   Track closest-to-edge shape as fallback
    │   │   │
    │   │   └── distance > margin: miss
    │   │
    │   └── Frame interior special case:
    │       if inside frame bounds → block click-through to shapes behind
    │
    └── 4. RETURN: first filled hit, OR closest-edge hollow shape, OR frame interior

            ▼
    getOutermostSelectableShape(hitShape)
        Walk ancestors until topmost group (respecting focused group boundary)
        → This is what actually gets selected
```

## Brush selection algorithm

```
User drags from origin to current point
    │
    ▼
brushBox = Box.FromPoints([origin, current])
    │
    │  Spatial index: candidateIds = getShapeIdsInsideBounds(brushBox)
    │
    ▼
For each candidate:
    │
    ├── WRAP MODE (default, no Ctrl):
    │     brushBox.contains(shapeBounds) → must fully enclose
    │
    └── INTERSECTION MODE (Ctrl held):
          brushBox.collides(shapeBounds)?
            │
            ├── Transform brush corners to shape local space
            │   localCorners = pageTransform.invert().applyToPoints(brush.corners)
            │
            └── Test 4 brush edges as line segments against geometry:
                  for i in 0..3:
                    A = localCorners[i]
                    B = localCorners[(i+1) % 4]
                    if geometry.hitTestLineSegment(A, B, 0) → SELECT
```

## Spatial index (RBush R-tree)

```
┌─────────────────────────────────────────────────┐
│ SpatialIndexManager                             │
│                                                 │
│  Reactive computed cache:                       │
│  ┌─────────────────────────────────────┐        │
│  │ On shape added:   upsert bounds    │        │
│  │ On shape moved:   upsert bounds    │        │
│  │ On shape deleted: remove           │        │
│  │ On dependency change: recheck      │        │
│  │                                     │        │
│  │ Incremental via filterHistory diffs │        │
│  │ Bulk load on first page render      │        │
│  └─────────────────────────────────────┘        │
│                                                 │
│  RBush stores: { minX, minY, maxX, maxY, id }  │
│  search(bounds) → Set<TLShapeId>    O(log n)   │
│  getShapeIdsAtPoint(p, margin) → Set  O(log n) │
└─────────────────────────────────────────────────┘
```

## Key file locations

```
packages/editor/src/lib/primitives/
├── Vec.ts                     ← Vector math (dual API)
├── Box.ts                     ← AABB bounding box
├── Mat.ts                     ← 2D affine matrix
├── intersect.ts               ← Line/circle/polygon intersections
├── utils.ts                   ← pointInPolygon, angles, precision
└── geometry/
    ├── Geometry2d.ts          ← Abstract base (hit test contract)
    ├── Edge2d.ts              ← Line segment
    ├── Polyline2d.ts          ← Open path
    ├── Polygon2d.ts           ← Closed path
    ├── Rectangle2d.ts         ← Optimized rectangle
    ├── Circle2d.ts            ← Circle (polygonal approx)
    └── Group2d.ts             ← Composite geometry

packages/editor/src/lib/editor/
├── Editor.ts                  ← getShapeAtPoint, screenToPage
└── managers/SpatialIndexManager/
    ├── SpatialIndexManager.ts ← Reactive cache
    └── RBushIndex.ts          ← R-tree wrapper
```
