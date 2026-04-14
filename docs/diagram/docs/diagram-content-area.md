# DiagramContentArea & Popup Overlays

## Overview

`DiagramContentArea` is the application layer above the rendering core. It bridges `useDiagram` (scene construction) with `SceneInput` (interaction), adding business logic: navigation dispatch (code jumps, modals, links), popup diagram overlays, badge creation, context menus, and cross-diagram jump consumption.

## Architecture

```
DiagramContentArea
│  owns: useDiagram(content) → Scene
│  handles: loading/error/empty states
│  handles: pending jump consumption
│
└── DiagramScene
      │  owns: popup stack, user badges, context menu
      │  owns: navigation dispatch logic
      │
      ├── SceneInput ← scene, handleNavigate, badges, onContextMenu
      │     └── Viewport ← scene, event handlers
      │           ├── Transform div + SVG
      │           ├── OverLayer (modal/link/user badges)
      │           └── Selection overlay
      │
      ├── PopupDiagramOverlay[] (one per popup in stack)
      │     └── SceneInput ← popup scene, onNavigate relay
      │
      └── Context menu (fixed position div)
```

## DiagramContentArea

Outer wrapper that manages the Scene lifecycle and loading states.

**Scene construction**: Calls `useDiagram(content)` which parses the HTML string, extracts the `<svg>`, temporarily appends it to `document.body` for `getBBox()` to work, constructs an `SvgScene`, then removes the SVG (Viewport will remount it).

**Loading states**: Renders different UIs for:
- No diagram selected → "Select a diagram" placeholder
- Loading → spinner
- Error → red error message
- No scene (parse failed) → empty surface
- Scene ready → `DiagramScene`

**Jump consumption**: When `pendingJumpElementId` is set and the scene loads, waits 50ms for Viewport to mount, then calls `onJumpConsumed()`.

## DiagramScene

Inner component with all interaction logic. Receives a constructed `Scene` and renders `SceneInput` with business-logic callbacks.

### Navigation Dispatch

When an interactive element is clicked, `handleNavigate` decides the action:

```
handleNavigate(interactive, domEvent)
  ├── Alt+click → fireCodeJump (always, regardless of element type)
  ├── Has modal → openPopup
  ├── Has link → executeJump
  └── Default → fireCodeJump
```

### Code Jump (`fireCodeJump`)

Calls `diagrams.navigate` TRPC mutation to open the file in the Code Viz VSCode extension:

```
trpc.diagrams.navigate.mutate({
  root: workspacePath,
  filePath: interactive.navTarget.filePath,
  line: interactive.navTarget.startLine,
  newTab: ctrlKey || metaKey
})
```

Shows error toast if the extension reports a problem.

### Popup Stack

Modal elements open overlay diagrams in a stack:

1. `openPopup(interactive)` resolves the modal path relative to the current diagram
2. Fetches content via `diagrams.getContent`
3. Pushes a `PopupEntry` onto the stack: `{ path, content, position, anchorBounds }`
4. Each popup renders as a `PopupDiagramOverlay` with increasing z-index (`50 + i * 2`)
5. Closing a popup slices the stack at that index (closes it and all popups above it)
6. Popup stack clears when the base diagram changes

### Link Jumps (`executeJump`)

- **Same-diagram**: Finds target element, computes center of its world bounds, calls `viewportRef.centerOn()` with `animate: true`
- **Cross-diagram**: Calls `onRequestJump(resolvedPath, targetElementId)` which flows up to `useDiagramViewer.requestJump`

### Badges

Built from scene elements in a `useMemo`:

| Condition | Badge |
|-----------|-------|
| `el.interactive.modal` exists | `⬡` purple badge at element top-right → opens popup |
| `el.interactive.link` exists | `→` gold badge at element top-right → executes jump |

User badges are added via right-click context menu (`📌` green, scene-anchored, click to remove).

### Context Menu

Right-click opens a fixed-position menu with "Add Badge". Dismissed by clicking anywhere else (global `pointerdown` listener).

## PopupDiagramOverlay

A floating overlay that renders a nested, fully interactive diagram.

**Layout**: Positioned at fixed offset (24px from top-left). Sized to fit the diagram's natural dimensions, clamped to 85% of container in either axis, with a minimum of 200x150px.

**Interaction**:
- ESC or click backdrop → close
- Close button (X) in top-right corner
- Contains its own `SceneInput` with `onNavigate` relayed to the parent
- Entry animation: 150ms ease

**Stacking**: Z-index starts at 50, increments by 2 per nested popup.

---

## Source References

```
web-ui/src/components/diagram-panels/diagram-content-area.tsx
  L14-19    resolveDiagramPath helper
  L21-26    PopupEntry interface
  L28-269   DiagramScene component
  L41-45      State: viewportRef, popupStack, userBadges, contextMenu
  L48-52      Clear state on diagram change
  L54-73      fireCodeJump: TRPC diagrams.navigate mutation
  L75-107     openPopup: resolve path, fetch content, push to stack
  L109-135    executeJump: same-diagram centerOn vs cross-diagram requestJump
  L137-161    handleNavigate: alt → code, modal → popup, link → jump, default → code
  L164-191    badges memo: build from interactive.modal and interactive.link
  L195-221    handleContextMenu + handleAddBadge: user badge creation
  L231-268    JSX: SceneInput + popupStack.map + context menu
  L271-284   DiagramContentAreaProps interface
  L286-354   DiagramContentArea component
  L297        useDiagram(content) → scene
  L300-312    Pending jump consumption effect
  L314-341    Loading/error/empty states
  L343-353    Render DiagramScene when scene ready

web-ui/src/components/diagram-panels/popup-diagram-overlay.tsx
  L9-16     Size constants: MIN_WIDTH, MIN_HEIGHT, MAX ratios, CONTENT_PADDING
  L17-30    PopupDiagramOverlayProps interface
  L36-60    computePopupLayout: size to fit diagram, clamp to container
  L63-145   PopupDiagramOverlay component
  L69         useDiagram(content) for popup scene
  L73-82      ESC key handler
  L84-91      Backdrop click handler
  L96-107     Layout memo from diagram bounds
  L109-144    JSX: backdrop + positioned popup + close button + PopupScene
  L147-155  PopupScene: thin wrapper around SceneInput

web-ui/src/diagram/use-diagram.ts
  L6-52     useDiagram hook
  L17-23      DOMParser → extract <svg>
  L26         Temporary document.body append for getBBox()
  L29         SvgScene construction
  L39-41      Cleanup: remove from body
  L46-48      Destroy on unmount
```
