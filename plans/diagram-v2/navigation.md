# Diagram Navigation — modal & jump

Cross-diagram navigation for the diagram viewer. Two new `data-*` attributes on SVG elements, parsed through the same pipeline as all existing attributes.

---

## 1. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        LLM-generated HTML file                         │
│                                                                        │
│  <g data-interactive="geom"                                            │
│     data-ref="Geometry2d.ts:111"    ← code-ref (source of connection)  │
│     data-modal="geom-anatomy.html"  ← navigation target (new)         │
│     data-category="type"                                               │
│     data-label="Geometry2d"                                            │
│     data-tt="Geometry2d.ts — click to expand">                         │
│                                                                        │
│  Every connection source is a [data-interactive] element that usually  │
│  also carries a data-ref (code-ref). The navigation attributes         │
│  (data-modal, data-link) specify WHERE to go. The element itself IS    │
│  the source — its id, ref, and position are the source metadata.       │
└─────────────────────────────────────────────────────────────────────────┘
        │
        │ HTML string
        ▼
┌──────────────────────────────────────────────┐
│ SvgScene.buildElementTree()                  │
│   svg-scene.ts:100                           │
│                                              │
│   readMetadata() captures ALL data-*         │
│   attributes into element.metadata           │
│   (svg-scene.ts:30-38)                       │
│                                              │
│   No changes needed — new attributes are     │
│   automatically available as:                │
│     metadata.modal                           │
│     metadata["modal-position"]               │
│     metadata.link                            │
└──────────┬───────────────────────────────────┘
           │
           │ Scene (element tree with metadata)
           ▼
┌──────────────────────────────────────────────┐
│ InteractiveElementRegistry.buildFromScene()  │
│   interactive-registry.ts:38                 │
│                                              │
│   Reads: ref, category, label, tt, nav       │
│   NEW: modal, link                           │
│                                              │
│   Produces InteractiveElement with parsed     │
│   DiagramModal / DiagramLink objects          │
└──────────┬───────────────────────────────────┘
           │
           │ InteractiveElement (with .modal / .link)
           ▼
┌──────────────────────────────────────────────┐
│ InteractionLayer.handleSceneClick()          │
│   interaction-layer.tsx:208                  │
│                                              │
│   Fires onNavigate(element, domEvent)        │
│   (unchanged — InteractionLayer doesn't      │
│    know about modal/link)                    │
└──────────┬───────────────────────────────────┘
           │
           │ onNavigate callback
           ▼
┌──────────────────────────────────────────────┐
│ DiagramContentArea.handleNavigate()          │
│   diagram-content-area.tsx                   │
│                                              │
│   alt+click  → fireCodeJump(element)         │
│   .modal set → openPopup(modal)              │
│   .link set  → executeJump(link)             │
│   neither    → fireCodeJump(element)         │
└──────────────────────────────────────────────┘
```

### Isolation from reflow

Navigation is completely isolated from the reflow system. They share the Scene element tree but operate on orthogonal metadata:

```
SceneElement
  ├─ metadata["reflow-group"]  ──→  ReflowGroupRegistry  ──→  ReflowEngine
  ├─ metadata["expandable"]    ──→  ReflowEngine (expand/collapse)
  ├─ metadata["interactive"]   ──→  InteractiveElementRegistry
  ├─ metadata["ref"]           ──→  InteractiveElement.ref (code-ref)
  ├─ metadata["modal"]         ──→  InteractiveElement.modal (NEW)
  └─ metadata["link"]          ──→  InteractiveElement.link (NEW)
