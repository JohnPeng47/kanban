# React escape hatch for diagram framework internals

## Decision

SvgScene and ReflowEngine stay as plain classes with imperative DOM mutation. They are not React components. React manages their lifecycle at the boundary via hooks (`useDiagram`, `useReflowEngine`), but does not manage their internal DOM operations.

## What sits outside React

- **SvgScene** — creates container/transformDiv/SVG DOM structure, applies CSS transforms at 60fps (pan/zoom/reflow), mutates SVG rect attributes (growVisualBounds), does hit testing via `elementFromPoint`. The SVG content is an opaque LLM-generated blob that React can't diff or render declaratively.
- **ReflowEngine** — reads pre-computed scripts, calls `scene.setTransform()` and `scene.growVisualBounds()` to displace elements. CSS transitions animate the result. React has no awareness of these mutations.
- **ReflowGroupRegistry** — plain data structure built once from the Scene. Held in a ref.

## What sits inside React

- **`useDiagram(html)` hook** — creates/destroys SvgScene on content change. React owns the lifecycle.
- **`useReflowEngine(scene)` hook** — builds registry, parses scripts, exposes `toggleExpand`. Stable callback for InteractionLayer's `onExpand` prop. Optional `isExpanded` as useState if UI needs it.
- **`<InteractionLayer>` component** — attaches pointer/wheel events, manages selection as useState, dispatches callbacks as props (`onNavigate`, `onExpand`, `onSelectionChange`). High-frequency transform state (pan/zoom) lives in useRef, not useState.
- **`<Viewport>` component** — returned by InteractionLayer. Owns pan/zoom CSS transform, coordinate conversion (screen↔scene). Wraps children.
- **`<DiagramMount>` component** — thin ref-based mount that attaches `scene.getRenderElement()` to the DOM.

## Why this pattern

Same pattern as D3, Three.js, Monaco, xterm in React apps: imperative internals, React-managed lifecycle at the boundary. The alternative (making SvgScene a React component) would mean a component that renders nothing via JSX, does everything in useEffect/useRef, and exposes 15 methods via useImperativeHandle — a class with extra steps.

React owns *when* things are created and destroyed. The imperative code owns *how* DOM is mutated. Neither crosses the other's boundary.

## Data flow

```
React world                              Imperative world
───────────                              ─────────────────
useDiagram(html)
  useEffect → new SvgScene(svg)  ──────→ SvgScene owns SVG DOM
  cleanup   → scene.destroy()

useReflowEngine(scene)
  useMemo  → registry + scripts  ──────→ ReflowGroupRegistry (plain data)
  toggleExpand(id)               ──────→ engine reads script
                                         scene.setTransform(...)
                                         scene.growVisualBounds(...)
                                         CSS transitions animate

<InteractionLayer>
  useState  → selectedIds               (React state, triggers UI updates)
  useRef    → pan/zoom transform         (no re-renders)
  onExpand  → toggleExpand(id)   ──────→ reflow (imperative)
  onClick   → scene.hitTest(pt)  ──────→ SvgScene (imperative, returns ID)
            → update selection           (React state)

<Viewport>
  useRef    → { tx, ty, scale }          (no re-renders)
  wheel     → update transform   ──────→ CSS on transformDiv (imperative)
            → scene.setTransform("root") (keep Scene bounds in sync)
  drag      → same
  screenToScene / sceneToScreen          (reads ref + getBoundingClientRect)
```
