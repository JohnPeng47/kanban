# Diagram system — layer boundaries

Documents the exact interaction boundaries between the five layers of the diagram system: who reads what, who mutates what, and where data flows between layers.

---

## Layer map

```
┌──────────────────────────────────────────────────────────────────────────┐
│ DiagramContentArea / DiagramScene                                        │
│   diagram-content-area.tsx                                               │
│                                                                          │
│   Orchestrates everything. Creates Scene, builds registries,             │
│   defines callbacks (handleNavigate, handleExpand).                      │
│   Directly manipulates DOM for expand/collapse visual toggle.            │
└──────┬──────────┬──────────────┬──────────────┬──────────────────────────┘
       │          │              │              │
       │          │              │              │
  ┌────▼────┐ ┌──▼──────────┐ ┌▼────────────┐ │
  │ useDia- │ │ Interactive  │ │ useReflow-  │ │
  │ gram()  │ │ Element      │ │ Engine()    │ │
  │         │ │ Registry     │ │             │ │
  │ builds  │ │              │ │ owns expand │ │
  │ Scene   │ │ read-only    │ │ state +     │ │
  │         │ │ after build  │ │ scripts     │ │
  └────┬────┘ └──────┬───────┘ └──────┬──────┘ │
       │             │                │         │
       ▼             ▼                ▼         │
  ┌────────────────────────────────────────┐    │
  │ Scene (SvgScene)                       │    │
  │   svg-scene.ts                         │    │
  │                                        │    │
  │   Universal element tree. Owns all     │    │
  │   SceneElements, bounds, transforms.   │    │
  │   The only layer that touches SVG DOM. │    │
  └────────────────────────────────────────┘    │
                                                │
  ┌─────────────────────────────────────────────▼──┐
  │ InteractionLayer + Viewport                     │
  │   interaction-layer.tsx, viewport.tsx            │
  │                                                 │
  │   Viewport: pan/zoom, mounts SVG, writes root   │
  │   transform. InteractionLayer: hit testing,      │
  │   selection, tooltip, click dispatch.            │
  └─────────────────────────────────────────────────┘
```

---

## Per-layer detail

### SvgScene (`svg-scene.ts`)

The mutation hub. Only three external call paths mutate it after construction:

| Caller | Method | What it does |
|---|---|---|
| Viewport | `setTransform("root", t)` | Syncs pan/zoom to root element |
| useReflowEngine | `setTransform(id, t)` | Displaces groups/arrows during expand/collapse |
| useReflowEngine | `growVisualBounds(id, dw, dh)` | Resizes visual rects during expand/collapse |

Read-only consumers:

| Caller | Methods used |
|---|---|
| ReflowGroupRegistry | `getAllElements()`, `getLocalBounds(id)` — during `buildFromScene` only |
| InteractiveElementRegistry | `getAllElements()` — during `buildFromScene` only |
| InteractionLayer | `hitTest(screenPoint)`, `hitTestRect(rect, mode)`, `getElement(id)`, `getSvgElement()` |
| Viewport | `getSvgElement()` — mounting SVG into DOM |
| DiagramContentArea | `getSvgElement()`, `getElement(id)` — during expand flow |

Internal maps (`elements`, `domElements`, `visualRects`, `worldBoundsCache`) are private. No external code reaches in.

### ReflowGroupRegistry (`reflow/registry.ts`)

Built once per Scene via `buildFromScene(scene)`. After that:

| Field | Mutable after build? | Who mutates? |
|---|---|---|
| `roots: ReflowGroupNode[]` | No | — |
| `groupsById: Map<string, ReflowGroupNode>` | No (map structure) | — |
| `arrows: ArrowNode[]` | No | — |
| `arrowsById: Map<string, ArrowNode>` | No | — |
| `ReflowGroupNode.displacement` | **Yes** | `useReflowEngine.toggleExpand()` only |
| `ReflowGroupNode.parent/children` | No | — |
| `ArrowNode.displacement` | **Yes** | `useReflowEngine.toggleExpand()` only |

`displacement` is the only mutable field. It accumulates across `toggleExpand` calls — each expand adds `+dy`, each collapse adds `-dy`. The accumulated value is then written to Scene via `scene.setTransform()`. No external code reads `displacement` directly — it's internal bookkeeping for the reflow engine.

There is no public API to mutate the registry structure (add/remove groups, reparent). The only mutation path is `displacement` via `toggleExpand`.

### InteractiveElementRegistry (`interaction/interactive-registry.ts`)

**Truly immutable after `buildFromScene()`.** The `elements` Map and every `InteractiveElement` object within it are never modified after creation.

| Consumer | Access pattern |
|---|---|
| InteractionLayer | `registry.get(id)` — on every click, lasso, and selection event |
| DiagramContentArea | Creates it, passes to InteractionLayer. Never reads it directly. |

No external code adds, removes, or modifies `InteractiveElement` objects. The registry is rebuilt from scratch when a new Scene is created (new diagram loaded).

### useReflowEngine (`use-reflow-engine.ts`)

The bridge between the reflow registry and the Scene mutation API.

| What it does | How |
|---|---|
| Builds registry | `ReflowGroupRegistry.buildFromScene(scene)` — once per Scene |
| Parses scripts | Reads `<script type="application/reflow+json">` from DOM via `svg.querySelector` |
| Expands/collapses | `toggleExpand(groupId)`: reads script, mutates `node.displacement`, calls `scene.setTransform()` + `scene.growVisualBounds()` |
| Tracks state | `expandedRef: Set<string>` — which groups are currently expanded |

