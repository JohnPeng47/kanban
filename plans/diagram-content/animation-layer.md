# Animation Layer: Insertion Animation Primitive

## Context

When a user clicks an expandable section (e.g. `07-continuation-pattern` in `base.html`), the current code:
1. Fetches sub-diagram HTML (e.g. `continuation.html`)
2. Parses the SVG, creates a nested `<svg>` element
3. Instantly swaps collapsed/expanded content via CSS class toggles
4. Runs a pre-computed reflow script to displace siblings

This works, but the transition is abrupt — content pops into existence. We want the sub-diagram to **draw itself progressively**: outer box first, inner boxes next, text fills in, arrows connect. The same progressive reveal that would look natural if you watched someone draw the diagram on a whiteboard.

---

## Core Idea: SVG ↔ Draw Sequence Equivalence

An SVG element tree and a draw sequence are **equivalent representations**. Given any SVG subtree, we can derive a draw sequence from it; given a draw sequence, we can produce SVG elements. Neither is primary — they're two views of the same content.

```
SVG Element Tree ──── deriveDrawSequence() ────► DrawSequence
                 ◄─── executeDrawSequence() ────
```

The draw sequence encodes **order and timing** — which elements appear first, which appear in parallel, and the delays between groups. The SVG tree encodes **structure and appearance**. The animation layer converts between them.

### Draw Order Rules

A draw sequence follows a deterministic ordering derived from the SVG structure:

```
1. Outer container rect (the border/background of the group)
2. Heading text (first text child, usually the section title)
3. For each child group, recursively:
   a. Child container rect
   b. Child text content (can draw in parallel with sibling text)
4. Arrows and connectors (after the groups they connect)
```

Concrete example — expanding `07-continuation-pattern` (collapsed at y=1122, 520x170 → expanded 520x440):

```
Phase 1: Container                    [0ms]
  draw outer rect (520x440, stroke:#D29922)

Phase 2: Title + code block           [~50ms]
  draw "CONTINUATION PATTERN" heading
  draw subtitle text
  parallel:
    draw code block rect (492x72)
    draw code text lines

Phase 3: Cycle steps                  [~150ms]
  sequential (top to bottom):
    draw step-1 rect + text
    draw arrow (step-1 → step-2)
    draw step-2 rect + text
    draw arrow (step-2 → step-3)
    draw step-3 rect + text
    draw arrow (step-3 → step-4)
    draw step-4 rect + text (green, final)

Phase 4: Loop-back arrow              [~350ms]
  draw polyline loop-back
```

### Encoding Draw Order

Draw order is **derived from the SVG element tree at runtime**, not stored as a separate data structure. The derivation algorithm walks the SVG children in document order and applies the rules above. No `data-*` attributes needed for draw order — the SVG structure IS the specification.

If we later need to override the default draw order for a specific element (e.g. "draw this arrow early"), we can add an optional `data-draw-phase` attribute. But the default derivation should handle ~95% of cases without annotation.

---

## The Insertion Animation Primitive

**Insertion** is the base animation primitive. All visual mutations to the diagram (except reflow displacement, which is CSS `transform` transitions) go through it.

### What It Does

Given an origin point `(x, y)` and SVG content to insert:

1. **Fade out** any existing content at that location (the collapsed view)
2. **Create** the new SVG elements in the DOM (initially invisible)
3. **Reveal progressively** following the draw sequence — elements fade/scale in according to their draw phase
4. **Signal completion** so reflow and registries can update

### API: Scene Interface

```typescript
interface Scene {
  // ... existing methods ...

  // ─── Animation ──────────────────────────────────────────────

  /**
   * Animate insertion of SVG content into a scene element's region.
   *
   * @param targetId - The SceneElement to insert content into
   *                   (e.g. the expanded-content <g> inside an expandable group)
   * @param content  - SVG elements to insert
   * @param options  - Animation configuration
   * @returns A handle to observe/cancel the animation
   */
  animateInsertion(
    targetId: string,
    content: SVGElement,
    options?: InsertionAnimationOptions,
  ): AnimationHandle;

  /**
   * Animate removal (fade out) of content within a scene element.
   *
   * @param targetId - The SceneElement whose children should fade out
   * @param options  - Animation configuration
   * @returns A handle that resolves when fade-out completes
   */
  animateRemoval(
    targetId: string,
    options?: RemovalAnimationOptions,
  ): AnimationHandle;
}
```