```

- Reflow reads: `reflow-group`, `expandable`, `expand-src`, `expand-w/h`, `reflow-displace`, `reflow-dy`
- Navigation reads: `modal`, `modal-position`, `link`
- Both read through `SceneElement.metadata` but never touch each other's keys
- A modal overlay creates a **separate Scene** — it never modifies the parent Scene's element tree, transforms, or reflow state
- A jump replaces the current Scene entirely (new HTML → new `useDiagram` → new `SvgScene`)

An element can carry both reflow and navigation attributes (e.g. `data-reflow-group` + `data-modal`). The click handler precedence resolves this: expandable is checked first in `InteractionLayer`, modal/link are checked after in `DiagramContentArea`.

---

## 2. LLM-generated interface

The LLM produces an HTML file containing an SVG. Every visual block can carry `data-*` attributes that the runtime reads. Two new attributes join the existing set:

### Full attribute vocabulary

| Attribute | System | Purpose |
|---|---|---|
| `data-interactive` | Interaction | Marks element as selectable, required for all below |
| `data-ref` | Interaction | Code-ref: `file:line` or `file:startLine-endLine` |
| `data-category` | Interaction | Classification: `module`, `function`, `type`, `data`, `flow`, `call`, `concept`, `annotation` |
| `data-label` | Interaction | Short display name |
| `data-tt` | Interaction | Tooltip text |
| `data-nav` | Interaction | Override navigation target (alternative code-ref) |
| **`data-modal`** | **Navigation** | **Relative path to diagram to open as overlay** |
| **`data-modal-position`** | **Navigation** | **Overlay position hint: `above-left` / `below-right` / `auto` (default)** |
| **`data-link`** | **Navigation** | **`path` or `path#elementId` — jump target** |
| `data-reflow-group` | Reflow | Group ID for displacement engine |
| `data-expandable` | Reflow | Marks group as expand/collapse capable |
| `data-expand-src` | Reflow | Path to sub-diagram for inline expansion |
| `data-expand-w/h` | Reflow | Expanded dimensions |
| `data-reflow-displace` | Reflow | Compact displacement targets |
| `data-reflow-dy` | Reflow | Compact displacement amount |
| `data-arrow` | Reflow | Marks element as a connector between groups |

### Connection source = the element itself

A connection always originates from a `[data-interactive]` element. The source side of the connection is the element's own identity:

```xml
<g data-interactive="geometry-overview"              ← source element ID
   data-ref="Geometry2d.ts:111"                      ← source code-ref
   data-category="type"                              ← source classification
   data-modal="geometry-anatomy.html"                ← target: open this as overlay
   data-modal-position="below-right">
```

The element's `data-interactive` ID and `data-ref` (code-ref) are the source. The `data-modal` or `data-link` value is the target. Both are captured together because they live on the same `<g>`. This is why the source is almost always a code-ref — the typical case is "this element references `Foo.ts:42`, and clicking it opens the diagram that explains `Foo`."

### `data-modal` — pop-up overlay

```
data-modal="<relative-path>.html"
data-modal-position="below-right"     (optional, default "auto")
```

Path is relative to the current diagram's directory (same convention as `data-expand-src`).

Position values: `above-left`, `above-right`, `below-left`, `below-right`, `left`, `right`, `auto`.

**Example:**
```xml
<g data-interactive="geometry-overview"
   data-ref="packages/editor/src/lib/primitives/geometry/Geometry2d.ts"
   data-category="type"
   data-label="Geometry2d"
   data-modal="geometry-anatomy.html"
   data-modal-position="below-right"
   data-tt="Geometry2d.ts — click to expand anatomy">
  <rect x="40" y="290" width="480" height="50" rx="3"
        fill="#2D3339" stroke="#A371F7" stroke-width="0.6"/>
  <text x="52" y="315" class="violet">Geometry2d</text>
</g>
```

### `data-link` — jump navigation

```
data-link="<relative-path>.html#<target-element-id>"
data-link="<relative-path>.html"
```

- `#elementId` is the `data-interactive` ID on the target diagram. Runtime loads the target, finds the element, centers viewport on it.
- If `#elementId` is omitted, viewport centers on root.

**Example:**
```xml
<g data-interactive="atom-ref"
   data-ref="packages/state/src/lib/Atom.ts:75"
   data-category="type"
   data-label="Atom"
   data-link="reactive-primitives.html#atom-detail"
   data-tt="Atom.ts:75 — jump to reactive primitives">
  <text x="52" y="315" class="blue">Atom</text>
</g>
```

---

## 3. Data model

All types in `web-ui/src/diagram/types.ts`.

### Connection types

```ts
export type OverlayPosition =
  | "above-left" | "above-right"
  | "below-left" | "below-right"
  | "left" | "right" | "auto";

/** A modal connection: source element → overlay diagram. */
export interface DiagramModal {
  source: {
    elementId: string;           // data-interactive ID of the trigger
    ref: string | null;          // data-ref on the trigger (code-ref)
  };
  target: {
    path: string;                // relative path to overlay diagram HTML
    position: OverlayPosition;
  };
}

/** A link connection: source element → target element on another diagram. */
export interface DiagramLink {
  source: {
    elementId: string;           // data-interactive ID of the trigger
    ref: string | null;          // data-ref on the trigger (code-ref)
  };
  target: {
    path: string;                // relative path to target diagram HTML
    elementId: string | null;    // data-interactive ID on target, or null for root
  };
}
```

