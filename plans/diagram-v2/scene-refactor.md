# Scene refactor — unified SceneElement, dynamic nodes

Merges `ReflowGroupRegistry` and `InteractiveElementRegistry` onto `SceneElement`. Removes expand/collapse and reflow script execution. Renames InteractionLayer → SceneInput. Adds dynamic node creation.

---

## 1. What gets removed

| Feature | Files | Why |
|---|---|---|
| Inline expand/collapse | `handleExpand` in `diagram-content-area.tsx` | DOM manipulation that inserts content invisible to framework. Replaced by modal overlays (separate Scene) or dynamic `addSubtree`. |
| Reflow script parsing | `parseAllScripts`, `parseCompactScript`, `parseScriptFromDom` in `use-reflow-engine.ts` | Reaches through Scene to SVG DOM to read `<script>` tags. Leaks through the Scene abstraction. |
| Reflow script playback | `toggleExpand` body in `use-reflow-engine.ts` | Displacement accumulation + `scene.setTransform` + `scene.growVisualBounds`. All in service of inline expand. |
| ReflowGroupRegistry | `reflow/registry.ts` | Parallel containment tree with `getSiblings()` (dead code). Only used for flat ID lookups. |
| InteractiveElementRegistry | `interaction/interactive-registry.ts` | Parsed projection of metadata. Moving onto SceneElement. |
| Expand attributes | `data-expandable`, `data-expand-src`, `data-expand-w`, `data-expand-h` | Entire expand vocabulary removed from the runtime. LLMs stop emitting these. |
| Expand DOM structure | `.collapsed-content`, `.expanded-content` child groups | No longer needed without inline expand. |
| `ReflowScript` type | `types.ts` | Script format for pre-computed reflow animations. |

### What stays

| What | Why |
|---|---|
| `SceneElement.reflow` field | Marks whether an element participates in reflow (future use). |
| `scene.setTransform()` | Viewport uses it for pan/zoom. Future reflow will use it. |
| `scene.growVisualBounds()` | Future reflow will use it. |
| `data-reflow-group` attribute | LLMs keep emitting it. Parsed into `SceneElement.reflow`. No runtime behavior yet. |
| `data-arrow` attribute | Parsed into metadata. Used for visual identification. |

---

## 2. Unified SceneElement

### Before (three representations)

```
SceneElement("geom")              ← svg-scene: raw metadata, bounds, transform
ReflowGroupNode("geom")          ← reflow/registry: displacement, originalBounds, containment tree
InteractiveElement("geom")       ← interactive-registry: parsed ref, category, label, modal, link
```

### After (one)

```ts
export interface SceneElement {
  // ─── identity (unchanged) ───
  id: string;
  parentId: string | null;
  childIds: string[];

  // ─── geometry (unchanged) ───
  localBounds: Rect;
  transform: Transform;
  hasVisualRect: boolean;

  // ─── raw metadata (unchanged) ───
  metadata: Record<string, string>;

  // ─── parsed roles (NEW) ───
  interactive: InteractiveData | null;
  reflow: ReflowState | null;
}
```

#### InteractiveData

```ts
export interface InteractiveData {
  ref: string;
  parsedRef: ParsedRef;
  category: InteractiveCategory;
  label: string;
  tooltip: string | null;
  navTarget: ParsedRef;
  modal: DiagramModal | null;
  link: DiagramLink | null;
}
```

#### ReflowState

```ts
export interface ReflowState {
  originalBounds: Rect;          // snapshot at construction
}
```

No `displacement`, no `expandable`. Reflow is a marker only — the data is there for when execution is re-implemented.

#### Role checks

```ts
export function isReflowGroup(el: SceneElement): boolean {
  return el.reflow !== null;
}

export function isInteractiveRegion(el: SceneElement): boolean {
  return el.interactive !== null;
}

export function isArrow(el: SceneElement): boolean {
  return "arrow" in el.metadata;
}
```

`isExpandable` is removed.

---

## 3. Event routing — Viewport → SceneInput → DiagramContentArea

Rename: `InteractionLayer` → `SceneInput`. It's the input processing layer for the Scene — resolves what the user clicked, manages selection state, dispatches to the application layer. It doesn't decide what to do with clicks.