### Types

```typescript
interface InsertionAnimationOptions {
  /** Total duration budget for the progressive reveal. Default: 400ms. */
  duration?: number;

  /** Easing function name. Default: "ease-out". */
  easing?: string;

  /** Delay before starting the reveal (e.g. wait for fade-out). Default: 0. */
  delay?: number;

  /**
   * Override the default draw sequence derivation.
   * If provided, elements are revealed in this order instead.
   */
  drawSequence?: DrawSequence;
}

interface RemovalAnimationOptions {
  /** Fade-out duration. Default: 200ms. */
  duration?: number;
  easing?: string;
}

interface AnimationHandle {
  /** Resolves when the animation completes. */
  finished: Promise<void>;

  /** Cancel the animation — all elements jump to their final state. */
  finish(): void;

  /** Cancel the animation — all elements revert (for abort scenarios). */
  cancel(): void;
}
```

### DrawSequence

The intermediate representation between SVG structure and timed animation.

```typescript
/**
 * A draw sequence is a tree of phases. Each phase contains elements
 * to reveal, with timing relative to the phase start.
 */
interface DrawSequence {
  phases: DrawPhase[];
}

interface DrawPhase {
  /** Elements to reveal in this phase. */
  elements: DrawStep[];

  /** Delay before this phase starts (relative to previous phase completing).
   *  Default: 0 (starts immediately after previous phase). */
  delay?: number;

  /** Whether elements within this phase reveal in parallel or sequentially.
   *  Default: "sequential". */
  mode?: "parallel" | "sequential";
}

interface DrawStep {
  /** The DOM element to reveal. */
  element: SVGElement;

  /** How this element enters. Default: "fade". */
  enter?: "fade" | "scale-y" | "draw-stroke";

  /** Per-element duration override. */
  duration?: number;
}
```

### The Outer Rect Is Privileged

Phase 0 of every draw sequence is the **bounds commit**. Before any visual reveal starts, we need to know the final size of the inserted content so the reflow engine can displace siblings into the right place. If we waited for the draw sequence to finish before notifying reflow, siblings would sit in their old positions while the new content tried to draw into space that isn't there yet — or worse, overlap with neighbors.

This is why `DrawSequence` carries an explicit bounds rect separate from the phase list:

```typescript
interface DrawSequence {
  /**
   * The final bounds of the inserted content, in local coordinates of the
   * target SceneElement. Known BEFORE any phase runs — derived from the
   * outer rect of the source SVG (or the viewBox if no outer rect exists).
   *
   * This is the single value handed off to ReflowEngine so sibling
   * displacement can start in parallel with the reveal.
   */
  committedBounds: Rect;

  phases: DrawPhase[];
}
```

### Handoff to Reflow

`animateInsertion` is responsible for committing bounds to reflow before any phase runs. The handoff point is a single call, synchronous with insertion setup:

```
animateInsertion(targetId, content, options)
  │
  ├─ 1. Derive draw sequence from content
  │     → extract committedBounds from outer rect
  │
  ├─ 2. scene.growVisualBounds(targetId, deltaW, deltaH)
  │     → reflow engine sees the size change immediately
  │     → CSS transitions on [data-reflow-group] start sliding siblings
  │
  ├─ 3. Append content to target DOM (opacity: 0)
  │
  ├─ 4. Schedule progressive reveal phases
  │     → these run IN PARALLEL with reflow displacement
  │
  └─ 5. Return AnimationHandle
```

Reflow runs on a completely separate timeline from the reveal. By the time the outer container fades in at Phase 1, siblings are already mid-slide toward their new positions. This is the critical piece: **reflow sees the final geometry at t=0, not at t=end-of-animation**.

For the expand case specifically: `scene.growVisualBounds()` is the existing API the reflow engine already uses for parent growth during constraint solving. Reusing it for animation-driven growth keeps one authoritative path for "the size of this element changed."

---

---

## SvgScene Implementation

The Scene interface defines animation abstractly. `SvgScene` implements it using CSS animations and the Web Animations API.

### SVG Shape Decomposition for Stroke Drawing

Yes — `stroke-dashoffset` is how we draw lines progressively. The trick is that it works on any strokable SVG element, not just `<line>` and `<path>`. The standard technique:

1. Measure the total stroke length (`getTotalLength()` for paths, or computed analytically for primitives)
2. Set `stroke-dasharray: <length>` and `stroke-dashoffset: <length>` — this hides the stroke
3. Animate `stroke-dashoffset: <length> → 0` — the stroke reveals itself from start to end

How each primitive decomposes:

| Element | Decomposition |
|---|---|
| `<line>` | `getTotalLength()` returns the line length. Direct animation. |
| `<polyline>` / `<polygon>` | `getTotalLength()` returns cumulative segment length. Draws segment-by-segment naturally. |
| `<path>` | `getTotalLength()` works directly. Any arc/curve draws along its parameterization. |
| `<rect>` | `getTotalLength()` returns the perimeter. Draws clockwise starting from top-left. This is how the outer container rect gets its "drawing itself" effect. |
| `<circle>` / `<ellipse>` | `getTotalLength()` returns circumference. Draws from the rightmost point (angle 0). |
| `<text>` | Cannot be stroke-drawn. Falls back to `fade` enter style. |

Every strokable primitive in the existing diagrams (see `base.html` and `continuation.html`) can use stroke-dashoffset without conversion to paths. `<rect>` with `rx` (rounded corners) works — `getTotalLength()` accounts for the rounded arc lengths.

The fill of a rect is separate from its stroke. When we stroke-draw a rect, we either:
- **Option A:** Start with `fill-opacity: 0`, animate stroke draw, then fade fill in. This looks like pen-drawing on paper.
- **Option B:** Start with full fill, animate stroke draw. Faster, looks like "the border completes."

The default is **Option A for outer container rects** (the Phase 1 primary draw) and **Option B for inner rects** (keeps Phase 3 fast and readable).

### `animateInsertion` Implementation

```typescript
// SvgScene.animateInsertion(targetId, content, options)

// 1. Find the target <g> in the DOM
const targetG = this.domElements.get(targetId);

// 2. Derive draw sequence — this gives us committedBounds BEFORE any DOM mutation
const sequence = options?.drawSequence ?? deriveDrawSequence(content);

// 3. Hand off bounds to reflow immediately (phase 0)
//    This triggers sibling displacement via CSS transitions, runs in parallel
//    with the reveal phases that follow.
const currentBounds = this.getLocalBounds(targetId);
const deltaW = sequence.committedBounds.width - currentBounds.width;
const deltaH = sequence.committedBounds.height - currentBounds.height;
if (deltaW !== 0 || deltaH !== 0) {
  this.growVisualBounds(targetId, deltaW, deltaH);
  // ReflowEngine observer (or direct call from DiagramContentArea) picks this up
  // and applies displacement scripts to siblings.
}

// 4. Append content to target (elements start invisible — opacity or dashoffset)
prepareContentForReveal(content);  // sets opacity:0 / stroke-dashoffset on each element
targetG.appendChild(content);

// 5. Schedule reveals using Web Animations API
let timeOffset = options?.delay ?? 0;
for (const phase of sequence.phases) {
  timeOffset += phase.delay ?? 0;
  const phaseElements = phase.elements;

  if (phase.mode === "parallel") {
    // All elements in this phase start at the same timeOffset
    for (const step of phaseElements) {
      scheduleReveal(step, timeOffset);
    }
    // Next phase starts after the longest element in this phase
    timeOffset += Math.max(...phaseElements.map(s => s.duration ?? PER_ELEMENT_MS));
  } else {
    // Sequential: each element starts after the previous
    for (const step of phaseElements) {
      scheduleReveal(step, timeOffset);
      timeOffset += step.duration ?? PER_ELEMENT_MS;
    }
  }
}

// 6. Return handle wrapping Promise.all of all scheduled animations
```

### `deriveDrawSequence`: SVG → Draw Phases

This is the core algorithm that makes SVG ↔ draw sequence equivalence work.

