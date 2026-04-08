# Reflow Engine

## What Reflow Does

The reflow engine repositions **reflow groups** (sets of SVG elements that move as a unit) when the diagram's spatial layout changes. Its goal is to **preserve the relative spatial relationships** between groups — if group A was 20px below group B before a mutation, it should still be 20px below after reflow.

## ReflowEngine Interface

The reflow engine is the most actively developed component in the framework. Every code path that interacts with it must go through a well-defined interface so the underlying algorithm can evolve without breaking consumers.

```typescript
interface ReflowEngine {
  // --- Lifecycle ---

  /** Initialize from a Scene. Caches all group bounding boxes via scene.getLocalBounds(). */
  initialize(scene: Scene): void;

  /** Tear down. Clears caches, removes listeners. */
  destroy(): void;

  // --- Mutations (these trigger reflow) ---

  /**
   * Notify the engine that a group's intrinsic size has changed.
   * E.g., an expandable section was opened or closed.
   * @param groupId - the data-reflow-group id
   * @param newBounds - the new bounding box of the group's content
   */
  groupResized(groupId: string, newBounds: Rect): void;

  /**
   * Notify the engine that a new group was inserted into the scene.
   * The engine reads the group's data from scene.getElement(groupId).
   * @param groupId - the new group's id
   */
  groupInserted(groupId: string): void;

  /**
   * Notify the engine that a group was removed from the scene.
   */
  groupRemoved(groupId: string): void;

  /**
   * Batch multiple mutations and run a single reflow pass at the end.
   * All mutations inside the callback are deferred.
   */
  batch(fn: () => void): void;

  // --- Queries ---

  /** Get the current (post-reflow) bounding box of a group. */
  getGroupBounds(groupId: string): Rect | null;

  /** Get the displacement applied to a group by the last reflow. */
  getGroupDisplacement(groupId: string): { dx: number; dy: number };

}
```

### Why This Interface Shape

- **Mutation methods** (`groupResized`, `groupInserted`, `groupRemoved`) are intentionally imperative rather than declarative. The caller knows *what changed*; the engine figures out *what to move*.
- **`batch()`** exists because expand/collapse often involves multiple groups. Without batching, each mutation would trigger a full constraint solve.
## When Reflow Triggers

The only confirmed trigger is expand/collapse, initiated by the user clicking an expandable SceneElement.

### Expand / Collapse

```
User clicks on diagram
  → InteractionLayer calls scene.hitTest(scenePoint)
  → hitTest resolves to a SceneElement ID
  → InteractionLayer emits onElementClick(id) to application
  → Application checks metadata: is it expandable?
  → Application loads expanded content, inserts into Scene
  → Application calls engine.groupResized(groupId, newBounds)
  → Engine runs constraint solver (or applies pre-computed script)
  → Engine calls scene.setTransform() / scene.growVisualBounds()
  → Visual elements move in place (no overlay sync needed)
```

## Constraint Solving Algorithm

The algorithm must handle two fundamentally different spatial relationships (see `reflow_elements.md` for full rationale):

- **Containment:** when a child resizes, its parent's bounds **grow** (bounds mutation)
- **Adjacency:** when a sibling resizes, other siblings **translate** (displacement)

### Algorithm: Bottom-Up Tree Propagation

```
Input: groupId that resized, newBounds
Output: set of (groupId → displacement) pairs

1. Let node = registry.groupsById.get(groupId)
2. Compute deltaW = newBounds.width - node.currentBounds.width
3. Compute deltaH = newBounds.height - node.currentBounds.height
4. Update node.currentBounds = newBounds

5. RESOLVE_WITHIN_PARENT(node, deltaW, deltaH):
   a. Let parent = node.parent
   b. Let siblings = parent ? parent.children : registry.roots
   c. For each sibling S after node (in document order):
      - If S is below node: displace S by (0, deltaH)
      - If S is to the right of node: displace S by (deltaW, 0)
   d. For each arrow A whose originalBounds.y > node.currentBounds.y:
      - Displace A by (0, deltaH)  [similarly for horizontal]

6. GROW_PARENT(parent, deltaW, deltaH):
   a. If parent is null → done (reached root level)
   b. Call scene.growVisualBounds(parent.id, max(0, deltaW), deltaH)
   c. Update parent.currentBounds to encompass all children
   d. Recurse: RESOLVE_WITHIN_PARENT(parent, parentDeltaW, parentDeltaH)
   e. Recurse: GROW_PARENT(parent.parent, parentDeltaW, parentDeltaH)

7. Done — Scene is visually updated
```

