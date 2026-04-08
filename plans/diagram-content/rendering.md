# Rendering Abstraction — Scene Interface

## Purpose

The `Scene` interface is the rendering abstraction that sits between the diagram loader and the rest of the framework. Nothing downstream of the loader — not the ReflowEngine, not the InteractiveElementRegistry, not the InteractionLayer — imports from SVG directly. They all talk to `Scene`.

## Design Principles

### SVG Is the Wire Format, Not the Runtime API

LLMs generate diagrams as SVG inside HTML files. This will not change — SVG is the right authoring format. But the framework's runtime code should not be coupled to SVG DOM APIs (`getBBox()`, `setAttribute()`, `style.transform`, etc.). Instead, the loader parses SVG into a `Scene`, and everything else operates on the Scene's abstract API.

### Scope: Web Only, SVG First

The current backend is SVG. Future backends may include `<canvas>` 2D or three.js. The Scene interface is designed to make those backends possible without changing any framework code above the Scene boundary. That said, we are not building those backends now — optimize for the SVG backend being trivial to implement.

### One Primitive: SceneElement

Both the reflow system and the interaction system operate on the same underlying DOM elements. A single `<g>` element can simultaneously be a reflow group and an interactive region. Rather than modeling these as separate types that happen to share an ID, the Scene exposes a single `SceneElement` type that represents any tagged element in the diagram. Reflow groups, interactive regions, arrows, and the root are all `SceneElement`s — they differ only in which `data-*` attributes (roles) they carry.

### Bounds Semantics

All bounds use **SVG `getBBox()` semantics** as the canonical definition:
- Axis-aligned bounding box
- In the element's **local** coordinate space (before its own transform is applied)
- Reflects the element's own geometry (children included for groups)
- Origin at top-left of the bounding box

The transform on each element is a separate property. To get an element's position in world (scene) coordinates, compose transforms from the root down to that element.

Other backends, when added, must normalize to match these semantics.

## SceneElement

```typescript
/**
 * The universal primitive of the Scene.
 *
 * Every tagged element in the diagram is a SceneElement. The element's
 * roles (reflow group, interactive region, arrow, viewport root) are
 * determined by its metadata — specifically, the data-* attributes
 * from the source SVG.
 *
 * For SVG backend: each SceneElement maps to a <g> element in the DOM.
 */
interface SceneElement {
  /** Unique identifier.
   *  - For reflow groups: the data-reflow-group value
   *  - For interactive regions: the data-interactive value
   *  - For arrows: "arrow-{index}"
   *  - For the root: "root" */
  id: string;

  /** Parent element ID, or null for the root. */
  parentId: string | null;

  /** Child element IDs, in document order. */
  childIds: string[];

  /** Bounding box in local coordinates (before this element's transform).
   *  Matches SVG getBBox() semantics. */
  localBounds: Rect;

  /** Transform applied to this element.
   *  - For the root: set by D3-zoom (pan/zoom)
   *  - For reflow groups: set by the reflow engine (displacement)
   *  - For others: identity */
  transform: Transform;

  /** All data-* attributes from the source element.
   *  Used to determine roles:
   *    data-reflow-group → reflow group role
   *    data-interactive  → interactive region role
   *    data-arrow        → arrow role
   *    data-expandable   → expandable flag
   *    data-ref          → source code reference
   *    data-category     → interactive element category
   *    data-label, data-tt, data-nav → display metadata */
  metadata: Record<string, string>;

  /** Whether this element has a visual rect (<rect> child) that can be
   *  grown during parent containment resolution. */
  hasVisualRect: boolean;
}

/** Transform: translate + uniform scale. */
interface Transform {
  tx: number;
  ty: number;
  scale: number;
}

/** Identity transform. */
const IDENTITY_TRANSFORM: Transform = { tx: 0, ty: 0, scale: 1 };
```

### Roles Are Derived from Metadata

A `SceneElement` doesn't know what "kind" it is. The framework's higher layers determine roles by checking metadata:

```typescript
function isReflowGroup(el: SceneElement): boolean {
  return 'reflow-group' in el.metadata;
}

function isInteractiveRegion(el: SceneElement): boolean {
  return 'interactive' in el.metadata;
}

function isArrow(el: SceneElement): boolean {
  return 'arrow' in el.metadata;
}

function isExpandable(el: SceneElement): boolean {
  return el.metadata['expandable'] === 'true';
}
```

