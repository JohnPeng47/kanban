# Pre-computed Reflow Scripts

## Concept

Instead of the reflow engine computing displacements at runtime via constraint solving, the LLM pre-computes them at diagram generation time and encodes them as deterministic animation scripts in the diagram file. When an expand/collapse triggers, the framework plays back the script instead of solving constraints.

The constraint solver remains as a fallback for cases where no script is provided (e.g., dynamically inserted content, application-triggered reflows). The script is a fast path, not a replacement.

## Why This Works

The LLM already knows the full layout when it generates the diagram. It placed every element, it knows every gap, it knows how tall the expanded content will be. The constraint solver we designed (bottom-up tree propagation, containment vs adjacency) is deterministic — given the same inputs, it produces the same outputs. The LLM can run that same logic at generation time and emit the result as a lookup table.

This trades runtime computation for a small amount of static data in the diagram file.

## Script Format

Scripts are encoded in the diagram file as `<script type="application/reflow+json">` blocks inside the expandable group's `<g>` element. Using a `<script>` tag with a custom type means the browser ignores it (no execution), but it's easy to parse.

```html
<g data-reflow-group="message-channel" data-expandable="true"
   data-expand-src="message-channel.html"
   data-expand-w="1060" data-expand-h="340">

  <script type="application/reflow+json">
  {
    "trigger": "message-channel",
    "deltaH": 290,
    "translations": [
      { "id": "work-loop", "dy": 290 },
      { "id": "arrow-3", "dy": 290 },
      { "id": "more-work", "dy": 290 },
      { "id": "no-more-work", "dy": 290 },
      { "id": "arrow-4", "dy": 290 },
      { "id": "browser-time", "dy": 290 }
    ],
    "growths": []
  }
  </script>

  <g class="collapsed-content">...</g>
  <g class="expanded-content"></g>
</g>
```

### Script Fields

```typescript
interface ReflowScript {
  /** The SceneElement ID of the group that triggers this script. */
  trigger: string;

  /** The height delta of the expansion (expandedH - collapsedH). */
  deltaH: number;

  /** Optional width delta (0 if expansion is purely vertical). */
  deltaW?: number;

  /** Elements to translate when this group expands. */
  translations: Array<{
    /** SceneElement ID to translate. */
    id: string;
    /** Horizontal displacement (usually 0). */
    dx?: number;
    /** Vertical displacement. */
    dy: number;
  }>;

  /** Parent groups whose visual bounds grow when this group expands. */
  growths: Array<{
    /** SceneElement ID of the parent to grow. */
    id: string;
    /** Width increase (usually 0). */
    dw?: number;
    /** Height increase. */
    dh: number;
  }>;
}
```

### Collapse Is the Inverse

No separate `onCollapse` script is needed. Collapsing negates all deltas: translations become `{ dy: -dy }`, growths become `{ dh: -dh }`. The engine handles this automatically.

### Compact Format Alternative

For simple diagrams where expansion only displaces elements vertically by the same amount, a compact `data-*` attribute can be used instead of a `<script>` block:

```html
<g data-reflow-group="message-channel" data-expandable="true"
   data-reflow-displace="work-loop,arrow-3,more-work,no-more-work,arrow-4,browser-time"
   data-reflow-dy="290">
```

The framework checks for the compact format first, falls back to the `<script>` block, then falls back to the constraint solver.

## Where the Short-Circuit Goes

Inside `ReflowEngine.groupResized()`. Before running the constraint solver, the engine checks if the SceneElement has a pre-computed script:

```
groupResized(groupId, newBounds):
  node = registry.groupsById.get(groupId)
  script = getReflowScript(groupId)

  if script exists:
    // Fast path: deterministic playback
    applyScript(script, expanding = newBounds > node.currentBounds)
    violations = verifyNoOverflow()
    if violations.length > 0:
      report violations (but still apply — visual is better than broken)
  else:
    // Slow path: computed reflow
    runConstraintSolver(node, newBounds)
```

The engine interface (`groupResized`, `batch`) does not change. Callers don't know or care whether the result was pre-computed or solved at runtime.

### Script Application

```typescript
function applyScript(script: ReflowScript, expanding: boolean): void {
  const sign = expanding ? 1 : -1;

  for (const t of script.translations) {
    const dx = (t.dx ?? 0) * sign;
    const dy = t.dy * sign;
    // Accumulate with any existing displacement
    const node = registry.groupsById.get(t.id) ?? registry.arrowsById.get(t.id);
    node.displacement.dx += dx;
    node.displacement.dy += dy;
    scene.setTransform(t.id, {
      tx: node.displacement.dx,
      ty: node.displacement.dy,
      scale: 1,
    });
  }

  for (const g of script.growths) {
    const dw = (g.dw ?? 0) * sign;
    const dh = g.dh * sign;
    scene.growVisualBounds(g.id, dw, dh);
  }
}
```

## Overflow Detection

Overflow detection is a verification pass that runs *after* displacements are applied, regardless of whether they came from a script or the constraint solver.