Exposed to DiagramContentArea:
- `toggleExpand(groupId): boolean`
- `isExpanded(groupId): boolean`
- `registry: ReflowGroupRegistry` (exposed but only used internally)

### InteractionLayer (`interaction-layer.tsx`)

**Read-only consumer of both Scene and InteractiveElementRegistry.** Never mutates either.

| What it reads | From where |
|---|---|
| Hit testing | `scene.hitTest()`, `scene.hitTestRect()` |
| Expandable walk | `scene.getElement(id)` + `isExpandable(el)` — walks parent chain |
| Element metadata | `interactiveRegistry.get(id)` |
| SVG access | `scene.getSvgElement()` — for tooltip event listeners |

| What it writes | Where |
|---|---|
| CSS classes | Direct DOM: `g.classList.toggle("selected", ...)` — visual only, not Scene state |
| React state | `selectedIds`, `dragPreviewIds` — local component state |

Callbacks fired to application layer:

| Callback | When |
|---|---|
| `onExpand(elementId)` | Click resolves to an expandable ancestor |
| `onNavigate(element, domEvent)` | Click on interactive element, no expandable ancestor |
| `onSelectionChange(elements)` | Selection set changes (click, shift-click, lasso) |

**InteractionLayer does NOT access ReflowGroupRegistry.** It checks `isExpandable` via `scene.getElement()` metadata, not through the reflow registry.

### Viewport (`viewport.tsx`)

| What it does | How |
|---|---|
| Mounts SVG | `scene.getSvgElement()` → `transformDiv.appendChild(svg)` |
| Pan/zoom | Writes `scene.setTransform("root", t)` to keep Scene in sync |
| Coordinate conversion | `screenToScene()` using current transform ref |
| Hit delegation | Fires `ViewportSceneEvent` to InteractionLayer via `onSceneClick` |

The Viewport is the only code that writes to the root SceneElement's transform. All other `setTransform` calls target child elements (reflow displacements).

### DiagramContentArea (`diagram-content-area.tsx`)

The orchestrator. Doesn't own any state itself — delegates to hooks and components.

| Responsibility | Implementation |
|---|---|
| Creates Scene | `useDiagram(content)` |
| Creates registries | `new InteractiveElementRegistry().buildFromScene(scene)` |
| Creates reflow engine | `useReflowEngine(scene)` |
| Handles code-jump | `handleNavigate` → tRPC `diagrams.navigate.mutate()` |
| Handles expand/collapse | `handleExpand` → DOM manipulation + `reflow.toggleExpand()` |
| Mounts interaction layer | `<InteractionLayer scene={scene} interactiveRegistry={registry} ...>` |

The expand flow is the most complex cross-layer operation:

```
InteractionLayer.onExpand(elementId)
  │
  └─► DiagramContentArea.handleExpand(elementId)
        │
        ├─ reflow.isExpanded(elementId)?
        │   YES (collapse):
        │     ├─ DOM: show .collapsed-content, clear .expanded-content
        │     └─ reflow.toggleExpand(elementId)
        │          ├─ registry: node.displacement -= dy
        │          ├─ scene.setTransform(affected_ids, ...)
        │          └─ scene.growVisualBounds(affected_ids, ...)
        │
        │   NO (expand):
        │     ├─ Read data-expand-src/w/h from DOM
        │     ├─ Fetch sub-diagram HTML via tRPC
        │     ├─ scene.getElement(elementId) → bounds
        │     ├─ DOM: create nested <svg>, hide .collapsed-content
        │     └─ reflow.toggleExpand(elementId)
        │          ├─ registry: node.displacement += dy
        │          ├─ scene.setTransform(affected_ids, ...)
        │          └─ scene.growVisualBounds(affected_ids, ...)
```

---

## Data flow rules

1. **Scene → Registries**: one-directional at build time. `buildFromScene()` reads Scene, produces registry. Registries never influence Scene initialization.

2. **Registry → Scene**: one-directional at expand time. `toggleExpand()` reads registry displacement state, writes Scene transforms. This is the only feedback loop.

3. **InteractionLayer → Scene**: read-only. Hit testing and element metadata lookup. Never mutates.

4. **InteractionLayer → Application**: callbacks only. `onExpand`, `onNavigate`, `onSelectionChange`. Application decides what to do.

5. **Viewport → Scene**: writes root transform only. No other element is touched by Viewport.

6. **No circular dependencies**: Scene → Registries → (via reflow engine) → Scene is a controlled loop, not a cycle. The reflow engine mediates all writes.

---

## Where navigation fits

Navigation (modal + link) adds zero new mutation paths. It reads from `InteractiveElement.modal` and `InteractiveElement.link` — fields parsed at registry build time from existing metadata. The click dispatch happens in `DiagramContentArea.handleNavigate`, which is already the application-layer callback from InteractionLayer.

```
InteractionLayer.onNavigate(element, domEvent)
  │
  └─► DiagramContentArea.handleNavigate
        │
        ├─ altKey? → fireCodeJump (existing path)
        ├─ element.modal? → openPopup (new: push overlay, separate Scene)
        ├─ element.link? → executeJump (new: change selectedPath or pan)
        └─ fallthrough → fireCodeJump (existing path)
```

A modal overlay creates a **new, independent** DiagramContentArea with its own Scene, registries, and InteractionLayer. No state is shared with the parent. A jump tears down the current Scene and builds a new one (same as selecting a different diagram from the tree panel).
