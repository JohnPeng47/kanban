# Prompt: Reflow Animation Scripts

This document instructs the LLM to generate pre-computed reflow animation scripts for expandable sections in a diagram.

---

## When to Generate

Generate a reflow script for every `<g>` element that has `data-expandable="true"`. The script encodes exactly which elements move and by how much when the section expands or collapses.

## Script Format

Place a `<script type="application/reflow+json">` block inside the expandable `<g>`, alongside the `collapsed-content` and `expanded-content` children:

```xml
<g data-reflow-group="message-channel" data-expandable="true"
   data-expand-src="message-channel.html" data-expand-w="1060" data-expand-h="340">

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

The browser ignores `<script>` tags with non-JS types — no execution risk.

## Script Fields

| Field | Type | Description |
|---|---|---|
| `trigger` | `string` | The `data-reflow-group` ID of the expandable group (must match) |
| `deltaH` | `number` | Height difference: `data-expand-h` minus the collapsed height |
| `deltaW` | `number?` | Width difference (omit if expansion is purely vertical, which is typical) |
| `translations` | `array` | Elements that translate (move) when this group expands |
| `translations[].id` | `string` | The `data-reflow-group` or `data-arrow` ID of the element to move |
| `translations[].dy` | `number` | Vertical displacement in SVG units |
| `translations[].dx` | `number?` | Horizontal displacement (omit if 0) |
| `growths` | `array` | Parent groups whose visual bounds grow |
| `growths[].id` | `string` | The `data-reflow-group` ID of the parent to grow |
| `growths[].dh` | `number` | Height increase in SVG units |
| `growths[].dw` | `number?` | Width increase (omit if 0) |

## How to Compute the Script

Follow this procedure for each expandable group:

### Step 1: Compute `deltaH`

```
deltaH = data-expand-h - collapsedHeight
```

Where `collapsedHeight` is the height of the collapsed-content `<rect>` or the bounding box of the collapsed visual.

### Step 2: Identify elements to translate

Starting from the expandable group, look at its **siblings** (elements at the same nesting level) that are positioned **below** it (higher y-coordinate). Each of these needs `dy: deltaH`.

Include both `data-reflow-group` elements and `data-arrow` elements.

```
For each sibling S below the expandable group (same parent, higher y):
  Add { "id": S's id, "dy": deltaH } to translations
```

### Step 3: Identify parents to grow

If the expandable group is **nested inside** a parent reflow group, that parent needs to grow:

```
For each ancestor group P of the expandable group:
  Add { "id": P's id, "dh": deltaH } to growths
```

When a parent grows, its own siblings below it also need to translate. Add those too:

```
For each growth { id: P, dh }:
  For each sibling S of P that is below P:
    Add { "id": S's id, "dy": dh } to translations (if not already present)
```

### Step 4: Verify mentally

After constructing the script, verify:
- Would any child overflow its parent after expansion? If so, a growth entry is missing.
- Would any siblings overlap after translation? If so, a translation entry is missing or has the wrong `dy`.
- Are arrows between groups included? They need to translate too.

## Collapse Is the Inverse

Do not generate a separate collapse script. The framework negates all deltas automatically:
- Translations become `dy: -dy`
- Growths become `dh: -dh`

## Compact Format (Optional)

For simple cases where all elements below the expansion translate by the same `deltaH` and no parents grow, use data attributes instead of a `<script>` block:

```xml
<g data-reflow-group="message-channel" data-expandable="true"
   data-expand-src="message-channel.html" data-expand-w="1060" data-expand-h="340"
   data-reflow-displace="work-loop,arrow-3,more-work,no-more-work,arrow-4,browser-time"
   data-reflow-dy="290">
```

The framework checks for `data-reflow-displace` first, then `<script type="application/reflow+json">`, then falls back to the runtime constraint solver.

## Examples

### Simple case: root-level expandable, no nesting

```
Diagram layout (collapsed):
  [title]           y=0
  [arrow-0]         y=60
  [section-a]       y=110, expandable, expand-h=400, collapsed-h=60
  [arrow-1]         y=180
  [section-b]       y=220
  [arrow-2]         y=320
  [section-c]       y=360

deltaH = 400 - 60 = 340

Script for section-a:
{
  "trigger": "section-a",
  "deltaH": 340,
  "translations": [
    { "id": "arrow-1", "dy": 340 },
    { "id": "section-b", "dy": 340 },
    { "id": "arrow-2", "dy": 340 },
    { "id": "section-c", "dy": 340 }
  ],
  "growths": []
}
```

### Nested case: expandable inside a parent group

```
Diagram layout (collapsed):
  [outer-group]     y=100, height=300
    [inner-a]       y=120
    [inner-b]       y=200, expandable, expand-h=200, collapsed-h=50
    [inner-c]       y=270
  [arrow-5]         y=420
  [next-section]    y=460

deltaH = 200 - 50 = 150

Script for inner-b:
{
  "trigger": "inner-b",
  "deltaH": 150,
  "translations": [
    { "id": "inner-c", "dy": 150 },
    { "id": "arrow-5", "dy": 150 },
    { "id": "next-section", "dy": 150 }
  ],
  "growths": [
    { "id": "outer-group", "dh": 150 }
  ]
}
```

Note: `inner-c` translates because it's a sibling below `inner-b`. `outer-group` grows because it's the parent. `arrow-5` and `next-section` translate because they're siblings below `outer-group` (the parent grew, pushing everything below it down).
