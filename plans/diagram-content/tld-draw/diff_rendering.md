# Reactive computed cache with incremental diffs

Adapt tldraw's epoch-based reactive signal system to replace the diagram
framework's rebuild-from-scratch registries with incrementally maintained
caches.

---

## Object hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│  Signal Layer (primitives)                                          │
│                                                                     │
│  atom(name, value, opts?)         Mutable leaf state. Tracks an     │
│  ├─ .get()                        epoch counter and optional diff   │
│  ├─ .set(value, diff?)            history buffer. Every .set()      │
│  └─ .getDiffSince(epoch)          advances the global epoch.        │
│                                                                     │
│  computed(name, deriveFn, opts?)  Derived value. Re-derives only    │
│  ├─ .get()                        when a parent signal's epoch has  │
│  └─ .getDiffSince(epoch)          advanced past its own. Lazy:      │
│                                   never re-derives if nobody reads. │
│                                                                     │
│  withDiff(value, diff)            Wrapper that lets a computed      │
│                                   return both a new value and a     │
│                                   structured diff in one shot.      │
├─────────────────────────────────────────────────────────────────────┤
│  Change Detection Layer                                             │
│                                                                     │
│  globalEpoch          Monotonic counter. Incremented on every       │
│                       atom.set(). Signals compare their             │
│                       lastChangedEpoch against parent epochs to     │
│                       skip recomputation when nothing changed.      │
│                                                                     │
│  RESET_VALUE          Sentinel returned by getDiffSince() when      │
│                       the history buffer is exhausted. Consumers    │
│                       must rebuild from scratch.                    │
│                                                                     │
│  UNINITIALIZED        Sentinel passed as previousValue on the       │
│                       very first derivation of a computed signal.   │
│                       Consumers use isUninitialized() to detect it. │
├─────────────────────────────────────────────────────────────────────┤
│  Dependency Tracking Layer                                          │
│                                                                     │
│  Capture stack         Thread-local linked list of CaptureFrames.   │
│                        Every .get() call during a derivation        │
│                        registers the accessed signal as a parent.   │
│                        On stopCapturing(), stale parents are        │
│                        detached. No manual subscription management. │
│                                                                     │
│  unsafe__withoutCapture(fn)                                         │
│                        Reads a signal without creating a            │
│                        dependency. Used for one-off lookups that    │
│                        should not trigger re-derivation.            │
├─────────────────────────────────────────────────────────────────────┤
│  Diff Propagation Layer                                             │
│                                                                     │
│  HistoryBuffer         Ring buffer of (fromEpoch, toEpoch, diff)    │
│                        entries. Configurable length (historyLength  │
│                        option). getDiffSince(epoch) returns all     │
│                        diffs after the given epoch, or RESET_VALUE  │
│                        if the requested epoch has fallen out of     │
│                        the buffer.                                  │
│                                                                     │
│  ElementsDiff          Our domain-specific diff structure:          │
│                        { added, updated, removed } keyed by         │
│                        element ID (mirrors tldraw's RecordsDiff).   │
│                                                                     │
│  IncrementalSetConstructor                                          │
│                        Helper that tracks add/remove operations     │
│                        against a previous Set<T>, producing a       │
│                        minimal CollectionDiff { added?, removed? }  │
│                        or undefined if nothing changed.             │
├─────────────────────────────────────────────────────────────────────┤
│  Derived Cache Layer (domain caches built on the above)             │
│                                                                     │
│  parentsToChildren     Map<parentId, childId[]>                     │
│                        Incrementally maintained from ElementsDiff.  │
│                        Only re-sorts affected parent arrays.        │
│                                                                     │
│  reflowGroups          Map<groupId, ReflowGroupNode>                │
│                        Derived from parentsToChildren + element     │
│                        metadata. Patched on group add/remove.       │
│                                                                     │
│  interactiveElements   Map<elementId, InteractiveElement>           │
│                        Derived from elements atom. Patches parsed   │
│                        metadata only for changed elements.          │
│                                                                     │
│  worldBounds           Map<elementId, Rect>                         │
│                        Computed per-element. Auto-invalidates       │
│                        when own transform or ancestor transform     │
│                        changes. Replaces manual invalidation.       │
├─────────────────────────────────────────────────────────────────────┤
│  Effect Layer                                                       │
│                                                                     │
│  react(name, fn)       Runs fn whenever its accessed signals        │
│                        change. Attaches to the dependency graph.    │
│                        Used for DOM side effects (selection class,  │
│                        transform CSS, culling display toggle).      │
│                                                                     │
│  transact(fn)          Batches multiple atom.set() calls into one   │
│                        epoch advance. Effects fire once at the end. │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The incremental derivation pattern

Every derived cache follows the same three-branch structure:

```typescript
const reflowGroups = computed<Map<string, ReflowGroupNode>>(
  'reflowGroups',
  (prevValue, lastComputedEpoch) => {

    // Branch 1: first run
    if (isUninitialized(prevValue)) {
      return buildFromScratch(elements.get())
    }

    // Branch 2: history buffer exhausted
    const diff = elements.getDiffSince(lastComputedEpoch)
    if (diff === RESET_VALUE) {
      return buildFromScratch(elements.get())
    }

    // Branch 3: incremental patch
    if (diff.length === 0) return prevValue   // fast path: nothing changed

    let next: Map<string, ReflowGroupNode> | undefined
    for (const changeset of diff) {
      for (const el of Object.values(changeset.added)) {
        if (!isReflowGroup(el)) continue
        next ??= new Map(prevValue)
        next.set(el.id, buildNode(el))
      }
      for (const [, el] of Object.values(changeset.updated)) {
        if (!isReflowGroup(el)) continue
        next ??= new Map(prevValue)
        next.set(el.id, rebuildNode(el, next.get(el.id)))
      }
      for (const el of Object.values(changeset.removed)) {
        next ??= new Map(prevValue)
        next.delete(el.id)
      }
    }
    return next ?? prevValue
  },
  { historyLength: 200 }
)
```

Key mechanics:

1. **prevValue + lastComputedEpoch** are provided by the runtime. The
   function never stores its own "last seen" state.
2. **getDiffSince(epoch)** returns an array of ElementsDiff objects
   (one per batched mutation) or RESET_VALUE if the buffer has been
   overrun.
3. **Lazy copy**: `next ??= new Map(prevValue)` defers allocation until
   the first actual change. If nothing matches the filter, the original
   reference is returned and downstream signals see no epoch advance.
4. **withDiff** is optional. If a cache needs to propagate structured
   diffs downstream (e.g. the elements atom feeding into multiple
   caches), it returns `withDiff(nextValue, diff)` instead of a plain
   value. Caches that are leaf consumers (nothing reads their diffs)
   return plain values.

---

## ElementsDiff: our domain diff structure

```typescript
interface ElementsDiff {
  added:   Record<string, SceneElement>
  updated: Record<string, [from: SceneElement, to: SceneElement]>
  removed: Record<string, SceneElement>
}
```

Mirrors tldraw's RecordsDiff. The `updated` field carries both the
previous and current element so consumers can compare specific fields
(e.g. "did parentId change?") without a separate lookup.

---

## Where each current rebuild becomes incremental

### Scene element tree

**Current**: `SvgScene.buildElementTree()` walks the full DOM on
construction, building `elements` Map from scratch.

**After**: The `elements` atom is the single source of truth. Mutations
go through:

```typescript
function insertElement(el: SceneElement) {
  transact(() => {
    const current = elements.__unsafe__getWithoutCapture()
    const next = new Map(current)
    next.set(el.id, el)
    elements.set(next, { added: { [el.id]: el }, updated: {}, removed: {} })
  })
}
```

Initial construction still does a full DOM walk, but the result is
stored in the atom. Subsequent mutations (expand inserts sub-diagram
elements, collapse removes them) go through `insertElement` /
`removeElement` and produce targeted diffs.

### ReflowGroupRegistry

**Current**: `buildFromScene()` iterates all elements twice (create
nodes, then wire parent-child).

**After**: `reflowGroups` is a computed signal derived from `elements`.
On expand (adds ~5-20 elements), only the new elements are processed.
The existing hundreds of nodes are untouched.

### InteractiveElementRegistry

**Current**: `buildFromScene()` iterates all elements, parses metadata.

**After**: `interactiveElements` is a computed signal. When a
sub-diagram is inserted, only its new interactive elements are parsed.

### World bounds cache

**Current**: `worldBoundsCache` Map with manual
`invalidateWorldBoundsCache(id)` that recursively invalidates children.

**After**: Per-element computed signal:

```typescript
function worldBounds(id: string): Computed<Rect> {
  return computed(`worldBounds:${id}`, () => {
    const el = elements.get().get(id)
    if (!el) return EMPTY_RECT
    const local = el.localBounds
    const parentBounds = el.parentId
      ? worldBounds(el.parentId).get()   // auto-tracks dependency
      : IDENTITY_RECT
    return transformRect(local, composeTransforms(parentTransform(el.parentId), el.transform))
  })
}
```

When `setTransform(id, t)` updates an element, only that element's
worldBounds and its descendants recompute. No manual invalidation walk.

---

## tldraw-specific concerns that do not apply to us

These patterns exist in tldraw but are either unnecessary or
inappropriate for our architecture:

### Collaborative sync and undo history

tldraw's Store keeps 1000-entry diff history primarily to support
multiplayer sync (`getChanges()` for server broadcast) and undo/redo
(reverse diffs). Our diagrams are single-user, read-mostly artifacts
with no undo. A `historyLength` of 50-200 is sufficient to cover the
gap between a mutation and the next derivation cycle.

### Record scoping (document / session / presence)

tldraw partitions records by persistence scope: `document` records sync
to server, `session` records are local, `presence` records are
ephemeral. Our scene elements are all local and ephemeral (they exist
only while the diagram is mounted). No scope partitioning needed.

### filterHistory by record type

tldraw's `StoreQueries.filterHistory(typeName)` creates per-type
computed signals that filter the store-wide diff stream. This exists
because tldraw's single Store holds cameras, shapes, bindings, pages,
and instance state all together. Our elements atom holds only
SceneElements, so no type filtering is needed. The diff from `elements`
is already homogeneous.

### React integration via useSyncExternalStore

tldraw bridges its signal system to React via `track()` wrappers and
`useValue()` hooks that use `useSyncExternalStore`. This is necessary
because tldraw's Editor is a long-lived object that outlives React
render cycles. Our diagram framework is React-first: hooks own the
lifecycle. We should use `react()` / `reactor()` effects for DOM side
effects (selection class, transforms) and standard React state for UI
that needs re-render (tooltips, expanded state display). No custom React
bridge needed initially.

### @computed decorator on class methods

tldraw uses a TC39 `@computed` decorator on Editor methods. This relies
on class-based architecture where the Editor is a mega-object with
hundreds of methods. Our framework uses hooks and standalone functions.
Use `computed()` as a function call, not a decorator.

### ComputedCache keyed by record ID

tldraw's `createComputedCache(name, derive)` creates a lazy map where
each record ID gets its own computed signal. This is critical for
tldraw because it has thousands of shapes that each need independent
geometry, transform, and bounds computations. Our diagrams have tens to
low hundreds of elements. Per-element computed signals for worldBounds
make sense, but we do not need the full ComputedCache abstraction with
its per-record equality and areRecordsEqual hooks.

---

## Adoption rationale

### What the current architecture costs us

The diagram framework rebuilds three registries from scratch on every
scene change: `buildElementTree()`, `ReflowGroupRegistry.buildFromScene()`,
and `InteractiveElementRegistry.buildFromScene()`. Today this is
tolerable because scenes are constructed once from static HTML.

That changes with expand/collapse. When a user expands a reflow group:

1. Sub-diagram HTML is fetched and parsed into new SVG elements.
2. Those elements must be added to the scene's element tree.
3. The reflow registry must incorporate the new groups and their
   parent-child relationships.
4. The interactive registry must parse metadata for new clickable
   elements.
5. World bounds for the expanded region and all its ancestors must be
   recomputed.

Today, steps 2-5 require rebuilding all three data structures from the
full DOM. For a diagram with 200 existing elements where an expand adds
15 new ones, we redo work for all 215 elements instead of processing
just the 15. This scales poorly as diagrams grow and users expand
multiple groups.

The world bounds cache has a subtler cost: `invalidateWorldBoundsCache`
must walk the entire subtree below a changed element. When a root-level
reflow displaces 30 elements, that walk touches every descendant of
every displaced element. With computed signals, only the elements whose
transforms actually changed recompute their bounds, and the traversal
stops at elements whose inputs did not change.

### What tldraw's pattern gives us

**Granular reactivity without manual wiring.** The capture stack
automatically tracks which signals each computed reads. When
`setTransform(id, t)` fires, only the computeds that transitively
depend on that element's transform re-derive. No subscription lists to
manage, no event emitter boilerplate, no stale-cache bugs from
forgetting to invalidate.

**Epoch-based change detection is cheap.** Checking whether a computed
needs re-derivation is a single integer comparison
(`parentEpoch > lastCheckedEpoch`). There is no deep equality check, no
dirty-flag propagation. This makes it safe to have hundreds of computed
signals without measurable overhead when most of them are unchanged.

**Incremental diffs compose.** The `getDiffSince(epoch)` API lets each
layer consume only the changes from the layer below. The elements atom
produces ElementsDiff; the reflowGroups computed consumes that diff and
(optionally) produces its own diff for anything above it. Each layer
does O(delta) work, not O(total).

**Batching is free.** `transact()` groups multiple `atom.set()` calls
into a single epoch advance. When expand inserts 15 elements, the
registries see one diff with 15 additions, not 15 separate single-
element diffs. Effects fire once at the end.

**Lazy evaluation prevents wasted work.** A computed signal that nobody
reads never re-derives. If a diagram is off-screen or a panel is
collapsed, its world bounds and hit-test geometry are not recomputed.
Only signals that are actively observed (via `react()` effects or
`.get()` calls during render) participate in the reactive graph.

### Why adopt tldraw's version specifically

The reactive primitives (`atom`, `computed`, `react`, `transact`) from
`@tldraw/state` are a standalone package with no dependency on tldraw's
editor, store, or React layer. The package is 1,200 lines of
TypeScript with zero runtime dependencies. It is battle-tested in
production across tldraw's editor (which manages thousands of shapes
with real-time collaboration) and is designed for exactly the use case
we have: a tree of elements with transforms, bounds, and derived
indexes that must update efficiently when the tree mutates.

The alternatives are:

- **Build our own.** The core pattern (atom + computed + capture stack +
  epoch) is ~500 lines to implement minimally. But getting edge cases
  right (nested transactions, error recovery, history buffer overflow,
  stale dependency cleanup) is where the real complexity lives. tldraw
  has resolved these over years of production use.

- **Use a general reactive library (MobX, Jotai, Preact signals).**
  These work but lack the `getDiffSince(epoch)` API that makes
  incremental derivation possible. Without structured diffs, every
  computed must either deep-compare its output or rebuild from scratch.
  The diff propagation layer is the key differentiator.

- **Stay with React state + manual caches.** This is what we have today.
  It works for static diagrams but requires increasingly complex
  imperative invalidation logic as mutation operations grow. The
  expand/collapse feature already requires manual cache invalidation in
  three places; the planned constraint solver will add more.

`@tldraw/state` gives us the diff propagation layer that general-purpose
reactive libraries lack, without the cost of building and maintaining
our own signal runtime.
