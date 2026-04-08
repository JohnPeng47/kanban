# Reflow Elements

## Purpose

Reflow elements define the **spatial grouping** of SVG content for the reflow engine. When the diagram mutates (expand, collapse, insert), the engine needs to know which elements move together as a unit. This document specifies the container conventions, data attributes, and LLM generation instructions.

## SVG Container Choice: `<g>` vs `<svg>`

### Use `<g>` for Reflow Groups

Reflow groups **must** use `<g>` (the SVG grouping element), not `<svg>`.

**Why `<g>`:**
- `<g>` inherits the parent coordinate system. When the reflow engine applies `transform: translate(dx, dy)`, all children move in parent coordinates — exactly what we want.
- `<g>` has no intrinsic size or viewport. It is a pure grouping mechanism with no side effects.
- `<g>` allows CSS transitions on `transform`, enabling smooth animated reflow.
- `<g>` children can overflow without clipping, which matters when expanded content is larger than the original footprint.

**Why not `<svg>`:**
- `<svg>` establishes a **new viewport** with its own coordinate system (`viewBox`). Transforms applied to an `<svg>` interact with its internal coordinate system in non-obvious ways.
- `<svg>` clips content to its `width`/`height` by default (via `overflow: hidden`). Reflow groups must not clip.
- `<svg>` is appropriate for **embedding** a self-contained sub-diagram (e.g., expanded content loaded from another file). It is used in that role — see "Nested `<svg>` for Expanded Content" below.

### When Nested `<svg>` Is Appropriate

Use a nested `<svg>` element **only** for embedding externally-loaded sub-diagram content inside an expanded section. This gives the sub-diagram its own `viewBox` and coordinate space, which is correct because the sub-diagram was authored independently.

**Does the reflow engine need to deal with the nested `<svg>`'s coordinate system?** No. The reflow engine is coordinate-system-ignorant with respect to nested `<svg>`. Here's why:

1. The engine only applies `transform: translate(dx, dy)` to `<g data-reflow-group>` elements — never to `<svg>` elements.
2. The nested `<svg>` is a **child** of the `<g>`. When the `<g>` translates, the `<svg>` moves with it. No coordinate conversion needed.
3. The engine treats the expandable group as an opaque box with a size. When collapsed, the box is (say) 1060x50. When expanded, it becomes 1060x340. The engine doesn't care what's inside — it just knows the box got bigger and pushes everything below it down.
4. The nested `<svg>`'s internal coordinate system (`viewBox`) only matters to the content inside it. It is invisible to the reflow engine, which never looks past the `<g data-reflow-group>` boundary.

The only place coordinates cross systems is when the framework **inserts** the nested `<svg>` during expansion — it sets `x`, `y`, `width`, `height` attributes to position it within the parent `<g>`'s coordinate space. This happens once, at expansion time, not during reflow.

```xml
<!-- Reflow group uses <g> -->
<g data-reflow-group="message-channel" data-expandable="true">
  <g class="collapsed-content">
    <!-- collapsed view content -->
  </g>
  <g class="expanded-content">
    <!-- When expanded, framework inserts: -->
    <svg x="20" y="498" width="1060" height="340"
         viewBox="0 0 1060 340">
      <!-- sub-diagram SVG content -->
    </svg>
  </g>
</g>
```

## Data Attribute Contract

### `data-reflow-group="<id>"`

Applied to a `<g>` element. Registers it as a reflow group with the given unique ID.

```xml
<g data-reflow-group="work-loop">
  <!-- all elements in this group move together during reflow -->
  <rect x="20" y="596" width="1060" height="280" rx="4" ... />
  <text x="32" y="618" ...>► 04-work-loop</text>
  ...
</g>
```

**Rules:**
- IDs must be unique within the diagram.
- IDs should be descriptive kebab-case strings (e.g., `priority-mapping`, `data-structures`).
- A reflow group can contain nested reflow groups. The engine processes them in tree order.
- Every visual "block" in the diagram should be a reflow group.

### `data-expandable="true"`