The `base.html` sample's flat displacement model is a special case of this — it works because that diagram has no nested groups that require parent growth. The tree-aware algorithm generalizes it.

### Batching

When `batch()` is called, mutations are queued and the algorithm runs once at the end. Multiple resizes within the same subtree are merged: if both `yield-mechanism` and `task-result-branch` (siblings inside `work-loop`) resize, the parent growth is computed once from the combined delta, not twice.

## Data Structures

### ReflowEngine Implementation State

The `ReflowEngine` interface (above) is backed by the following internal state:

```typescript
/** Internal state of the ReflowEngine implementation. */
interface ReflowEngineState {
  /** The Scene instance — used for all rendering mutations. */
  scene: Scene;

  /** The containment tree registry (see reflow_elements.md). */
  registry: ReflowGroupRegistry;

  /** Whether we are inside a batch() call. */
  batching: boolean;

  /** Mutations queued during a batch. */
  pendingMutations: ReflowMutation[];

}

/** A queued mutation within a batch. */
type ReflowMutation =
  | { type: 'resize'; groupId: string; newBounds: Rect }
  | { type: 'insert'; groupId: string }
  | { type: 'remove'; groupId: string };
```

### DisplacementResult

The output of a single reflow pass.

```typescript
/** Result of constraint resolution — who moved and by how much. */
interface DisplacementResult {
  /** Groups that were displaced (translated). Maps groupId → delta. */
  groupDisplacements: Map<string, { dx: number; dy: number }>;

  /** Arrows that were displaced. Maps arrow SceneElement ID → delta. */
  arrowDisplacements: Map<string, { dx: number; dy: number }>;

  /** Groups whose bounds were mutated (parent growth). Maps groupId → new bounds. */
  boundsMutations: Map<string, Rect>;
}
```

The `DisplacementResult` distinguishes displacements (translations) from bounds mutations (parent growth). The interaction layer only cares about displacements (to invalidate cached hit-test bounds). The reflow engine internally needs both to propagate correctly up the tree.

## How Reflow Impacts the Rest of the Diagram

### Scene Elements

The reflow engine applies mutations through the `Scene` interface. Every group, arrow, and interactive region is a `SceneElement` (see `rendering.md`). The engine uses two Scene methods:

- `scene.setTransform(elementId, { tx, ty, scale: 1 })` — repositions a group or arrow (displacement)
- `scene.growVisualBounds(elementId, deltaW, deltaH)` — grows a parent's visual rect (containment)

The Scene backend handles the actual rendering. For the SVG backend, this means setting CSS `transform: translate()` on `<g>` elements and mutating `<rect>` attributes. CSS transitions handle animation:

```css
[data-reflow-group] {
  transition: transform 0.45s cubic-bezier(0.25, 0.1, 0.25, 1);
}
```

### Arrows / Connectors

Arrows are `SceneElement`s with the `data-arrow` role. They are tracked separately by the reflow engine and displaced via `scene.setTransform()`. The LLM should place arrows in their own `<g data-arrow>` wrappers (not inside a reflow group) so they can be independently repositioned.

### Interactive Elements

Interactive elements are `SceneElement`s with the `data-interactive` role. They move automatically because they ARE the visual elements — there are no overlay nodes to sync. When a reflow group that contains interactive elements is displaced, those elements move with it (they are children in the DOM/SceneElement tree). The Scene's `getWorldBounds()` reads current bounds on demand — no notification needed.

### Root Element (Pan/Zoom)

Reflow does **not** change the root `SceneElement`'s transform (the pan/zoom state). The engine only writes transforms to child elements. Expanded content grows outward; the user pans/zooms to see it.

## Integration Points Summary

| Consumer | How it integrates | Direction |
|---|---|---|
| Application layer | Calls `groupResized()` after expand/collapse | → Engine |
| Scene | Engine calls `setTransform()` / `growVisualBounds()` | Engine → Scene |