Both types model the full edge: source (element + code-ref) and target (path + anchor). The source fields are populated from the `InteractiveElement` that carries the attribute.

### Parsers

```ts
export function parseModal(
  elementId: string,
  ref: string | null,
  raw: string,
  position?: string,
): DiagramModal {
  return {
    source: { elementId, ref },
    target: {
      path: raw,
      position: (position as OverlayPosition) ?? "auto",
    },
  };
}

export function parseLink(
  elementId: string,
  ref: string | null,
  raw: string,
): DiagramLink {
  const hashIndex = raw.indexOf("#");
  return {
    source: { elementId, ref },
    target: hashIndex === -1
      ? { path: raw, elementId: null }
      : { path: raw.slice(0, hashIndex), elementId: raw.slice(hashIndex + 1) },
  };
}
```

### InteractiveElement extension

In `interactive-registry.ts:6`:

```ts
export interface InteractiveElement {
  id: string;
  ref: string;
  parsedRef: ParsedRef;
  category: InteractiveCategory;
  label: string;
  tooltip: string | null;
  navTarget: ParsedRef;
  modal: DiagramModal | null;    // NEW — parsed from data-modal
  link: DiagramLink | null;      // NEW — parsed from data-link
}
```

Parsed in `parseInteractiveElement` from `sceneElement.metadata`:
```ts
const modalRaw = sceneElement.metadata.modal;
const modal = modalRaw
  ? parseModal(id, ref, modalRaw, sceneElement.metadata["modal-position"])
  : null;

const linkRaw = sceneElement.metadata.link;
const link = linkRaw ? parseLink(id, ref, linkRaw) : null;
```

### Relationship to Scene layers

```
Scene
 │
 ├─ SceneElement tree (svg-scene.ts)
 │    Universal. Every tagged <g> is a SceneElement.
 │    Holds raw metadata, localBounds, transforms.
 │    Shared by all consumers.
 │
 ├─ ReflowGroupRegistry (reflow/registry.ts)
 │    Projects SceneElements where metadata["reflow-group"] exists.
 │    Builds containment tree. Tracks displacement.
 │    Reads: reflow-group, expandable
 │    Writes: scene.setTransform(), scene.growVisualBounds()
 │
 ├─ InteractiveElementRegistry (interaction/interactive-registry.ts)
 │    Projects SceneElements where metadata["interactive"] exists.
 │    Parses ref, category, label, tooltip, nav, modal, link.
 │    Read-only — never mutates the Scene.
 │
 └─ InteractionLayer (interaction/interaction-layer.tsx)
      Consumes Scene (hit testing) + InteractiveElementRegistry (element metadata).
      Manages selection state, tooltip, click dispatch.
      Fires onNavigate(element, domEvent) to application layer.
      Does NOT know about modal/link — that's DiagramContentArea's concern.
```

---

## 4. Click resolution

### Current flow

```
1. expandable ancestor? → onExpand       (InteractionLayer)
2. interactive element? → onNavigate     (InteractionLayer → DiagramContentArea)
3. nothing hit          → clear selection
```

### New flow

InteractionLayer is unchanged. DiagramContentArea's `handleNavigate` callback branches:

```
InteractionLayer.handleSceneClick
  │
  ├─ expandable ancestor found → onExpand (unchanged, reflow concern)
  │
  ├─ interactive element found → onNavigate(element, domEvent)
  │   │
  │   └─► DiagramContentArea.handleNavigate
  │       │
  │       ├─ domEvent.altKey?
  │       │   YES → fireCodeJump(element)     always goes to editor
  │       │
  │       ├─ element.modal set?
  │       │   YES → openPopup(element.modal)  overlay another diagram
  │       │
  │       ├─ element.link set?
  │       │   YES → executeJump(element.link)  navigate to target
  │       │
  │       └─ neither → fireCodeJump(element)   fall through to editor
  │
  └─ nothing hit → clear selection
```

**Alt+click** always bypasses modal/link and goes straight to the code editor. This gives users a way to reach the source code for elements that also have navigation connections.

**No regression**: when no elements carry `data-modal` or `data-link`, every click falls through to code-jump exactly as today.

---

## 5. Modal overlay

A modal renders a full Diagram in an overlay. It is a completely independent instance of the same rendering pipeline:

```
Parent DiagramContentArea
  │
  ├─ Scene (parent)
  ├─ InteractiveElementRegistry (parent)
  ├─ InteractionLayer (parent, frozen while modal is open)
  ├─ Viewport (parent, pointer events blocked)
  │
  └─ PopupDiagramOverlay (absolutely positioned over content area)
       │
       ├─ useDiagram(modalHtml) → Scene (overlay, independent)
       ├─ InteractiveElementRegistry (overlay, independent)
       ├─ InteractionLayer (overlay, fully interactive)
       └─ Viewport (overlay, independent pan/zoom)
```

- Fully interactive: expand, select, code-jump (alt+click), nested modals, links all work
- Parent is frozen: the overlay captures pointer events before they reach the parent
- Separate Scene: no shared state, no reflow interference
- Close: ESC / X button / click backdrop

### Popup stack

```ts
const [popupStack, setPopupStack] = useState<Array<{
  path: string;                  // resolved path to overlay diagram
  position: OverlayPosition;
  anchorBounds: Rect;            // bounding box of the trigger element
}>>([]);
```

Supports arbitrary nesting — each level is an independent overlay.

### New file

`web-ui/src/components/diagram-panels/popup-diagram-overlay.tsx`

- Absolute-positioned within content area (not a Radix Dialog)
- Backdrop: `bg-surface-0/70 backdrop-blur-sm`
- Container: `border border-border rounded-lg`, inset ~16px
- Own `useDiagram` + `Viewport` + `InteractionLayer`
- Close button top-right

---

## 6. Link/jump

### Viewport imperative handle

New in `viewport.tsx`:

```ts
export interface ViewportHandle {
  centerOn(scenePoint: Point, opts?: { scale?: number; animate?: boolean }): void;
}
```

Exposed via `useImperativeHandle`. Computes transform to center `scenePoint` in the container. Optional CSS transition for animation.

### Same-diagram jump

Scene stays loaded. Resolve target element → `scene.getWorldBounds()` → `viewportRef.centerOn(center, { animate: true })`.

### Cross-diagram jump

1. Set `selectedPath` → triggers Scene teardown + rebuild
2. Stash `pendingJump: { elementId }` in `useDiagramViewer`
3. After new Scene builds, effect resolves target element → `viewportRef.centerOn(center)`
4. Consume pending jump

### URL + back-navigation

- Jumps use `history.pushState` (not `replaceState`)
- URL: `?view=diagram&path=<path>&at=<elementId>`
- `useDiagramViewer` reads `at` on mount for initial centering
- `popstate` listener re-reads params

---

## 7. File changes

| What | Where | Change |
|---|---|---|
| `DiagramModal`, `DiagramLink`, `OverlayPosition`, parsers | `types.ts` | Add types + pure functions |
| `InteractiveElement.modal/link` | `interactive-registry.ts` | Add 2 fields + parse from metadata |
| Click resolution | `diagram-content-area.tsx` | Branch on `.modal` / `.link` / `altKey` in handleNavigate |
| Popup overlay | `popup-diagram-overlay.tsx` | New file |
| Viewport handle | `viewport.tsx` | Add `centerOn` via `useImperativeHandle` |

No new tRPC routes. No sidecar JSON files. No Scene changes. No InteractionLayer changes.

---

## 8. Phasing

### Phase A: data model
- Add `DiagramModal`, `DiagramLink`, parsers to `types.ts`
- Extend `InteractiveElement` with `modal` and `link` fields
- Parse from metadata in `interactive-registry.ts`
- No behavior change

### Phase B: modal
- Alt+click → code-jump; normal click → modal → link → code-jump fallthrough
- `PopupDiagramOverlay` component (fully interactive)
- Popup stack with nesting support

### Phase C: jump
- `ViewportHandle.centerOn` imperative API
- Same-diagram smooth pan / cross-diagram pending jump
- `pushState` for back-nav, URL `&at=` round-trip

---

## 9. Open questions

1. **Popup dismissal**: backdrop click closes topmost only, or entire stack?
2. **Popup sizing**: fit-to-content vs. preserve-current-scale?
3. **Jump animation**: cross-diagram — fade transition or hard-cut?
4. **Visual affordance**: should elements with `data-modal` / `data-link` show a visual indicator?
5. **Alt+click discoverability**: tooltip hint that alt+click goes to editor?
6. **data-modal + data-link on same element**: modal wins (checked first). Correct?
7. **data-modal + data-expandable on same element**: expand wins (checked in InteractionLayer before onNavigate fires). Correct, or should modal override?
