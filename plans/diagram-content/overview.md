# Diagram Visualization Framework — Overview

## Purpose

A framework that serves as a **base layer** for building interactive code-visualization applications. It takes LLM-generated SVG diagrams (backed by HTML source files), renders them in a pannable/zoomable viewport, and exposes two orthogonal labeling systems — **reflow groups** and **interactive elements** — so that applications built on top can select, query, and act on diagram content.

## Core Primitives

| Primitive | What it is | Who produces it |
|---|---|---|
| **SVG diagram** | An HTML file containing an `<svg>` element with styled, annotated diagram content | LLM (generation) |
| **Reflow group** | A `<g data-reflow-group="…">` wrapper that tells the reflow engine which SVG elements must move as a unit | LLM (labeling) |
| **Interactive element** | A `<g data-interactive="…">` wrapper that marks a visual region as selectable and maps it to source code | LLM (labeling) |
| **Scene** | Rendering abstraction that exposes the SceneElement tree, mutations, hit testing, and coordinate conversion — decouples the framework from SVG DOM | Framework (runtime) |
| **Reflow engine** | Constraint solver that repositions reflow groups when the diagram mutates (expand/collapse, insert/remove) while preserving relative spatial relationships. Operates on `Scene`, not SVG | Framework (runtime) |
| **Interaction layer** | Selection (click, shift+click, drag-select), click propagation control, event routing, and D3-zoom gesture handling. Operates directly on Scene via `hitTest`/`hitTestRect`/`screenToScene` | Framework (runtime) |

## Key Design Principle: Two Labeling Concerns Are Independent

A single SVG element can belong to a reflow group, be an interactive element, both, or neither. The two systems share the same underlying DOM but serve different purposes:

- **Reflow groups** answer: *"What moves together when the layout changes?"*
- **Interactive elements** answer: *"What can the user select and act on?"*

An LLM generating a diagram must annotate both, but the framework treats them as separate data planes. See `reflow_elements.md` and `interactive_elements.md` for the full contracts.

## Architecture Layers
#diagram: I really like this, "stacked progression of the abrtraction layers used in this system" -> save this to .diagrams/diagram_types
```
┌─────────────────────────────────────────────────┐
│  Application Layer                              │
│  (e.g., drag-select → resolve source → LLM)    │
├─────────────────────────────────────────────────┤
│  Interaction Layer                              │
│  Selection, click routing, D3-zoom gestures     │
├─────────────────────────────────────────────────┤
│  Reflow Engine                                  │
│  Constraint solver over data-reflow-group       │
├─────────────────────────────────────────────────┤
│  Scene Interface  (rendering.md)                │
│  SceneElement tree, transforms, hit testing     │
├─────────────────────────────────────────────────┤
│  SvgScene (SVG backend)                         │
│  getBBox, CSS transform, DOM mutation           │
├─────────────────────────────────────────────────┤
│  SVG Diagram (LLM-generated HTML file)          │
└─────────────────────────────────────────────────┘
```

**One coordinate system, no "Viewport" module.** Pan/zoom is D3-zoom writing a transform to the root `SceneElement` — the same `setTransform()` call the reflow engine uses on child elements. The browser's CSS transform composition propagates it to all children. `scene.screenToScene()` reads the root's transform to convert pointer events. There is no separate viewport object, no overlay layer, no second update path. The "viewport" is just the root SceneElement's transform slot plus the gesture recognizer that writes to it.

## Diagram Lifecycle

1. **Generation** — An LLM produces an HTML file containing an SVG diagram. It annotates elements with `data-reflow-group` and `data-interactive` attributes according to the contracts in `reflow_elements.md` and `interactive_elements.md`.

2. **Loading** — The framework parses the HTML, extracts the SVG, and constructs:
   - A `Scene` (currently `SvgScene`) — the rendering abstraction (see `rendering.md`)
   - A reflow group registry (built from Scene, not from SVG directly)
   - An interactive element registry (built from Scene)

3. **Rendering** — The Scene's render element is placed in the DOM. D3-zoom is attached to it, writing pan/zoom gestures to the root SceneElement's transform. The reflow engine caches the initial layout.

4. **Interaction** — User actions (expand/collapse a section, insert a sub-diagram) trigger the reflow engine, which calls Scene mutation methods directly. The Scene's visual representation updates in place — no separate overlay to sync. The interaction layer handles selection and click routing via Scene hit testing.

## File Organization (planned)

