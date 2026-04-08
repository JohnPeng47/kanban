# Interaction Layer

## What It Is

The interaction layer is the runtime component that makes diagrams interactive. It attaches DOM event listeners to the Scene's render element, handles pan/zoom via D3-zoom, manages selection state, and dispatches to registered extension calls.

The LLM generates static, inert SVG — no `onclick`, no `<script>` event wiring. All behavior is attached dynamically at runtime by `InteractionLayer.initialize()`.

## Initialization

```typescript
InteractionLayer.initialize(scene: Scene, registry: InteractiveElementRegistry): void
```

This is called after `loadDiagram()` has parsed the HTML into a Scene. It does three things:

1. **Attaches pointer event listeners** to the Scene's container element
2. **Attaches D3-zoom** to the same container for pan/zoom
3. **Creates an empty ExtensionCallRegistry** (functional with zero handlers)

```typescript
function initialize(scene: Scene, registry: InteractiveElementRegistry) {
  const container = scene.getRenderElement();

  // 1. Pointer events for click and drag-select
  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);

  // 2. D3-zoom for pan/zoom — writes to root SceneElement's transform
  const zoom = d3.zoom()
    .on('zoom', (event) => {
      const { x, y, k } = event.transform;
      scene.setTransform('root', { tx: x, ty: y, scale: k });
    });
  d3.select(container).call(zoom);

  // 3. Extension calls — empty registry, no-op until handlers are registered
  extensionCalls = new ExtensionCallRegistry();
}
```

## Event Flow

### Click

```
Browser fires pointerdown on container
  │  Record pointer position, set didDrag = false
  │
  ▼
Browser fires pointermove (maybe)
  │  If distance > threshold: didDrag = true
  │
  ▼
Browser fires pointerup on container
  │  If didDrag: suppress click, return (was a pan or drag-select)
  │
  ▼
Read event.target — the actual SVG element under the cursor
  │  (e.g., a <text>, a <rect>, a <line>)
  │
  ▼
SvgScene resolves to SceneElement:
  │  event.target.closest('[data-reflow-group], [data-interactive], [data-arrow]')
  │  → finds the nearest ancestor <g> that is a SceneElement
  │  → returns its ID (or null if click was on empty space)
  │
  ▼
InteractionLayer updates selection state:
  │  - element has data-interactive? → add/replace in selection Set
  │  - shift held? → toggle in selection
  │  - null (empty space)? → clear selection
  │  - Apply/remove .selected CSS class on the <g> element
  │
  ▼
InteractionLayer fires extension calls:
  │  extensionCalls.fire('click', { elementId, metadata, ... })
  │  extensionCalls.fire('expand', ...) if element has data-expandable
  │
  ▼
Registered handlers run (if any)
  │  e.g., kanban-navigate: trpc.diagrams.navigate.mutate(...)
  │  e.g., kanban-expand: load content, call engine.groupResized()
  │
  ▼
With zero handlers: nothing happens here. Diagram still works.
```

### Drag-Select

```
pointerdown (not on a SceneElement, or selectionOnDrag mode)
  │  setPointerCapture() on container
  │  Disable D3-zoom handlers (prevent pan during selection)
  │
  ▼
pointermove
  │  Compute selection rect in screen space
  │  Render selection rectangle (a div overlay, screen-space positioned)
  │  Convert rect to scene space: scene.screenToScene()
  │  scene.hitTestRect(sceneRect, 'intersect') → matching SceneElement IDs
  │  Update selection state (Set<string>)
  │  Apply .selected CSS class on matching elements
  │
  ▼
pointerup
  │  Release pointer capture
  │  Remove selection rectangle div
  │  Re-enable D3-zoom handlers
  │  extensionCalls.fire('select', { selectedIds, selectedElements })
```

### Pan/Zoom

