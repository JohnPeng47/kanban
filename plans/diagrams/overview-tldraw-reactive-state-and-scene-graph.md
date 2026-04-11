# tldraw Reactive State, Store & Scene Graph

How data flows through the system: records, reactivity, hierarchy, and transforms.

## Reactive primitives (@tldraw/state)

```
┌──────────────────────────────────────────────────────────────┐
│                    REACTIVE LAYER                            │
│                                                              │
│  Atom<T>                    Computed<T>                      │
│  ─────────                  ────────────                     │
│  Mutable leaf value         Derived value (lazy)             │
│                                                              │
│  atom('name', initial)      computed('name', (prev, epoch)   │
│  .get()  → T (+ capture)     => { ... return T })           │
│  .set(v) → notify children  .get() → T (recalc if stale)    │
│  .update(fn)                                                 │
│                              Tracks parent signals auto-     │
│  Epoch tracking:             matically via get() calls.      │
│  lastChangedEpoch bumps      Only recalculates when a        │
│  on every .set()             parent's epoch > last seen.     │
│                                                              │
│  EffectScheduler / react()                                   │
│  ─────────────────────────                                   │
│  Side-effect that re-runs when dependencies change.          │
│  Captures parents during execute(), schedules re-run         │
│  when any parent changes.                                    │
│                                                              │
│  transaction(() => { ... })                                  │
│  ─────────────────────────                                   │
│  Batches multiple atom.set() calls.                          │
│  Reactions only fire once at end (not per-set).              │
│  Supports rollback on error.                                 │
│                                                              │
│  Dependency tracking:                                        │
│  atom.get() inside computed/effect → auto-captured as parent │
│  No manual subscribe/unsubscribe needed.                     │
└──────────────────────────────────────────────────────────────┘
```

## Store architecture (@tldraw/store)

```
TLStore
    │
    │  records: AtomMap<RecordId, Record>
    │  │   Outer atom: tracks key additions/removals
    │  │   Inner atoms: one per record, tracks value changes
    │  │   → Fine-grained reactivity (change to shape A
    │  │     doesn't invalidate anything watching shape B)
    │  │
    │  ├── .put([records])       ← add or update (upsert)
    │  ├── .remove([ids])        ← delete
    │  ├── .get(id)              ← reactive read
    │  ├── .has(id)              ← reactive existence check
    │  └── .unsafeGetWithoutCapture(id)  ← non-reactive read
    │
    │  history: Atom<number, RecordsDiff>
    │  │   Every put/remove appends a diff: { added, updated, removed }
    │  │   Derivations use getDiffSince(epoch) for incremental updates
    │  │
    │  query: StoreQueries
    │  │   .ids('shape')                → reactive Set<TLShapeId>
    │  │   .index('shape', 'parentId')  → reactive Map<parentId, Set<id>>
    │  │   .filterHistory('shape')      → only diffs for shape records
    │  │   .records('shape', filter)    → reactive filtered array
    │  │
    │  sideEffects: StoreSideEffects
    │       .register({ shape: { afterChange: (before, after) => ... } })
    │       Used by binding system to react to shape movements
    │
    │  Record types (TLRecord union):
    │  ├── TLShape    { id, type, x, y, rotation, parentId, index, props, meta }
    │  ├── TLBinding  { id, type, fromId, toId, props, meta }
    │  ├── TLPage     { id, name, index, meta }
    │  ├── TLCamera   { id, x, y, z, meta }           ← per-page
    │  ├── TLInstance  { selectedShapeIds, currentPageId, ... }  ← session
    │  └── TLAsset    { id, type, props, meta }
    │
    │  Scopes:
    │  ├── 'document'  → synced across clients (shapes, bindings, pages)
    │  ├── 'session'   → local to tab (instance, camera)
    │  └── 'presence'  → ephemeral (cursor position, selections)
    │
    └── Migration system: schema versions + migration sequences
```

## Scene graph: parent-child hierarchy