```
src/
  framework/
    interaction.ts      — Selection state, click routing, drag-select, D3-zoom setup
    rendering/
      scene.ts          — Scene interface, SceneElement type (see rendering.md)
      svg-scene.ts      — SvgScene: SVG backend implementing Scene
    reflow/
      engine.ts         — ReflowEngine class (see reflow.md)
      registry.ts       — ReflowGroupRegistry, ReflowGroupNode tree
      constraints.ts    — Constraint resolution (containment + adjacency)
    interactive/
      registry.ts       — InteractiveElementRegistry
    loader.ts           — Parses HTML diagram files, produ ces LoadedDiagram
    types.ts            — Shared types (Rect, ParsedRef, Point, etc.)
```

## How the Interfaces Interact

### Initialization Flow

```
HTML string
  │
  ▼
loadDiagram(html)
  │
  ├──► parse HTML, extract <svg>
  │
  ├──► new SvgScene(svg)                          ◄── rendering boundary
  │      SVG DOM is encapsulated here. Nothing above
  │      this line ever touches SVG elements directly.
  │      Output: Scene
  │
  ├──► ReflowGroupRegistry.buildFromScene(scene)
  │      Filters scene.getAllElements() for reflow-group and arrow roles.
  │      Builds the containment tree (ReflowGroupNode[]).
  │      Output: ReflowGroupRegistry
  │
  ├──► InteractiveElementRegistry.buildFromScene(scene)
  │      Filters scene.getAllElements() for those with data-interactive role.
  │      Parses ref, category, label, tooltip from SceneElement metadata.
  │      Output: InteractiveElementRegistry
  │
  ├──► ReflowEngine.initialize(scene)
  │      Takes ownership of the ReflowGroupRegistry.
  │      Holds reference to Scene for mutations.
  │      Ready to accept mutations.
  │
  ├──► InteractionLayer.initialize(scene, interactiveRegistry)
  │      Attaches D3-zoom to scene.getRenderElement()
  │        → writes pan/zoom gestures to scene.setTransform("root", ...)
  │      Registers pointer event handlers on container.
  │      Wires up selection state.
  │
  └──► LoadedDiagram { scene, reflowRegistry, interactiveRegistry,
                        reflowEngine, interactionLayer }
```

### Runtime Reflow Flow (expand/collapse example)

```
User clicks on diagram
  │
  ▼
InteractionLayer.onPointerUp
  │  scene.screenToScene(clickPoint) → scenePoint
  │  scene.hitTest(scenePoint) → SceneElement ID (or null)
  │
  ▼
InteractionLayer checks element metadata:
  │  Has data-interactive? → selection (see Selection Flow below)
  │  Has data-expandable? → emits onElementClick(id) to application
  │  Neither? → clear selection
  │
  ▼
Application receives onElementClick(id)
  │  Application decides what to do.
  │  For expandable: loads sub-diagram HTML,
  │  inserts into Scene (TBD — Scene.insertContent?),
  │  calls engine.groupResized(id, newBounds)
  │
  ▼
engine.groupResized(groupId, newBounds)
  │
  ├──► Has pre-computed script? (see reflow_scripts.md)
  │    YES: apply script (fast path)
  │    NO:  run constraint solver (slow path)
  │    Both paths call:
  │      scene.setTransform() — displacement
  │      scene.growVisualBounds() — parent growth
  │
  ▼
Scene updates visual elements in place
  │  For SVG: sets CSS transform on <g>, mutates <rect> dimensions
  │  Interactive regions move automatically (same DOM elements)
  │  Selection highlights move with elements (same DOM, same transform)
```

**No second update path.** The Scene mutation IS the visual update. There is no overlay to sync, no bridge to notify, no separate position state to reconcile.

### Selection Flow

```
User drag-selects region on viewport
  │
  ▼
InteractionLayer.onPointerDown
  │  setPointerCapture() on container
  │  Record start position in screen space
  │  Disable D3-zoom handlers (prevent pan during selection)
  │
  ▼
InteractionLayer.onPointerMove
  │  Compute selection rect in screen space
  │  Render selection rectangle (div overlay, screen-space positioned)
  │  Convert rect to scene space:
  │    sceneX = (screenX - tx) / tScale
  │    sceneY = (screenY - ty) / tScale
  │  Call scene.hitTestRect(sceneRect, 'intersect')
  │  Update selection state (Set<string> of region IDs)
  │  Apply/remove selection CSS class on hit regions
  │
  ▼
InteractionLayer.onPointerUp
  │  Release pointer capture
  │  Re-enable D3-zoom handlers
  │  Emit onSelectionChange(selectedElements)
  │
  ▼
Application layer receives selected source references
  │  e.g., resolves file paths + line ranges → feeds to LLM
```

### Click Flow

