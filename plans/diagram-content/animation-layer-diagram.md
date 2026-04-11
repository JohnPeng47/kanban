# Animation Layer — End-to-End Flow

```
                                    USER CLICKS "07-continuation-pattern"
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  DiagramContentArea (diagram-content-area.tsx)                                              │
│                                                                                             │
│    handleExpand(elementId)                                                                  │
│      ├─ read data-expand-src, data-expand-w, data-expand-h                                  │
│      ├─ fetch sub-diagram HTML  ────►  trpc.diagrams.getContent(continuation.html)          │
│      ├─ parse SVG                                                                           │
│      └─ scene.animateInsertion("continuation-pattern-expanded", nestedSvg, { delay: 200 })  │
│           ║                                                                                 │
│           ║         scene.animateRemoval("continuation-pattern-collapsed", { ms: 200 })     │
│           ║                                                (runs in parallel)               │
└───────────╫─────────────────────────────────────────────────────────────────────────────────┘
            ║
            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  Scene Interface (scene.ts)                                                                 │
│                                                                                             │
│    animateInsertion(targetId, content, options): AnimationHandle                            │
│    animateRemoval  (targetId,          options): AnimationHandle                            │
│    growVisualBounds(targetId, deltaW, deltaH)    ◄──── reused for reflow handoff            │
│    getLocalBounds  (targetId): Rect                                                         │
└───────────║─────────────────────────────────────────────────────────────────────────────────┘
            ║
            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  SvgScene.animateInsertion  (svg-scene.ts)                                                  │
│                                                                                             │
│    STEP 1: DERIVE                                                                           │
│    ┌────────────────────────────────────────────────────────────────────────────────┐       │
│    │ sequence = deriveDrawSequence(content)                                         │       │
│    │                                                                                │       │
│    │    SVG element tree                      DrawSequence                          │       │
│    │    ─────────────────────                 ───────────────                       │       │
│    │    <svg>                                 {                                    │       │
│    │      <rect outer 520x440 />   ───►         committedBounds: {w:520,h:440},    │       │
│    │      <text heading />                      phases: [                          │       │
│    │      <text subtitle />                       { elements:[outer_rect],         │       │
│    │      <rect code-block />                      mode:"parallel" },              │       │
│    │      <text code lines />                    { elements:[heading,subtitle],    │       │
│    │      <rect step-1 />                          mode:"parallel", delay:30 },    │       │
│    │      <line arr-1 />                         { elements:[code-block, code],    │       │
│    │      <rect step-2 />                          mode:"parallel", delay:30 },    │       │
│    │      <line arr-2 />                         { elements:[s1, a1, s2, a2, ...], │       │
│    │      ...                                      mode:"sequential", delay:30 }, │       │
│    │      <polyline loopback />                  { elements:[loopback],            │       │
│    │    </svg>                                     mode:"parallel", delay:30 },    │       │
│    │                                            ]                                  │       │
│    │                                          }                                    │       │
│    └────────────────────────────────────────────────────────────────────────────────┘       │
│                                                                                             │
│    STEP 2: COMMIT BOUNDS  (phase 0 — instantaneous, hands off to reflow)                    │
│    ┌────────────────────────────────────────────────────────────────────────────────┐       │
│    │ deltaH = 440 - 170 = 270                                                       │       │
│    │ this.growVisualBounds("continuation-pattern", 0, 270)  ──────┐                 │       │
│    │                                                              │                 │       │
│    │    ▼ mutates <rect> width/height attrs                       │                 │       │
│    │    ▼ updates SceneElement.localBounds                        │                 │       │
│    │    ▼ invalidates worldBoundsCache                            │                 │       │
│    │                                                              │ REFLOW          │       │
│    └──────────────────────────────────────────────────────────────┼──────────────── │       │
│                                                                   │ HANDOFF         │       │
│    STEP 3: PREPARE                                                │                 │       │
│    ┌──────────────────────────────────────────────────────────┐   │                 │       │
│    │ prepareContentForReveal(content)                         │   │                 │       │
│    │   for each strokable el: set stroke-dasharray/offset     │   │                 │       │
│    │   for each text/fill: set opacity: 0                     │   │                 │       │
│    │ targetG.appendChild(content)                             │   │                 │       │
│    └──────────────────────────────────────────────────────────┘   │                 │       │
│                                                                   │                 │       │
│    STEP 4: SCHEDULE REVEAL PHASES                                 │                 │       │
│    ┌──────────────────────────────────────────────────────────┐   │                 │       │
│    │ timeOffset = options.delay (200ms, wait for fade-out)    │   │                 │       │
│    │ for each phase:                                          │   │                 │       │
│    │   timeOffset += phase.delay                              │   │                 │       │
│    │   if parallel: all elements.animate() at timeOffset      │   │                 │       │
│    │   if sequential: cascade each element.animate()          │   │                 │       │
│    │   timeOffset += max(phase durations)                     │   │                 │       │
│    └──────────────────────────────────────────────────────────┘   │                 │       │
│                                                                   │                 │       │
│    STEP 5: Return AnimationHandle { finished, finish, cancel }    │                 │       │
└───────────────────────────────────────────────────────────────────┼─────────────────┘       │
                                                                    │                         │
                                                                    ▼                         │
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  ReflowEngine  (use-reflow-engine.ts)                                                       │
│                                                                                             │
│    observes growVisualBounds → looks up pre-computed script for "continuation-pattern"      │
│    script: { translations: [...], growths: [...] }                                          │
│                                                                                             │
│    for each translation (id, dy):                                                           │
│      scene.setTransform(id, { tx:0, ty:dy, scale:1 })                                       │
│                                                                                             │
│    ▼ sets CSS transform on <g data-reflow-group>                                            │
│    ▼ CSS transition: transform 0.45s cubic-bezier(...) handles the animation                │
└─────────────────────────────────────────────────────────────────────────────────────────────┘


═════════════════════════════════════════════════════════════════════════════════════════════
  TIMELINE  (milliseconds)
═════════════════════════════════════════════════════════════════════════════════════════════

   0        100       200       300       400       500       600       700
   │         │         │         │         │         │         │         │
───┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼──────►
   │                   │
   │◄── fade out ─────►│   collapsed-content opacity 1 → 0
   │                   │
   │                                       growVisualBounds committed at t=0
   │◄─────────── sibling displacement (CSS transition, 450ms) ────────►│
   │                                       work-loop, browser-time, etc. slide by +270px
   │
   │                   │◄ phase 1: outer rect stroke-draw  (#D29922)
   │                   │     ▼
   │                   │     └ fill fade-in
   │                             │
   │                             │◄ phase 2: heading + subtitle fade
   │                                 │
   │                                 │◄ phase 3: code block + code text
   │                                     │
   │                                     │◄── phase 4: steps+arrows (sequential) ──►│
   │                                                                                 │
   │                                                                                 │◄ phase 5: loopback
   │                                                                                     stroke-draw


═════════════════════════════════════════════════════════════════════════════════════════════
  LAYER RESPONSIBILITIES
═════════════════════════════════════════════════════════════════════════════════════════════

  ┌──────────────────────────────────────────────────────────────────────┐
  │  DiagramContentArea      "what content, where to fetch it"           │
  │  ────────────────        fetches HTML, calls animateInsertion        │
  └──────────────────────────────────────────────────────────────────────┘
                              │ animateInsertion(targetId, content)
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Scene interface         "animate insertion / removal / bounds"      │
  │  ───────────────         abstract API, backend-agnostic              │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  SvgScene                "SVG-specific impl of the animation API"    │
  │  ────────                derive sequence, commit bounds, WAAPI       │
  └──────────────────────────────────────────────────────────────────────┘
                              │         │
           derive-draw-seq ───┘         └─── growVisualBounds (reflow handoff)
                              │                      │
                              ▼                      ▼
  ┌─────────────────────────────────┐  ┌────────────────────────────────┐
  │  deriveDrawSequence             │  │  ReflowEngine                  │
  │  ───────────────────            │  │  ────────────                  │
  │  walks SVG tree, produces       │  │  applies pre-computed scripts  │
  │  committedBounds + phases       │  │  sibling displacement via CSS  │
  └─────────────────────────────────┘  └────────────────────────────────┘
                              │                      │
                              ▼                      ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Web Animations API + CSS transitions                                │
  │  ─────────────────────────────────────                               │
  │  element.animate({ opacity/stroke-dashoffset/transform })            │
  └──────────────────────────────────────────────────────────────────────┘


═════════════════════════════════════════════════════════════════════════════════════════════
  KEY INVARIANTS
═════════════════════════════════════════════════════════════════════════════════════════════

  (1) Bounds are committed BEFORE any reveal runs.
      → reflow displacement and reveal animation run on overlapping timelines.

  (2) DrawSequence is derivable from SVG structure.
      → no separate data-* annotations needed for draw order.

  (3) All content mutation goes through animateInsertion / animateRemoval.
      → reflow displacement (setTransform) is NOT content mutation — stays on its own path.

  (4) AnimationHandle lets callers wait, finish early, or cancel.
      → enables interruption when user clicks a second expand before the first completes.
```