```
TLPage (root container)
    │
    │  parentId: 'page:xxx'
    │
    ├── Shape A (index: 'a1')
    │     parentId: 'page:xxx'
    │     x, y in page space
    │
    ├── Frame B (index: 'a2')            ← container with clipping
    │   │ parentId: 'page:xxx'
    │   │ props: { w: 800, h: 600 }
    │   │ x, y in page space
    │   │
    │   ├── Shape C (index: 'a1')        ← child of frame
    │   │     parentId: 'shape:B'
    │   │     x, y in Frame B's local space
    │   │
    │   └── Group D (index: 'a2')        ← transparent container
    │       │ parentId: 'shape:B'
    │       │
    │       ├── Shape E (index: 'a1')
    │       │     parentId: 'shape:D'
    │       │     x, y in Group D's local space
    │       │
    │       └── Shape F (index: 'a2')
    │             parentId: 'shape:D'
    │
    └── Shape G (index: 'a3')
          parentId: 'page:xxx'


    Index ordering within each parent:
    'a0' < 'a0V' < 'a1' < 'a1L' < 'a2' < 'a3'
    (fractional string keys — can insert infinitely between any two)
```

## Reactive derivations (incremental indexes)

```
Store changes (put/remove)
    │
    │  history atom bumps epoch, appends RecordsDiff
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ parentsToChildren (computed)                            │
│                                                         │
│  Input: store.query.filterHistory('shape')              │
│                                                         │
│  On first access:                                       │
│    Build full map: Record<TLParentId, TLShapeId[]>      │
│    Sort each array by shape.index                       │
│                                                         │
│  On subsequent access:                                  │
│    diff = filterHistory.getDiffSince(lastEpoch)         │
│    │                                                    │
│    ├── diff === RESET_VALUE → full rebuild              │
│    ├── diff.length === 0   → return lastValue (no-op)  │
│    └── diff has changes    → patch:                     │
│          added:   insert id into parent's array         │
│          removed: remove id from parent's array         │
│          updated: if parentId changed, move between     │
│                   arrays; if index changed, re-sort     │
│                                                         │
│  Output: Record<TLParentId, TLShapeId[]> (sorted)      │
│  Used by: getSortedChildIdsForParent(parentId)          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ bindingsIndex (computed)                                │
│                                                         │
│  Maps: TLShapeId → TLBinding[]                          │
│  Both fromId and toId indexed                           │
│  O(1) lookup: "what bindings involve this shape?"       │
│                                                         │
│  Same incremental pattern: getDiffSince → patch         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ shapeIdsInCurrentPage (computed)                        │
│                                                         │
│  Returns: Set<TLShapeId> for active page only           │
│  Resets on page switch, incremental within page         │
│  Uses IncrementalSetConstructor for efficient diffs     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ pageTransformCache (computed per shape)                 │
│                                                         │
│  Recursive:                                             │
│    if parent is page → localTransform(shape)            │
│    else → Mat.Compose(                                  │
│              pageTransformCache.get(parentId),           │
│              localTransform(shape)                       │
│           )                                             │
│                                                         │
│  localTransform = Mat.Identity()                        │
│                     .translate(shape.x, shape.y)        │
│                     .rotate(shape.rotation)             │
│                                                         │
│  Cached per shape; invalidated when shape or any        │
│  ancestor changes (via reactive dependency chain)       │
└─────────────────────────────────────────────────────────┘
```

## Transform coordinate spaces

```
                    Page Space (absolute)
                    ┌──────────────────────────────────────┐
                    │                                      │
                    │   Frame B at (200, 100) rot 0        │
                    │   ┌──────────────────────┐           │
                    │   │                      │           │
                    │   │  Shape C at (50, 30) │           │
                    │   │  in Frame B's local  │           │
                    │   │                      │           │
                    │   └──────────────────────┘           │
                    │                                      │
                    └──────────────────────────────────────┘

    Shape C's page position = (250, 130)
    Computed as: pageTransform(B) × localTransform(C)
                 translate(200,100) × translate(50,30)

    To convert page point → Shape C's local space:
      localPoint = pageTransform(C).invert().applyToPoint(pagePoint)

    To convert Shape C local point → page space:
      pagePoint = pageTransform(C).applyToPoint(localPoint)

    Three levels:
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │ Local Space  │ ×  │ Parent      │ =  │ Page Space  │
    │ shape.x,y    │    │ Transform   │    │ (absolute)  │
    │ shape.rot    │    │ (recursive) │    │             │
    └─────────────┘    └─────────────┘    └─────────────┘
                                               │
                                               │ × camera
                                               ▼
                                          ┌─────────────┐
                                          │ Screen Space│
                                          │ (pixels)    │
                                          └─────────────┘
```

## Reparenting (preserving visual position)