```
D3-zoom receives wheel/drag/pinch gesture on container
  │
  ▼
D3-zoom computes new transform { x, y, k }
  │
  ▼
Zoom callback calls scene.setTransform('root', { tx: x, ty: y, scale: k })
  │
  ▼
SvgScene applies CSS: transformDiv.style.transform = `translate(x,y) scale(k)`
  │
  ▼
Browser compositor propagates to all children via transform inheritance
  │  (see docs/learning/css-zoom.md)
  │
  ▼
No JS runs on any child element. Selection highlights, interactive
  regions, everything moves via CSS. Zero per-element updates.
```

## Hit Testing

The interaction layer does NOT implement hit testing. It delegates to `scene.hitTest()`.

For the SVG backend, `hitTest` uses the DOM's native event target resolution:

```typescript
// SvgScene.hitTest(scenePoint):
//   Convert scene point to screen coordinates
//   Call document.elementFromPoint(screenX, screenY)
//   Walk up from the hit element: .closest('[data-reflow-group], [data-interactive], [data-arrow]')
//   Return the SceneElement ID, or null
```

This is more accurate than AABB bounds testing — it respects the actual painted shapes of SVG elements, not just their bounding boxes. A click on transparent space inside a group's bounding box but outside any child element will correctly resolve to the group, not to a child.

For drag-select, `hitTestRect` uses AABB intersection on cached world bounds (there's no DOM equivalent of "elements inside this rectangle"):

```typescript
// SvgScene.hitTestRect(sceneRect, mode):
//   Walk all SceneElements with data-interactive in metadata
//   For each: compute worldBounds via getWorldBounds()
//   AABB intersection (mode='intersect') or containment (mode='contain')
//   Return matching IDs
```

## Selection State

Selection is a `Set<string>` of SceneElement IDs, managed entirely by the interaction layer. It is not persisted — it resets when the diagram is unloaded.

Selection visuals are CSS classes applied directly to the SceneElement's DOM node:

```typescript
function updateSelectionVisual(id: string, selected: boolean) {
  // SvgScene provides access to the underlying <g> element for CSS
  const g = this.domElements.get(id);
  if (g) {
    g.classList.toggle('selected', selected);
  }
}
```

The `.selected` CSS class is defined in the SVG's `<style>` block (or injected by the framework):

```css
.selected > rect:first-of-type {
  stroke: #4C9AFF;
  stroke-width: 2;
  filter: drop-shadow(0 0 4px rgba(76, 154, 255, 0.4));
}
```

Because the `.selected` class is on a `<g>` inside the Scene's render element, it inherits the root's pan/zoom transform automatically. No position syncing needed.

## Pan vs Selection Disambiguation

When `selectionOnDrag` is enabled, the interaction layer must decide: is this drag a pan or a selection?

**Rule:** If the pointerdown target resolves to a SceneElement, it's a potential click (which might become a drag on that element). If the pointerdown target is empty space (hitTest returns null), it starts a selection rectangle.

Pan is handled by D3-zoom, which listens on the same container. During drag-select, the interaction layer disables D3-zoom:

```typescript
// Disable pan during selection
d3.select(container).on('.zoom', null);

// Re-enable after selection ends
d3.select(container).call(zoom);
```

The `didDrag` flag prevents click events from firing after a pan gesture. This replaces the `didPan` flag from `base.html` and the `selectionInProgress` ref from ReactFlow.

## Extension Call Registry

See `integration.md` for the full `ExtensionCallRegistry` interface and the kanban app's registered handlers.

The key design point: the interaction layer works with zero registered extension calls. `fire()` is a no-op on an empty registry. Pan, zoom, selection, click highlighting — all functional without any extensions. Extensions add application-specific behavior (navigate to source, feed selection to LLM) on top.

## Teardown

```typescript
InteractionLayer.destroy(): void
```

Removes all event listeners from the container, destroys the D3-zoom instance, clears selection state, and drops the extension call registry. Called when the diagram is unloaded (e.g., user selects a different diagram in the tree panel, or closes the diagram viewer).