### Pipeline

```
Browser pointer events
  │
  ▼
Viewport (viewport.tsx)
  │  Owns: pointerdown, pointermove, pointerup, wheel, pinch
  │  Classifies gesture: pan / zoom / pinch / ctrl+drag lasso / click
  │  Converts coordinates: screenToScene() using current {tx, ty, scale}
  │  Consumes: pan, zoom, pinch (no callback fired)
  │
  │  Fires to SceneInput:
  │  ├─ onSceneClick({ scenePoint, screenPoint, domEvent })     ← single click
  │  ├─ onSelectionDrag(sceneRect)                              ← lasso in progress
  │  └─ onSelectionDragEnd(sceneRect)                           ← lasso completed
  │
  ▼
SceneInput (scene-input.tsx, renamed from interaction-layer.tsx)
  │  Owns: selection state, tooltip, hit testing
  │  Receives pre-classified events from Viewport
  │  Also listens directly: mouseover/out/move on SVG for tooltip (hover, not gesture)
  │
  │  On click:
  │  1. scene.hitTest(screenPoint) → elementId
  │  2. scene.getElement(elementId) → SceneElement
  │  3. Update selection (shift-click toggle, single select, clear)
  │  4. element.interactive exists → onNavigate(interactive, domEvent)
  │
  │  On lasso end:
  │  1. scene.hitTestRect(sceneRect) → elementIds
  │  2. Filter to interactive elements
  │  3. Update selection set
  │  4. Collect refs, copy to clipboard
  │  5. onSelectionChange(elements)
  │
  │  Fires to DiagramContentArea:
  │  ├─ onNavigate(interactive, domEvent)
  │  └─ onSelectionChange(elements)
  │
  ▼
DiagramContentArea (diagram-content-area.tsx)
  │  The application-level router. Decides what a click means.
  │
  │  handleNavigate(interactive, domEvent):
  │  ├─ altKey?       → fireCodeJump()           extension opens file in editor
  │  ├─ .modal set?   → openPopup()              push overlay, new Scene
  │  ├─ .link set?    → executeJump()            pan or swap diagram
  │  └─ neither        → fireCodeJump()           fallthrough to editor
  │
  │  handleSelectionChange(elements):
  │  └─ (currently unused at this level, available for future features)
```

### What SceneInput does NOT do

- Does not handle pan/zoom (Viewport)
- Does not know about modal/link navigation (DiagramContentArea)
- Does not mutate Scene state (read-only: hitTest, getElement)
- Does not access reflow state
- Does not classify raw pointer gestures (Viewport does that)

### What Viewport does NOT do

- Does not hit-test against Scene elements
- Does not know about selection
- Does not know about interactive elements or their metadata
- Does not fire callbacks for pan/zoom/pinch (consumes them internally)

### Tooltip is the exception

SceneInput listens directly to `mouseover`/`mousemove`/`mouseout` on `scene.getSvgElement()`. These bypass Viewport because they're hover behavior — no gesture classification needed, no coordinate conversion, just "is the mouse over a `[data-tt]` element?"

---

## 4. Scene mutation API

### addElement

```ts
addElement(id: string, domNode: SVGGElement, parentId: string): SceneElement
```

1. `readMetadata(domNode)` → metadata
2. `domNode.getBBox()` → localBounds
3. `parseRoles(id, metadata, localBounds)` → `{ interactive, reflow }`
4. Create SceneElement, add to `elements` map
5. Add to parent's `childIds`
6. Store in `domElements`, check for visual rect → `visualRects`
7. Invalidate world bounds cache
8. Return new SceneElement

### removeElement

```ts
removeElement(id: string): void
```

1. Recursively remove descendants (depth-first)
2. Remove from parent's `childIds`
3. Remove from `elements`, `domElements`, `visualRects`
4. Invalidate world bounds cache
5. Does NOT touch DOM — caller handles that

### addSubtree

```ts
addSubtree(rootDomNode: SVGElement, parentId: string): SceneElement[]
```

Walks `rootDomNode` for tagged elements (`[data-reflow-group], [data-interactive], [data-arrow]`), calls `addElement` for each. Returns new elements.

---

## 5. Parsing