**Phase execution semantics:** Phases run **sequentially** — phase N+1 does not start until phase N has fully completed (the longest element in phase N has finished its reveal). Within a phase, `mode` controls whether the elements run in parallel (all start at the phase's start time) or sequentially (each starts when the previous finishes). An optional `delay` on a phase adds time between the previous phase ending and the current phase starting — useful for pacing (e.g. "pause 30ms after the container draws before the title appears").

```
phase 0 (bounds commit, instantaneous, hands off to reflow)
│
▼
phase 1: container ────────►│ [elements in parallel]
                            │
                            ├─ phase delay (optional)
                            ▼
phase 2: title ────────►│ [elements in parallel]
                        │
                        ├─ phase delay
                        ▼
phase 3: groups ──────────────────────────►│ [elements in sequence]
                                            │
                                            ▼
phase 4: arrows ────►│ [elements in parallel]
                     │
                     ▼
                   done
```

```typescript
function deriveDrawSequence(svgContent: SVGElement): DrawSequence {
  const phases: DrawPhase[] = [];
  const children = Array.from(svgContent.children) as SVGElement[];

  // Phase 1: Background/container rects (elements at the start before any <g>)
  const leadingRects: DrawStep[] = [];
  const leadingText: DrawStep[] = [];
  const groups: SVGElement[] = [];
  const trailingElements: SVGElement[] = [];

  let seenGroup = false;
  for (const child of children) {
    if (child.tagName === "rect" && !seenGroup) {
      leadingRects.push({ element: child, enter: "fade" });
    } else if (child.tagName === "text" && !seenGroup) {
      leadingText.push({ element: child, enter: "fade" });
    } else if (child.tagName === "g") {
      seenGroup = true;
      groups.push(child);
    } else if (child.tagName === "polyline" || child.tagName === "line") {
      trailingElements.push(child);
    } else {
      // Other elements: include in appropriate phase
      if (seenGroup) trailingElements.push(child);
      else leadingRects.push({ element: child, enter: "fade" });
    }
  }

  // Phase 1: Container
  if (leadingRects.length > 0) {
    phases.push({ elements: leadingRects, mode: "parallel" });
  }

  // Phase 2: Title text
  if (leadingText.length > 0) {
    phases.push({ elements: leadingText, mode: "parallel", delay: 30 });
  }

  // Phase 3+: Groups (sequential, each with its own sub-derivation)
  for (const group of groups) {
    const groupSteps = deriveGroupSteps(group);
    phases.push({ elements: groupSteps, mode: "sequential", delay: 20 });
  }

  // Final phase: Arrows and connectors
  if (trailingElements.length > 0) {
    phases.push({
      elements: trailingElements.map(el => ({
        element: el,
        enter: el.tagName === "polyline" || el.tagName === "line"
          ? "draw-stroke" as const
          : "fade" as const,
      })),
      mode: "parallel",
      delay: 30,
    });
  }

  return { phases };
}
```

### Element Reveal Styles

Each `enter` type maps to a CSS/WAAPI animation:

| Enter type | Animation |
|---|---|
| `fade` | `opacity: 0 → 1` over duration |
| `scale-y` | `opacity: 0 → 1` + `scaleY: 0 → 1` (grows downward from top edge) |
| `draw-stroke` | `stroke-dashoffset: length → 0` (line draws itself) |

All animations use the Web Animations API (`element.animate()`) for precise timing control and easy cancellation via `AnimationHandle`.

---

## Expand/Collapse Flow With Animation

### Current Flow (diagram-content-area.tsx)

```
click expandable → fetch HTML → parse SVG → create nested <svg>
  → collapsedG.classList.add("hidden")
  → expandedG.appendChild(nested) + classList.add("visible")
  → reflow.toggleExpand(elementId)
```

### New Flow

```
click expandable → fetch HTML → parse SVG → create nested <svg>
  │
  ├─ in parallel:
  │   ├─ scene.animateRemoval(collapsedContentId, { duration: 200 })
  │   └─ scene.animateInsertion(expandedContentId, nested, { delay: 200 })
  │       │
  │       ├─ phase 0: growVisualBounds() — reflow sees new size immediately
  │       │          → sibling displacement starts (CSS transitions)
  │       │
  │       └─ phases 1..N: progressive reveal (starts after fade-out at t=200)
```

Note: `reflow.toggleExpand()` is no longer called explicitly. The bounds commit inside `animateInsertion` IS the reflow trigger — `growVisualBounds` → reflow engine observes → displacement runs. This consolidates two separate code paths (manual class toggle + manual toggleExpand) into a single API call.

The key change: `animateInsertion` replaces the instant class toggle AND the manual reflow trigger. Reflow displacement (sibling groups sliding down) still happens via CSS `transform` transitions on `[data-reflow-group]` — that's orthogonal to the content reveal animation, but the handoff point is now inside `animateInsertion` rather than in `DiagramContentArea`.

### Concrete Example: Expanding `07-continuation-pattern`

Starting state:
- Collapsed content visible at (20, 1122), size 520x170
- Expanded content `<g class="expanded-content">` is empty

Animation sequence:
1. **t=0ms**: `animateRemoval` starts on collapsed content — fades out over 200ms
2. **t=0ms**: `deriveDrawSequence` walks continuation.html SVG → `committedBounds = { w: 520, h: 440 }`
3. **t=0ms**: `scene.growVisualBounds("continuation-pattern", 0, 270)` — siblings begin sliding down via CSS transitions (continuation-pattern height: 170 → 440, deltaH: +270)
4. **t=200ms**: Collapsed fade-out complete. Nested `<svg>` appended to expanded `<g>`. Reveal phases begin:
   - Phase 1 (t=200): Outer rect (520x440, #D29922 border) stroke-draws around the perimeter, then fill fades in
   - Phase 2 (t=280): "CONTINUATION PATTERN" heading + subtitle fade in
   - Phase 3 (t=340): Code block rect + code text lines (parallel)
   - Phase 4 (t=420): Step 1 rect+text → arrow → step 2 → arrow → step 3 → arrow → step 4
   - Phase 5 (t=620): Loop-back polyline draws itself via stroke-dashoffset
5. **t=~450ms**: Sibling displacement complete (reflow CSS transition duration: 450ms from t=0)
6. **t=~700ms**: Reveal animation complete

Note that steps 3, 4, 5 all run on overlapping timelines. By the time the title appears at t=280, siblings are already more than halfway to their final positions. The user perceives a single coherent animation: content draws itself while the page makes room for it.

---

## Integration With Existing Code

### What Changes

| Component | Change |
|---|---|
| `Scene` interface (`scene.ts`) | Add `animateInsertion()`, `animateRemoval()` |
| `SvgScene` (`svg-scene.ts`) | Implement both methods using Web Animations API |
| `DiagramContentArea` (`diagram-content-area.tsx`) | Replace instant swap with `animateRemoval` → `animateInsertion` |

### What Doesn't Change

| Component | Why |
|---|---|
| `useReflowEngine` | Still applies displacement scripts identically — reflow is orthogonal |
| `InteractionLayer` | Hit testing, selection, tooltips unchanged |
| `Viewport` | Pan/zoom unchanged |
| `InteractiveElementRegistry` | Builds from Scene after insertion completes |
| Reflow scripts in HTML | Same `<script type="application/reflow+json">` format |

### The Rule

**All code that modifies diagram visual content (other than reflow displacement) must go through the animation API.** Today the only such code path is expand/collapse in `DiagramContentArea`. Future paths (inline editing, sub-diagram replacement, content refresh) will use the same `animateInsertion`/`animateRemoval` primitives.

Reflow displacement is NOT content mutation — it's spatial adjustment. It stays as `scene.setTransform()` + CSS transitions on `[data-reflow-group]`.

---

## New Files

```
web-ui/src/diagram/animation/
  types.ts              — DrawSequence, DrawPhase, DrawStep, AnimationHandle,
                          InsertionAnimationOptions, RemovalAnimationOptions
  derive-draw-sequence.ts — deriveDrawSequence(): SVG element → DrawSequence
  reveal.ts             — scheduleReveal(): DrawStep + timing → Web Animation
```

## Modified Files

- `web-ui/src/diagram/rendering/scene.ts` — add `animateInsertion()`, `animateRemoval()` to interface
- `web-ui/src/diagram/rendering/svg-scene.ts` — implement both methods
- `web-ui/src/components/diagram-panels/diagram-content-area.tsx` — use animation API instead of class toggles

---

## Verification

1. **Unit test `derive-draw-sequence.ts`** — feed continuation.html's SVG, assert correct phase structure (5 phases, correct element counts per phase, correct enter types for rects vs lines)
2. **Unit test reveal scheduling** — mock `element.animate()`, verify timing offsets match expected sequence
3. **Integration test** — expand `07-continuation-pattern`, verify:
   - Collapsed content fades out
   - Expanded content appears progressively (not all at once)
   - Reflow displacement of siblings happens concurrently
   - Final state matches current instant-swap result
4. **AnimationHandle** — verify `finish()` jumps to end state, `cancel()` reverts