### What It Checks

1. **Containment overflow:** For each parent group, do all children fit within the parent's bounds after displacement?
   ```
   For each group G with children:
     parentBounds = scene.getWorldBounds(G.id)
     for each child C of G:
       childBounds = scene.getWorldBounds(C.id)
       if childBounds not fully inside parentBounds:
         violation: "child {C.id} overflows parent {G.id}"
   ```

2. **Sibling overlap:** For each pair of sibling groups, do their post-displacement bounds overlap?
   ```
   For each group G with children:
     for each pair (A, B) of G's children where A precedes B:
       aBounds = scene.getWorldBounds(A.id)
       bBounds = scene.getWorldBounds(B.id)
       if AABB_intersect(aBounds, bBounds):
         violation: "siblings {A.id} and {B.id} overlap after reflow"
   ```

3. **Arrow orphaning:** For each arrow, is it still positioned between the groups it connects? (Heuristic: arrow's y-center should be between the bottom of the group above and the top of the group below.)

### Violation Reporting

```typescript
interface ReflowViolation {
  type: 'containment-overflow' | 'sibling-overlap' | 'arrow-orphan';
  /** IDs of the elements involved. */
  elementIds: string[];
  /** Human-readable description. */
  message: string;
  /** The bounds that caused the violation. */
  bounds: { a: Rect; b: Rect };
}

function verifyNoOverflow(): ReflowViolation[] { ... }
```

Violations are reported but do not prevent the animation from playing. The visual result of the script is applied regardless — a slightly wrong animation is better than a frozen diagram. Violations surface as warnings in dev tools / test output.

## Composability: Nested Expansions

When multiple groups can expand independently, the naive approach requires `2^n` scripts. Instead, scripts are designed to be **composable**: each script assumes all other expandable groups are in their default (collapsed) state. When multiple groups are expanded simultaneously, their scripts stack.

### How Stacking Works

Each script's translations are applied cumulatively. If group A's script says "translate X down by 100" and group B's script (B is below A) says "translate X down by 50", then when both are expanded, X is displaced by 150.

This works because the constraint solver's displacement model is additive — displacements from independent sources accumulate linearly. The LLM generates each script in isolation, and the framework composes them.

### When Stacking Breaks

Stacking breaks when expansions are not independent — specifically, when expanding group A changes the layout context that group B's script was computed against. This happens when:

- A is a parent of B (containment): A's growth changes B's position before B's script runs
- A and B are siblings but A's expansion pushes B to a position where B's script displacements are wrong

For containment cases, the LLM should encode the parent growth in A's script, and B's script should only encode B's local effects (sibling displacements within B's parent). The framework applies scripts bottom-up (deepest first), matching the constraint solver's resolution order.

For pathological sibling cases, the framework falls back to the constraint solver.

## LLM Generation Instructions

When generating a diagram with expandable sections, the LLM should also generate reflow scripts:

1. **For each expandable group**, compute the height delta: `deltaH = data-expand-h - collapsedHeight`.

2. **Identify all elements below** the expandable group (at the same nesting level). These are the elements that need `dy: deltaH` translations.

3. **Identify parent groups** that contain the expandable group. These need `dh: deltaH` growths.

4. **Walk upward**: for each grown parent, identify elements below *that* parent and add `dy: deltaH` translations for them too. Repeat until reaching the root.

5. **Encode the result** as a `<script type="application/reflow+json">` block inside the expandable group's `<g>`.

6. **Verify mentally**: after applying all translations and growths, would any child overflow its parent? Would any siblings overlap? If so, adjust the script.

## Benchmarking and Testing

### Test 1: Script produces no overflow

```
Load diagram with scripts.
For each expandable group:
  Call engine.groupResized(groupId, expandedBounds)
  Assert: verifyNoOverflow() returns empty array
  Call engine.groupResized(groupId, collapsedBounds)  // collapse back
```

### Test 2: Script matches constraint solver

```
For each expandable group:
  // Run script path
  Load diagram with scripts
  Call engine.groupResized(groupId, expandedBounds)
  Record all transforms: scriptTransforms = snapshot()

  // Run solver path
  Load diagram with scripts stripped
  Call engine.groupResized(groupId, expandedBounds)
  Record all transforms: solverTransforms = snapshot()

  Assert: scriptTransforms === solverTransforms
```

This cross-check catches:
- LLM miscounting elements below the expansion
- LLM forgetting to grow a parent
- LLM computing the wrong deltaH
- Bugs in the constraint solver (if the solver is wrong, the script catches it; if the script is wrong, the solver catches it)

### Test 3: Nested expansion composability

```
Load diagram with two expandable groups A and B.
Expand A, then B.
Assert: verifyNoOverflow() returns empty array

Collapse all, expand B, then A.
Assert: same final transforms regardless of order
```

### Test 4: Round-trip stability

```
For each expandable group:
  Expand → collapse → expand
  Assert: final transforms match first expansion
  Assert: no drift accumulation
```