Applied to a reflow group `<g>` that can expand/collapse. Must also specify:

| Attribute | Purpose |
|---|---|
| `data-expand-src="<filename>"` | HTML file to fetch for expanded content |
| `data-expand-w="<number>"` | Width of expanded state (SVG units) |
| `data-expand-h="<number>"` | Height of expanded state (SVG units) |

The element must contain two child `<g>` elements:
- `<g class="collapsed-content">` — visible when collapsed
- `<g class="expanded-content">` — populated by framework when expanded

### `data-arrow`

Applied to `<g>` elements that contain connector lines/arrows between groups. Arrows are **not** reflow groups but are tracked separately by the engine so they can be displaced independently.

```xml
<g data-arrow>
  <line x1="500" y1="288" x2="500" y2="338" stroke="#8B949E" ... />
  <text x="510" y="320" class="dim subhead">annotation text</text>
</g>
```

**Why arrows are separate:** An arrow connects two groups. If the target group moves down during reflow, the arrow must also move down. But the arrow is not "part of" either group — it belongs to the space between them.

## Reflow Group Hierarchy

Groups can be nested. The `<g>` nesting in the SVG DOM defines a **containment tree** that the reflow engine must respect. This nesting is not incidental — it encodes two fundamentally different spatial relationships that drive different constraint resolution strategies.

### Containment vs Adjacency

When a child group expands, two different things happen to two different sets of elements:

| Relationship | What happens | Operation | Example |
|---|---|---|---|
| **Containment** (parent ← child) | Parent **grows** to accommodate the expanded child | Bounds mutation | `work-loop` rect grows taller when `yield-mechanism` expands |
| **Adjacency** (sibling ↔ sibling) | Sibling **translates** to preserve the gap | Displacement | `task-result-branch` slides down when `yield-mechanism` expands |

These are fundamentally different operations. A flat displacement model cannot distinguish them — it would either translate the parent bodily (wrong: the parent should grow in place) or fail to grow the parent (wrong: the child would burst out visually).

The containment tree encodes this distinction explicitly:
- **Children of a group** → containment relationship → parent grows
- **Siblings within a group** → adjacency relationship → sibling translates
- **Groups at the same level outside any shared parent** → adjacency → translate

### Why the Tree Must Be Explicit (Not Reconstructed Lazily)

Three things depend on the containment tree being a first-class data structure:

**1. Constraint resolution strategy.** The engine must know, at propagation time, whether to mutate a rect's bounds (grow the parent) or translate it bodily (move a sibling). Without the tree, you'd have to reconstruct this at propagation time by asking "is this element the outline of something that contains the expanding node?" — which is just the containment relationship computed lazily and expensively.

**2. Paint order and event routing.** SVG `<g>` nesting gives us two things for free:
- **Paint order:** children paint after parents, so they appear on top.
- **Event bubbling:** clicking a nested node fires the event on the innermost element first, then bubbles up. This gives "click inner node to expand inner, click parent chrome to expand parent" behavior without manual click routing.

Flattening the structure would require reimplementing both — manually sorting paint order and writing hit-test routing that checks "which of several overlapping nodes should handle this click?"

**3. Semantic error diagnostics.** When post-reflow verification detects an overlap, the tree lets the engine report "expanded child `yield-mechanism` overflowed its parent `work-loop`" instead of the opaque "nodes X and Y overlap." The first tells you which constraint was violated; the second tells you something went wrong and leaves you to figure out what.

### Example

```xml
<g data-reflow-group="work-loop">
  <rect ... />  <!-- outer box — this rect GROWS when children expand -->

  <g data-reflow-group="yield-mechanism">
    <!-- containment: if this expands, parent "work-loop" grows -->
    <rect ... />
    <text ... />
  </g>

  <g data-reflow-group="task-result-branch">
    <!-- adjacency with yield-mechanism: if yield-mechanism expands,
         this translates down to preserve the gap -->
    <rect ... />
    <text ... />
  </g>
</g>
```

### Resolution Order