A single element can have multiple roles. The common case: a `<g>` with both `data-reflow-group="work-loop"` and `data-interactive="scheduler-work-loop"` is one SceneElement that is both a reflow group and an interactive region.

### The Root Element Carries the Pan/Zoom Transform

The root `SceneElement` (id: `"root"`, parentId: `null`) represents the entire diagram. Its transform is where pan/zoom state lives — D3-zoom writes to it via `scene.setTransform("root", ...)`. All children inherit it via CSS transform composition. There is no separate "viewport" object; the root element's transform slot is the only state pan/zoom needs.

```
SceneElement "root"                  transform: { tx: -200, ty: -100, scale: 1.5 }
  ├── SceneElement "title"           transform: identity
  ├── SceneElement "arrow-0"         transform: identity
  ├── SceneElement "work-loop"       transform: { tx: 0, ty: 120, scale: 1 }  (reflow)
  │     ├── SceneElement "yield"     transform: identity
  │     └── SceneElement "task-res"  transform: identity
  └── SceneElement "browser-time"    transform: { tx: 0, ty: 120, scale: 1 }  (reflow)
```

Pan is `setTransform("root", { tx, ty, scale })`. Zoom is the same — D3-zoom provides all three values.

## Scene Interface

```typescript
interface Scene {
  // ─── Element Tree ──────────────────────────────────────────

  /** Get the root element. */
  getRoot(): SceneElement;

  /** Get an element by ID. */
  getElement(id: string): SceneElement | null;

  /** Get all elements as a flat map. */
  getAllElements(): Map<string, SceneElement>;

  /** Get children of an element, in document order. */
  getChildren(id: string): SceneElement[];

  // ─── Bounds ────────────────────────────────────────────────

  /** Get an element's local bounds (before its own transform). */
  getLocalBounds(id: string): Rect;

  /** Get an element's bounds in world (scene) coordinates.
   *  Composes transforms from root to the element's parent,
   *  then applies to localBounds. Does NOT include the element's
   *  own transform (consistent with getBBox semantics — an element's
   *  bounding box doesn't reflect its own transform). */
  getWorldBounds(id: string): Rect;

  // ─── Transforms ────────────────────────────────────────────

  /** Set an element's transform (absolute, not incremental).
   *  Used by:
   *  - D3-zoom on the root element (pan/zoom)
   *  - ReflowEngine on group elements (displacement) */
  setTransform(id: string, transform: Transform): void;

  /** Get an element's own transform. */
  getTransform(id: string): Transform;

  /** Get the composed transform from root to this element (inclusive).
   *  Product of all ancestor transforms and this element's transform.
   *  Used for screen↔scene coordinate conversion. */
  getWorldTransform(id: string): Transform;

  // ─── Mutations ─────────────────────────────────────────────

  /** Grow an element's visual rect (parent growth during reflow).
   *  deltaW/deltaH are added to the current width/height.
   *  Only valid if element.hasVisualRect is true.
   *  For SVG backend: mutates the <rect> child's width/height attributes. */
  growVisualBounds(id: string, deltaW: number, deltaH: number): void;

  // ─── Hit Testing ───────────────────────────────────────────

  /** Point hit test in scene coordinates.
   *  Returns the ID of the deepest SceneElement containing the point,
   *  or null if the point is on empty space.
   *
   *  "Deepest" means innermost in the element tree. If the point is
   *  inside both "work-loop" and its child "yield-mechanism", returns
   *  "yield-mechanism". If the point is on work-loop's chrome (inside
   *  work-loop but outside any child), returns "work-loop".
   *
   *  Returns any SceneElement regardless of role — the caller checks
   *  metadata to decide what to do (interactive? expandable? etc.).
   *
   *  For SVG backend: uses event.target.closest() to walk from the
   *  actual hit DOM element up to the nearest SceneElement <g>.
   *  For future backends: AABB bounds walk in reverse document order. */
  hitTest(scenePoint: Point): string | null;

  /** Rectangle hit test in scene coordinates.
   *  Returns IDs of interactive SceneElements (those with data-interactive
   *  in metadata) whose world bounds either intersect or are fully
   *  contained by the rect.
   *  mode: 'intersect' for partial overlap, 'contain' for full containment.
   *
   *  Only returns interactive elements (not all SceneElements) because
   *  drag-select is specifically about selecting interactive regions. */
  hitTestRect(sceneRect: Rect, mode: 'intersect' | 'contain'): string[];

  // ─── Coordinate Conversion ─────────────────────────────────

  /** Convert a screen-space point to scene coordinates.
   *  Uses the root element's transform (the viewport). */
  screenToScene(screenPoint: Point): Point;

  /** Convert a scene-space point to screen coordinates. */
  sceneToScreen(scenePoint: Point): Point;

  // ─── Rendering ─────────────────────────────────────────────

  /** Get the DOM element that renders the scene.
   *  For SvgScene: a wrapper div containing the <svg>.
   *  D3-zoom attaches to this element. The root element's transform
   *  is applied as CSS transform on this element (or an inner wrapper). */
  getRenderElement(): HTMLElement;

  // ─── Lifecycle ─────────────────────────────────────────────

  /** Tear down. Release DOM references, clear caches. */
  destroy(): void;
}
```

