# Overlay Elements Layer (OverLayer)

## Overview

The `OverLayer` renders interactive badges on top of the diagram SVG. Badges are positioned in screen space but anchored to scene coordinates, scene elements, or fixed screen positions. A `requestAnimationFrame` loop continuously syncs badge positions with the viewport transform, avoiding React re-renders during pan/zoom.

## Architecture

```
#comment: make this into diagram
Viewport container
├── Transform div (SVG lives here, pans/zooms)
├── OverLayer div (absolute, inset-0, z-index 10)
│   ├── Badge button (absolute, positioned by rAF)
│   ├── Badge button
│   └── ...
└── Selection overlay
```

The OverLayer sits as a sibling to the transform div inside the Viewport container. It covers the entire container area but only contains small, fixed-size badge buttons. Because badges must stay at constant pixel size regardless of zoom level, they cannot live inside the SVG — they're HTML elements positioned absolutely.

## Badge Anchoring

Each badge has an `anchor` that determines how its screen position is computed:

### `space: "screen"` — Fixed screen position
```
x, y used directly as pixel offsets within the container
```
The badge stays put regardless of pan/zoom. Useful for UI controls.

### `space: "scene"` — World coordinates
```
screenX = anchor.x * transform.scale + transform.tx
screenY = anchor.y * transform.scale + transform.ty
```
The badge tracks a point in the SVG coordinate system. Moves with pan/zoom.

### `space: "element"` — Element corner
```
1. Look up element world bounds via scene.getWorldBounds(elementId)
2. Pick corner point (top-left, top-right, bottom-left, bottom-right, center)
3. Convert to screen: cornerX * scale + tx, cornerY * scale + ty
```
The badge sticks to a specific corner of a scene element. Used for modal/link indicators that should float at the top-right of their source element.

## RAF Sync Loop

```
effect() {
  sync = () => {
    t = transformRef.current
    for each badge:
      pos = resolveAnchor(badge.anchor, t, scene)
      dom.style.left = pos.x + "px"
      dom.style.top = pos.y + "px"
    requestAnimationFrame(sync)
  }
  requestAnimationFrame(sync)
  return () => cancelAnimationFrame(rafId)
}
```

This loop reads the transform ref (a mutable ref, not React state) every frame and updates badge DOM positions directly. This is critical for smooth 60fps tracking during pan/zoom without triggering React reconciliation.

## Badge Rendering

Each badge is an 18x18px circular `<button>`:
- Centered on its anchor point via `-9px` margin offset
- Colored background with optional border
- Contains a single character or emoji (e.g. `⬡` for modals, `→` for links)
- Hover effect: `scale(1.25)` transition
- `onClick` stops propagation to prevent the click from reaching the Viewport's click handler

## Badge Sources

Badges are created by the `DiagramScene` component in `diagram-content-area.tsx`:

| Type | Text | Color | Trigger |
|------|------|-------|---------|
| Modal | `⬡` | Purple (`#A371F7`) | Element has `interactive.modal` |
| Link | `→` | Gold (`#D4A72C`) | Element has `interactive.link` |
| User | varies | Green (`#3FB950`) | Right-click "Add Badge" context menu |

All badges are anchored to `space: "element"` with `corner: "top-right"`.

---

## Source References

```
web-ui/src/diagram/rendering/over-layer.tsx
  L1-3      Imports
  L5-52     resolveAnchor — converts badge anchor to screen coordinates
  L7-15       "screen" and "scene" cases
  L17-51      "element" case: world bounds lookup + corner selection
  L54-59    OverLayerProps interface
  L61-63    Component doc comment
  L64-127   OverLayer component
  L65        badgeRefsMap ref (Map<string, HTMLButtonElement>)
  L68-89     rAF sync loop effect
  L93-126    JSX: container div + badge buttons

web-ui/src/diagram/types.ts
  L165-173  BadgeAnchor type (screen | scene | element)
  L175-186  OverlayBadge interface

web-ui/src/components/diagram-panels/diagram-content-area.tsx
  L163-191  Badge creation from interactive.modal and interactive.link
```