When a nested group resizes, the reflow engine processes the tree bottom-up:

1. **Resolve adjacency within the parent:** Siblings below the resized child translate down by the child's delta-height. Siblings to the right translate right by delta-width.
2. **Mutate parent bounds:** The parent group's bounding box grows to encompass all children at their new positions. The parent's visual rect is grown via `scene.growVisualBounds(parentId, deltaW, deltaH)`.
3. **Propagate upward:** The parent's size change is itself a resize event. Go to step 1 with the parent's parent, recursively, until reaching a root-level group.
4. **Resolve root-level adjacency:** Root-level siblings of the (transitively) resized group translate to preserve gaps.

## Data Structures

### ReflowGroupNode

The containment tree is represented as a tree of `ReflowGroupNode` objects, built during diagram loading from the `Scene` interface. Each node wraps a `SceneElement` (see `rendering.md`) that has the `data-reflow-group` role.

```typescript
/** A node in the reflow containment tree.
 *  Wraps a SceneElement with reflow-specific state (displacement, expansion). */
interface ReflowGroupNode {
  /** The SceneElement ID (same as the data-reflow-group value). */
  id: string;

  /** Parent group, or null if this is a root-level group. */
  parent: ReflowGroupNode | null;

  /** Child groups (containment relationship). Ordered by document order. */
  children: ReflowGroupNode[];

  /** Original bounding box at initialization time (before any reflow).
   *  Read from scene.getLocalBounds(id) during initialization. */
  originalBounds: Rect;

  /** Current bounding box (updated after each reflow). */
  currentBounds: Rect;

  /** Whether this element has a visual rect that can be grown.
   *  Read from SceneElement.hasVisualRect.
   *  Growth is performed via scene.growVisualBounds(id, dw, dh). */
  hasVisualRect: boolean;

  /** Cumulative displacement applied to this group by reflow.
   *  Applied via scene.setTransform(id, { tx: dx, ty: dy, scale: 1 }). */
  displacement: { dx: number; dy: number };

  /** Whether this group is expandable (has data-expandable="true"). */
  expandable: boolean;

  /** Expansion state, if expandable. */
  expansion: {
    expanded: boolean;
    collapsedBounds: Rect;
    expandedBounds: Rect | null; // null until first expansion
    expandSrc: string;
    expandW: number;
    expandH: number;
  } | null;
}
```

### ArrowNode

Arrows are tracked separately — they are not part of the containment tree but need displacement.

```typescript
/** A tracked arrow/connector between reflow groups.
 *  Wraps a SceneElement with the data-arrow role. */
interface ArrowNode {
  /** The SceneElement ID (e.g., "arrow-0"). */
  id: string;

  /** Original bounding box at initialization time.
   *  Read from scene.getLocalBounds(id) during initialization. */
  originalBounds: Rect;

  /** Cumulative displacement applied by reflow.
   *  Applied via scene.setTransform(id, { tx: dx, ty: dy, scale: 1 }). */
  displacement: { dx: number; dy: number };
}
```

### ReflowGroupRegistry

The registry is the top-level container that the `ReflowEngine` operates over.

```typescript
/** Registry of all reflow groups and arrows in a diagram. */
interface ReflowGroupRegistry {
  /** Root-level groups (no parent). Ordered by document order. */
  roots: ReflowGroupNode[];

  /** Fast lookup by group ID. */
  groupsById: Map<string, ReflowGroupNode>;

  /** All tracked arrows, in document order. */
  arrows: ArrowNode[];

  /** Build the registry from a Scene (not from SVG directly). */
  buildFromScene(scene: Scene): void;

  /** Find the deepest group containing a given group ID. */
  findContainingGroup(groupId: string): ReflowGroupNode | null;

  /** Get all sibling groups of a given group (same parent). */
  getSiblings(groupId: string): ReflowGroupNode[];
}
```

### Rect

```typescript
/** Axis-aligned bounding box in scene coordinate space.
 *  Uses SVG getBBox() semantics as canonical definition (see rendering.md). */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
```