## Supporting Types

```typescript
/** Axis-aligned bounding box.
 *  In local coordinates when on SceneElement.localBounds.
 *  In scene coordinates when returned by getWorldBounds / hitTestRect. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point in either screen or scene coordinates (context-dependent). */
interface Point {
  x: number;
  y: number;
}
```

## Coordinate Spaces

Three coordinate spaces exist:

| Space | Origin | Used by |
|---|---|---|
| **Local** | Top-left of the element's own bounding box | `SceneElement.localBounds`, `getLocalBounds()` |
| **Scene** | Top-left of the diagram content (root element's local space) | `getWorldBounds()`, `hitTest()`, `hitTestRect()`, reflow engine |
| **Screen** | Top-left of the browser viewport | Mouse events, selection rectangle rendering |

Conversions:
- **Screen → Scene:** `scene.screenToScene(point)` — factors out the root's transform: `sceneX = (screenX - tx) / scale`, `sceneY = (screenY - ty) / scale`
- **Scene → Screen:** `scene.sceneToScreen(point)` — applies the root's transform: `screenX = sceneX * scale + tx`
- **Local → Scene:** compose transforms from root to parent

The root element's transform IS the viewport transform. There is no separate viewport state.

## SvgScene: The SVG Backend

`SvgScene` implements `Scene` for SVG diagrams. It is the only backend for now.

```typescript
class SvgScene implements Scene {
  /** Wrapper div that D3-zoom attaches to. Contains the SVG. */
  private container: HTMLDivElement;

  /** The SVG element. Sits inside a transform div inside the container. */
  private svg: SVGSVGElement;

  /** Inner div that receives the viewport CSS transform. */
  private transformDiv: HTMLDivElement;

  /** All SceneElements, keyed by ID. */
  private elements: Map<string, SceneElement>;

  /** Map from element ID to the underlying SVG DOM element. */
  private domElements: Map<string, SVGGElement>;

  /** Map from element ID to its visual <rect>, if any. */
  private visualRects: Map<string, SVGRectElement>;

  /** Cached world bounds, invalidated on transform changes. */
  private worldBoundsCache: Map<string, Rect>;

  constructor(svg: SVGSVGElement) {
    // 1. Create container div and transform div
    // 2. Remove viewBox from SVG, set explicit width/height for 1:1 rendering
    // 3. Walk SVG DOM to build SceneElement tree:
    //    - Root element (id: "root", wraps everything)
    //    - <g data-reflow-group> → SceneElement with reflow-group in metadata
    //    - <g data-interactive> → SceneElement with interactive in metadata
    //    - <g data-arrow> → SceneElement with arrow in metadata
    //    - Single <g> with both data-reflow-group and data-interactive → one SceneElement
    // 4. Cache localBounds via getBBox() on each element (after DOM insertion)
  }

  // --- Key implementation notes ---

  // setTransform(id, transform):
  //   If id === "root":
  //     Apply to transformDiv: style.transform = `translate(${tx}px,${ty}px) scale(${scale})`
  //   Else:
  //     Apply to the <g> element: style.transform = `translate(${tx}px,${ty}px)`
  //     (scale is always 1 for non-root elements — reflow only translates)
  //   Invalidate worldBoundsCache for this element and descendants.

  // getWorldBounds(id):
  //   Compose transforms from root's children down to the element's parent.
  //   (Root's own transform is the viewport — worldBounds are in scene space,
  //    which is root-local space, so root transform is NOT included.)
  //   Apply composed transform to element's localBounds.
  //   Cache the result.

  // screenToScene(point):
  //   Read root element's transform { tx, ty, scale }.
  //   return { x: (point.x - tx) / scale, y: (point.y - ty) / scale }

  // hitTest(scenePoint):
  //   Convert scenePoint to screen coords, call document.elementFromPoint().
  //   Walk up from the hit DOM element with .closest() to find the nearest
  //   ancestor that is a SceneElement (has data-reflow-group, data-interactive,
  //   or data-arrow). Return its ID, or null if none found.
  //   This is more accurate than AABB walking — respects actual SVG shapes.

  // hitTestRect(sceneRect, mode):
  //   Walk all SceneElements that have data-interactive in metadata.
  //   For each: compute worldBounds via getWorldBounds().
  //   If mode === 'intersect': AABB intersection test.
  //   If mode === 'contain': test that worldBounds is fully inside sceneRect.
  //   Return matching IDs.

  // growVisualBounds(id, deltaW, deltaH):
  //   Find the <rect> child of the element's <g>.
  //   Read current width/height attributes, add deltas, write back.
  //   Update element's localBounds.
  //   Invalidate worldBoundsCache.

  // getRenderElement():
  //   Return this.container (the div that D3-zoom attaches to).
}
```

### DOM Structure Created by SvgScene

```html
<!-- container: D3-zoom attaches here, captures pointer events -->
<div class="scene-container" style="width:100%; height:100%; overflow:hidden">
  <!-- transformDiv: receives viewport CSS transform from root SceneElement -->
  <div class="scene-transform" style="transform: translate(tx,ty) scale(s); transform-origin: 0 0">
    <!-- the actual SVG content, rendered at 1:1 -->
    <svg width="1100" height="1400" style="overflow:visible">
      ...diagram content...
    </svg>
  </div>
</div>
```

### How SvgScene Is Created

```typescript
function loadDiagram(html: string): LoadedDiagram {
  // 1. Parse HTML, extract <svg>
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const svg = doc.querySelector('svg')!;

  // 2. Create the Scene (SVG backend)
  const scene: Scene = new SvgScene(svg);

  // 3. Build registries from Scene (not from SVG directly)
  const reflowRegistry = new ReflowGroupRegistry();
  reflowRegistry.buildFromScene(scene);

  const interactiveRegistry = new InteractiveElementRegistry();
  interactiveRegistry.buildFromScene(scene);

  // 4. Create engine
  const reflowEngine = new ReflowEngine();
  reflowEngine.initialize(scene);

  return { scene, reflowRegistry, interactiveRegistry, reflowEngine };

  // Note: D3-zoom attachment and interaction layer setup happen
  // outside loadDiagram(), during InteractionLayer.initialize().

}
```

## What the Scene Boundary Means in Practice

### Framework code that touches Scene (below the boundary)

| Component | What it does |
|---|---|
| `SvgScene` | Implements the interface; holds SVG DOM references |
| `loadDiagram()` | Constructs `SvgScene` from parsed HTML |

### Framework code that talks to Scene (above the boundary)

| Component | Scene methods used |
|---|---|
| `ReflowEngine` | `getElement`, `getLocalBounds`, `setTransform`, `growVisualBounds` |
| `ReflowGroupRegistry` | `getAllElements`, `getChildren` (at build time, filters for reflow-group and arrow roles) |
| `InteractiveElementRegistry` | `getAllElements` (at build time, filters for interactive role) |
| `InteractionLayer` | `hitTest`, `hitTestRect`, `screenToScene`, `sceneToScreen`, `getElement` |
| D3-zoom callback | `setTransform("root", ...)` |

### Framework code that does NOT touch Scene

| Component | Why |
|---|---|
| Application layer | Receives `SelectedElement[]` — doesn't need Scene |
| LLM generation instructions | Operate at the SVG/HTML wire format level — Scene is runtime only |

## Future Backends

When a canvas or three.js backend is needed, it would:

1. Implement `Scene` against a parallel scene graph (e.g., pixi.js display tree, three.js Object3D tree)
2. Parse SVG wire format into that scene graph (or accept a different input format)
3. Build a `SceneElement` tree with the same IDs and metadata
4. Normalize bounds to match `getBBox()` semantics (axis-aligned, local coordinates)
5. Implement `getRenderElement()` returning the backend's own container

The `data-reflow-group` and `data-interactive` contracts in the SVG wire format would remain unchanged — they define the **input** to the system, not the runtime representation.

This is future work. The Scene interface is designed to make it possible, not to implement it now.