Metadata parsing moves into `SvgScene` as a private method. Called in `buildElementTree()` and `addElement()`:

```ts
private parseRoles(id: string, metadata: Record<string, string>, bounds: Rect): {
  interactive: InteractiveData | null;
  reflow: ReflowState | null;
} {
  const interactive = metadata.interactive !== undefined
    ? this.parseInteractive(id, metadata)
    : null;

  const reflow = metadata["reflow-group"] !== undefined || metadata.arrow !== undefined
    ? { originalBounds: { ...bounds } }
    : null;

  return { interactive, reflow };
}
```

`parseInteractive` absorbs the logic from `InteractiveElementRegistry.parseInteractiveElement`:
- Reads: `ref`, `category`, `label`, `tt`, `nav`, `modal`, `modal-position`, `link`
- Produces: `InteractiveData` with parsed `DiagramModal` / `DiagramLink`

---

## 6. useReflowEngine → stub

```ts
export function useReflowEngine(_scene: Scene | null): null {
  return null;
}
```

Returns null. No methods, no state. Callers that check `if (reflow)` before calling methods will skip cleanly. When reflow execution is re-implemented, this hook returns an object with the new API.

---

## 7. SceneInput props (renamed from InteractionLayerProps)

```ts
export interface SceneInputProps {
  scene: Scene;
  onNavigate?: (interactive: InteractiveData, domEvent: PointerEvent) => void;
  onSelectionChange?: (elements: InteractiveData[]) => void;
  children?: ReactNode;
}
```

Removed from current InteractionLayerProps:
- `interactiveRegistry` — reads from `scene.getElement(id).interactive` instead
- `onExpand` — expand is removed
- `selectMode` — can be re-added if needed

---

## 8. File changes

### Deleted

| File | Reason |
|---|---|
| `web-ui/src/diagram/reflow/registry.ts` | State on SceneElement.reflow |
| `web-ui/src/diagram/interaction/interactive-registry.ts` | State on SceneElement.interactive |

### Renamed

| Before | After |
|---|---|
| `web-ui/src/diagram/interaction/interaction-layer.tsx` | `web-ui/src/diagram/input/scene-input.tsx` |

### Modified

| File | Changes |
|---|---|
| `scene.ts` | SceneElement gains `interactive`, `reflow`. `isExpandable` removed. |
| `svg-scene.ts` | `buildElementTree` calls `parseRoles`. New `addElement`, `removeElement`, `addSubtree`. Absorbs parsing from deleted registries. |
| `types.ts` | Add `InteractiveData`, `ReflowState`, `DiagramModal`, `DiagramLink`, `OverlayPosition`. Remove `ReflowScript`. |
| `use-reflow-engine.ts` | Gutted to `return null`. |
| `diagram-content-area.tsx` | Remove registry creation, remove `handleExpand`, remove `onExpand` wiring. Add navigation routing in `handleNavigate`. |

### Unchanged

| File | Why |
|---|---|
| `viewport.tsx` | Only touches root transform. No registry interaction. |
| `use-diagram.ts` | Only builds Scene from HTML. |

---

## 9. Migration order

### Step 1: Extend SceneElement + parse roles

Add `interactive` and `reflow` to SceneElement. Parse in `buildElementTree`. Keep registries alive — dual-write so both paths produce the same data. Verify nothing breaks.

### Step 2: Rename InteractionLayer → SceneInput

Rename file, component, props interface. Drop `interactiveRegistry` prop — read from `scene.getElement(id).interactive`. Drop `onExpand` prop. Delete `interactive-registry.ts`.

### Step 3: Remove expand + stub reflow

Gut `useReflowEngine` to return null. Remove `handleExpand` from DiagramContentArea. Delete `reflow/registry.ts`. Remove `isExpandable`, `ReflowScript`, expand-related attributes from role helpers and types.

### Step 4: Add mutation API

Add `addElement`, `removeElement`, `addSubtree` to SvgScene.

### Step 5: Navigation

Add `DiagramModal` and `DiagramLink` to `InteractiveData`. Add click resolution in `handleNavigate` (alt+click → code-jump, modal → popup, link → jump, fallthrough → code-jump). Add `PopupDiagramOverlay`. Add `ViewportHandle.centerOn`.
