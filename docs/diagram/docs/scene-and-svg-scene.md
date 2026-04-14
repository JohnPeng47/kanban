# Scene & SvgScene

## Overview

#comment: this doc should also become a couple of diagrams

`Scene` is the abstract interface between the diagram framework and the underlying rendering technology. `SvgScene` is its sole implementation, backed by a live SVG DOM tree. The Scene models the diagram as a tree of `SceneElement` nodes, each carrying bounds, transforms, metadata, and parsed role information.

## SceneElement

Every tagged element in the diagram becomes a `SceneElement`:

```ts
interface SceneElement {
  id: string;                        // unique identifier
  parentId: string | null;           // parent in the element tree
  childIds: string[];                // children in document order
  localBounds: Rect;                 // getBBox() result in local coords
  transform: Transform;             // translate + scale for this element
  metadata: Record<string, string>; // all data-* attributes
  hasVisualRect: boolean;            // has direct <rect> child (for reflow)
  interactive: InteractiveData | null; // parsed from data-interactive + data-ref
  reflow: ReflowState | null;        // parsed from data-reflow-group or data-arrow
}
```

IDs are resolved from DOM attributes in priority order:
1. `data-reflow-group` value
2. `data-interactive` value
3. `data-arrow` → auto-assigned `"arrow-{N}"`
4. `"root"` for the SVG element itself

## Scene Interface

The `Scene` interface groups operations into five categories:

```
Scene
├── Element Tree: getRoot, getElement, getAllElements, getChildren
├── Bounds: getLocalBounds, getWorldBounds (cached)
├── Transforms: setTransform, getTransform, getWorldTransform
├── Mutations: growVisualBounds, addElement, removeElement, addSubtree
├── Hit Testing: hitTest(screenPoint), hitTestRect(sceneRect, mode)
├── Rendering: getSvgElement()
└── Lifecycle: destroy()
```

## SvgScene Implementation

### Construction

1. Strip `viewBox` from SVG, set explicit `width`/`height` for 1:1 pixel mapping
2. Set `overflow: visible`, `display: block`
3. Inject interaction CSS styles (hover glow, selection highlight, modal/link dash animations)
4. Build the element tree from DOM

### Element Tree Building

Queries all elements matching `[data-reflow-group], [data-interactive], [data-arrow]`:

```
for each tagged <g>:
  1. resolveElementId(g) → id
  2. readMetadata(g) → all data-* attributes
  3. findVisualRect(g) → direct <rect> child (if any)
  4. Walk DOM ancestry to find nearest tagged parent → parentId
  5. getBBox() → localBounds
  6. parseInteractiveData() if data-interactive present
  7. Create ReflowState if data-reflow-group or data-arrow present
  8. Register in elements map, link to parent
```

A synthetic `"root"` element wraps everything, with bounds set to the SVG's width/height.

### Bounds System

**Local bounds**: Element's `getBBox()` at construction time. Updated by `growVisualBounds`.

**World bounds**: Local bounds transformed through the ancestor chain (excluding root). Cached in `worldBoundsCache`, invalidated recursively when any ancestor's transform changes.

```
getWorldBounds(id):
  parentTransform = compose(ancestor1.transform, ancestor2.transform, ...)
  return transformRect(localBounds, parentTransform)
```

Note: The root transform is excluded from `getAncestorTransform` because the Viewport manages root positioning separately via CSS.

### Transform Management

```
setTransform(id, transform):
  element.transform = transform
  invalidate world bounds cache for id + all descendants
  if id != "root":
    apply CSS translate(tx, ty) to the DOM <g> element
```

Root transform CSS is managed by the Viewport component, not SvgScene. Non-root transforms are used by the reflow engine to displace groups.

`getWorldTransform(id)` composes the full ancestor chain *including* root, producing a transform from local space all the way to screen space.

### Hit Testing

**Point hit test** (`hitTest(screenPoint)`):
1. `document.elementFromPoint(x, y)` — leverages native SVG hit testing for accurate shape detection
2. Walk up to the nearest ancestor matching `[data-reflow-group], [data-interactive], [data-arrow]`
3. Look up that DOM element in the `domElements` map to find its ID

**Rect hit test** (`hitTestRect(sceneRect, mode)`):
- Iterates all interactive elements
- Computes world bounds for each
- Tests intersection or containment with the given scene-space rect
- Returns array of matching element IDs

### Injected CSS Styles

| Selector | Effect |
|----------|--------|
| `[data-interactive]` | `cursor: pointer`, `filter` transition 0.15s |
| `[data-interactive]:hover`, `.selected` | `brightness(1.5)` + glow drop-shadow |
| `.selected > rect:first-of-type` | 2px blue stroke + blue glow |
| `[data-modal] > rect:first-of-type` | Purple dashed border, animated (12s cycle) |
| `[data-link] > rect:first-of-type` | Gold dashed border, animated (10s cycle) |

### Dynamic Element Operations

- `addElement(id, domNode, parentId)` — register a single new element
- `removeElement(id)` — recursively remove element + descendants, clean up all maps
- `addSubtree(rootDomNode, parentId)` — batch-add elements from a DOM subtree, resolving parent relationships both within the subtree and against existing elements

---

## Source References

```
web-ui/src/diagram/rendering/scene.ts
  L3-9      SceneElement doc comment
  L10-44    SceneElement interface
  L46-94    Scene interface
  L48-53      Element tree methods
  L55-58      Bounds methods
  L60-64      Transform methods
  L66-77      Mutation methods
  L79-84      Hit testing methods
  L86-93      Rendering + lifecycle
  L96-108   Role helpers: isReflowGroup, isInteractiveRegion, isArrow

web-ui/src/diagram/rendering/svg-scene.ts
  L15       SCENE_ELEMENT_SELECTOR constant
  L18-29    resolveElementId helper
  L32-40    readMetadata helper
  L43-50    findVisualRect helper
  L52-521   SvgScene class
  L53-58      Private fields: svg, elements, domElements, visualRects, worldBoundsCache, rootId
  L60-80      Constructor: viewBox removal, overflow, style injection, tree build
  L82-124     injectInteractionStyles: hover glow, selection, modal/link dash animations
  L126-206    buildElementTree: root creation, DOM walk, parent resolution, metadata parsing
  L232-236    getLocalBounds
  L238-249    getWorldBounds (with cache)
  L251-267    getAncestorTransform: compose parent chain excluding root
  L271-286    setTransform: update element, invalidate cache, apply CSS (non-root only)
  L294-310    getWorldTransform: compose full chain including root
  L312-320    invalidateWorldBoundsCache: recursive child invalidation
  L324-343    growVisualBounds: resize visual rect + update localBounds
  L347-358    hitTest: elementFromPoint → closest tagged ancestor → ID lookup
  L360-375    hitTestRect: iterate interactive elements, test world bounds
  L379-424    addElement: construct SceneElement from DOM node
  L426-450    removeElement: recursive removal + map cleanup
  L452-494    addSubtree: batch add with parent resolution
  L496-505    nextArrowIndex
  L515-520    destroy: clear all maps

web-ui/src/diagram/types.ts
  L4-9      Rect interface
  L17-22    Transform interface
  L54-64    InteractiveData interface
  L66-69    ReflowState interface
  L142-161  parseInteractiveData
  L188-200  rectsIntersect, rectContains
  L203-210  composeTransforms
  L212-220  transformRect
```