```
Move Shape C from Frame B to Page root:

1. Get Shape C's page transform:
   pagePoint = pageTransform(C).point()  → (250, 130)
   pageRotation = pageTransform(C).rotation()

2. Get new parent's (page) page transform:
   parentTransform = Mat.Identity()  (pages have no transform)

3. Invert new parent transform:
   invertedParent = parentTransform.invert()  → Identity

4. Convert to new parent's local space:
   newX, newY = invertedParent.applyToPoint(pagePoint)  → (250, 130)
   newRotation = pageRotation - parentRotation  → same

5. Update shape record:
   { parentId: 'page:xxx', x: 250, y: 130, rotation: same, index: newIndex }

Result: Shape C appears in same position on screen despite parent change.
```

## React integration (@tldraw/state-react)

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  track(Component)                                       │
│  ─────────────────                                      │
│  Wraps component so all .get() calls during render      │
│  are auto-tracked. Component re-renders when any        │
│  accessed signal changes.                               │
│                                                         │
│  useValue(signal)                                       │
│  ─────────────────                                      │
│  Subscribe to a single signal. Uses React's             │
│  useSyncExternalStore for tear-free reads.              │
│                                                         │
│  useComputed('name', fn, deps)                          │
│  ─────────────────────────────                          │
│  Create a computed signal memoized by React deps.       │
│                                                         │
│  useReactor('name', fn, deps)                           │
│  ────────────────────────────                           │
│  Run side effect when signals change.                   │
│  Throttled to next animation frame.                     │
│                                                         │
│  useQuickReactor('name', fn)                            │
│  ────────────────────────────                           │
│  Like useReactor but runs synchronously (for DOM        │
│  updates like transform, display, clip-path).           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Binding system (arrow connections)

```
TLBinding record:
    { id, type: 'arrow', fromId: arrowShapeId, toId: targetShapeId,
      props: { terminal, normalizedAnchor: {x: 0..1, y: 0..1},
               isExact, isPrecise, snap } }

                  ┌──────────┐
                  │ Shape A  │◄── binding.toId
                  │          │    normalizedAnchor: {0.5, 0.5} (center)
                  └────┬─────┘
                       │
                       │  Arrow (fromId)
                       │  geometry computed at render:
                       │    1. Get binding anchor in target local space
                       │    2. Transform to arrow local space
                       │    3. Intersect arrow line with target geometry
                       │    4. Place arrowhead at intersection
                       │
                  ┌────▼─────┐
                  │ Shape B  │◄── binding.toId (other end)
                  └──────────┘

Reactive update flow:
    Shape A moves
        ↓
    sideEffects.shape.afterChange fires
        ↓
    getBindingsInvolvingShape(A) → [binding1, binding2, ...]
        ↓
    ArrowBindingUtil.onAfterChangeToShape()
        ↓
    reparentArrow() + arrowDidUpdate()
        ↓
    Arrow geometry cache invalidates
        ↓
    Arrow re-renders at new position
```

## Key file locations

```
packages/state/src/lib/
├── Atom.ts                    ← Reactive mutable value
├── Computed.ts                ← Derived reactive value
├── EffectScheduler.ts         ← Side effect runner
├── transactions.ts            ← Batching + rollback
└── capture.ts                 ← Dependency tracking

packages/store/src/lib/
├── Store.ts                   ← Record store (CRUD + history)
├── RecordType.ts              ← Typed record definitions
├── StoreQueries.ts            ← Reactive indexes
└── AtomMap.ts                 ← Reactive key-value collection

packages/state-react/src/lib/
├── useValue.ts                ← Signal → React state
├── useComputed.ts             ← Memoized computed in React
├── useReactor.ts              ← Side effects in React
└── track.ts                   ← Auto-tracking component wrapper

packages/editor/src/lib/editor/derivations/
├── parentsToChildren.ts       ← Incremental parent→children index
├── shapeIdsInCurrentPage.ts   ← Incremental page membership set
└── bindingsIndex.ts           ← Bidirectional binding lookup

packages/tlschema/src/
├── records/TLShape.ts         ← Shape record schema
├── records/TLBinding.ts       ← Binding record schema
├── records/TLCamera.ts        ← Camera record schema
└── records/TLPage.ts          ← Page record schema

packages/utils/src/lib/
└── reordering.ts              ← Fractional index generation
```