```
User clicks on diagram
  │
  ▼
Browser fires pointerdown on container div
  │
  ▼
InteractionLayer.onPointerDown
  │  Record pointer position, set didDrag = false
  │
  ▼
InteractionLayer.onPointerMove (if any)
  │  If distance > threshold: didDrag = true
  │
  ▼
InteractionLayer.onPointerUp
  │  If didDrag: suppress click, return
  │  Convert click to scene coords:
  │    scene.screenToScene({x: clientX, y: clientY}) → scenePoint
  │  scene.hitTest(scenePoint) → elementId or null
  │
  │  hitTest resolution (SVG backend):
  │    The click lands on a raw SVG element (e.g., <text>).
  │    SvgScene walks up the DOM via .closest() to find the
  │    nearest ancestor <g> that is a SceneElement.
  │    Returns that SceneElement's ID.
  │
  ├──► elementId is not null:
  │      Read element metadata to determine action:
  │      - Has data-interactive? → update selection state
  │        (shift: toggle, else: select only this)
  │      - Emit onElementClick(elementId) to application
  │
  └──► elementId is null:
       Click on empty space → clear selection
```

### Interface Dependency Graph

```
                    ┌──────────────────┐
                    │  Application     │
                    │  Layer           │
                    └───┬─────────┬───┘
                        │         │
      onSelectionChange │         │ engine.groupResized()
      onElementClick    │         │ (after expand/collapse)
                        │         │
                    ┌───▼─────────▼───┐
                    │ InteractionLayer │
                    │ (interaction.ts) │
                    └──┬──────────┬───┘
                       │          │
          reads regions│          │ hitTest / hitTestRect
          + selection  │          │ screenToScene
                       │          │
              ┌────────▼──┐  ┌───▼─────────────┐
              │ Interactive│  │                 │
              │ Element    │  │     Scene       │ (rendering.md)
              │ Registry   │  │  SceneElement   │
              └────────────┘  │     tree        │
                              └──┬──────────┬───┘
                                 │          │
                    reads tree   │          │ setTransform
                    + elements   │          │ growVisualBounds
                                 │          │
                       ┌─────────▼──┐  ┌────▼──────┐
                       │ ReflowGrp  │  │  Reflow   │
                       │ Registry   │  │  Engine   │
                       └────────────┘  └───────────┘
                         ▲                   ▲
                  builds │                   │ groupResized
                  + owns │                   │ (from application)
                         └───────────────────┘

   D3-zoom writes pan/zoom to the root SceneElement:
     scene.setTransform("root", { tx, ty, scale })
   Same method the reflow engine uses on child elements.
```

Key observations:
- **SceneElement is the universal primitive.** Groups, interactive regions, arrows, and the root are all SceneElements differing only by `data-*` metadata. Both the reflow and interaction systems are projections over the same SceneElement tree.
- **One coordinate system.** D3-zoom writes to the root SceneElement's transform. Reflow writes to child elements' transforms. Both use `scene.setTransform()`. CSS composes them. No bifurcation, no separate "viewport" object.
- **No bridge layer.** The ReflowEngine mutates SceneElements directly. Interactive regions move because they ARE the visual elements — not overlays positioned separately.
- **InteractionLayer** reads from both the InteractiveElementRegistry (for metadata: refs, categories, labels) and the Scene (for hit testing and coordinate conversion). It manages selection state internally and dispatches to registered extension calls (see `integration.md`). With zero extensions registered, pan/zoom/selection still work standalone.

## Relationship to Existing Code

The existing `code-viz` VSCode extension provides:
- A static file server for diagrams (`static-server.ts`)
- A navigation API (`/api/navigate`) for jumping to source code
- A multi-window router for coordinating across VSCode instances

This framework **does not replace** that infrastructure. Instead it provides the in-browser rendering layer that the served HTML files will use. The `nav()` function and tooltip system from the current ad-hoc diagrams become standardized framework features that interactive elements can invoke.

## What Each Document Covers

| Document | Scope |
|---|---|
| `rendering.md` | `SceneElement` primitive, `Scene` interface, bounds/transform semantics, `SvgScene` backend |
| `reflow.md` | When reflow triggers, the engine interface (operates on Scene), and how reflow propagates |
| `reflow_elements.md` | The `data-reflow-group` contract, SVG container choice (`<g>` vs `<svg>`), and LLM generation instructions |
| `reflow_scripts.md` | Pre-computed reflow animation scripts: format, short-circuit logic, overflow detection, testing |
| `interactive_elements.md` | The `data-interactive` contract, classification scheme, and LLM generation instructions |
| `interaction.md` | Interaction layer: event listeners, hit testing, selection state, pan/zoom, extension call dispatch |
| `integration.md` | Kanban integration, `ExtensionCallRegistry` interface, navigate/select/expand data flows |
| `prompt-diagram-gen.md` | LLM prompt for generating diagrams with both reflow groups and interactive elements |
| `prompt-animation.md` | LLM prompt for generating pre-computed reflow animation scripts |
| `react-flow-migration.md` | Implementation reference for pan/zoom/selection/click-handling |
