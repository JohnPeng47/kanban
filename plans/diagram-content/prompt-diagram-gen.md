# Prompt: Diagram Generation

This document is the combined LLM instruction set for generating a complete diagram with both reflow groups and interactive elements in a single pass. 
---

## Output Format

All generated diagrams (including those referenced by `data-modal` and `data-link` attributes) are served from a `diagrams/` folder at the repository root. Place all diagram HTML files within this directory tree.

Generate a single HTML file containing an `<svg>` element. The SVG uses a dark theme with monospace fonts.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{DIAGRAM_TITLE}</title>
  <style>
    body { margin: 0; padding: 0; background: #1F2428; overflow: hidden; height: 100vh; }
    svg { display: block; width: 100%; height: 100%; }
  </style>
</head>
<body>
<svg id="diagram" xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 {WIDTH} {HEIGHT}"
  font-family="'JetBrains Mono','Fira Code','SF Mono','Cascadia Code','Consolas',monospace"
  font-size="11">

  <!-- SVG styles -->
  <style>
    text { fill: #8B949E; }
    .white { fill: #E6EDF3; }
    .blue { fill: #4C9AFF; }
    .green { fill: #3FB950; }
    .violet { fill: #A371F7; }
    .orange { fill: #D29922; }
    .red { fill: #F85149; }
    .dim { fill: #6E7681; }
    .title { font-size: 14px; font-weight: 600; }
    .heading { font-size: 13px; font-weight: 600; }
    .subhead { font-size: 10px; }
    .flow-dash { stroke-dasharray: 6,4; animation: dash-flow 1.5s linear infinite; }
    @keyframes dash-flow { to { stroke-dashoffset: -20; } }
    .fade-section { opacity: 0; animation: fade-up 0.6s ease forwards; }
    @keyframes fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  </style>

  <!-- Arrow markers -->
  <defs>
    <marker id="a" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
      <path d="M0,0 L7,2.5 L0,5" fill="none" stroke="#8B949E" stroke-width="1"/>
    </marker>
    <marker id="ab" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
      <path d="M0,0 L7,2.5 L0,5" fill="none" stroke="#4C9AFF" stroke-width="1"/>
    </marker>
  </defs>

  <!-- Background -->
  <rect x="-5000" y="-5000" width="11000" height="11000" fill="#1F2428"/>

  <!-- DIAGRAM CONTENT GOES HERE -->

</svg>
</body>
</html>
```

## Element Structure

Every visual block in the diagram is a `<g>` element that carries zero or more roles via `data-*` attributes. A single `<g>` can be a reflow group, an interactive element, both, or neither.

### Roles

| Role | Attribute | Purpose |
|---|---|---|
| Reflow group | `data-reflow-group="<id>"` | Tells the reflow engine this block moves as a unit |
| Interactive | `data-interactive="<id>"` | Makes this block selectable, maps it to source code |
| Arrow | `data-arrow` | A connector between groups, tracked for displacement |
| Expandable | `data-expandable="true"` | This group can expand/collapse to show detail |

### Dual-role elements (the common case)

Most top-level blocks carry both `data-reflow-group` and `data-interactive`:

```xml
<g data-reflow-group="work-loop"
   data-interactive="scheduler-work-loop"
   data-ref="packages/scheduler/src/forks/Scheduler.js:400-480"
   data-category="function"
   data-label="workLoop"
   class="fade-section" style="animation-delay: 0.45s">

  <rect x="20" y="596" width="1060" height="280" rx="4"
        fill="#24292E" stroke="#D29922" stroke-width="1.5"/>
  <text x="32" y="618" class="orange heading"
        data-tt="Scheduler.js:400 — workLoop: the core scheduling loop">
    ► 04-work-loop
  </text>
  <!-- ...content... -->
</g>
```

### Interactive-only elements (nested inside a group)

A clickable label or call site inside a larger block. Not a reflow group — it doesn't need independent displacement:

```xml
<g data-interactive="scheduler-should-yield"
   data-ref="packages/scheduler/src/forks/Scheduler.js:480-485"
   data-category="call"
   data-label="shouldYieldToHost">
  <rect x="50" y="646" width="700" height="70" rx="3"
        fill="#2D3339" stroke="#D29922" stroke-width="0.6"/>
  <text x="62" y="664"
        data-tt="Scheduler.js:480 — shouldYieldToHost(): 5ms budget check">
    ► 05-yield-mechanism
  </text>
</g>
```

### Reflow-only elements (no source code reference)

A decorative section or structural block that needs to move during reflow but isn't selectable:

```xml
<g data-reflow-group="separator" class="fade-section">
  <line x1="20" y1="1082" x2="1080" y2="1082" stroke="#444C56" stroke-width="1"/>
  <text x="20" y="1100" class="white title">EMERGENT BEHAVIORS</text>
</g>
```

### Arrows (between groups)

Arrows are siblings of the groups they connect, never children:

```xml
<g data-arrow class="fade-section" style="animation-delay: 0.3s">
  <line x1="500" y1="288" x2="500" y2="338" stroke="#8B949E" stroke-width="1" marker-end="url(#a)"/>
  <text x="510" y="320" class="dim subhead">creates task object</text>
</g>
```

---

## Reflow Group Rules

1. **Wrap every logical block** in `<g data-reflow-group="<id>">`.
2. **Do not put arrows inside reflow groups.** Arrows must be siblings.
3. **Nest groups when a block contains sub-blocks** that could resize independently.
4. **Use descriptive kebab-case IDs** reflecting the concept (e.g., `data-structures`, `work-loop`), not position (e.g., `box-3`).
5. **Layout vertically.** Top-to-bottom. The reflow engine assumes this orientation.
6. **Leave 40-60 SVG unit gaps** between groups for arrows and annotations.
---

## Interactive Element Rules

1. **Annotate every element that references source code** with `data-interactive`, `data-ref`, and `data-category`.
2. **`data-ref` format:** `<filepath>:<line>` or `<filepath>:<startLine>-<endLine>`. Paths relative to repo root.
3. **Categories:** Choose from: `module`, `function`, `type`, `data`, `flow`, `call`, `concept`, `annotation`.
4. **Provide `data-label`** (1-3 words) for elements that appear in selection lists.
5. **Provide `data-tt`** for tooltips. Format: `filename:line — description`.
6. **Interactive elements can be nested.** A `function` block containing `call` elements — both independently selectable.
7. **Not everything is interactive.** Skip decorative elements, section titles without code refs, visual-only elements.
8. **Use stable IDs** matching pattern `<module>-<element>` (e.g., `scheduler-work-loop`).

---

## Cross-Diagram Navigation Attributes

Two optional attributes on `[data-interactive]` elements that create connections between diagrams. These enable click-to-navigate between related diagram files.

### `data-modal` — pop-up overlay

Clicking this element opens another diagram as a pop-up overlay drawn over the current diagram. The overlay is fully interactive (select, code-jump, and nested modals/links all work). Use this when the target diagram provides contextual detail about the clicked element — e.g., clicking a type reference to see its anatomy.

```
data-modal="<relative-path-to-diagram.html>"
data-modal-position="below-right"          (optional, default "auto")
```

The path is a standard relative path resolved against the current diagram's directory. For example, if the current diagram is `layout3/scheduler-detail/base.html` and `data-modal="message-channel.html"`, the viewer loads `layout3/scheduler-detail/message-channel.html`. The target file is another SVG HTML file following the same format as all other diagrams.

Position values: `above-left`, `above-right`, `below-left`, `below-right`, `left`, `right`, `auto`.

**Example — clicking Geometry2d opens its anatomy diagram as a pop-up:**

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

### `data-link` — jump to another diagram

Clicking this element navigates to a specific element on another diagram (or a different location on the same diagram), centering the viewport on the target. Use this when two diagrams reference the same code and the user should be able to follow that reference — e.g., jumping from a hit-test flow to the reactive-primitives anatomy where Atom is defined.

```
data-link="<relative-path-to-diagram.html>#<target-element-id>"
data-link="<relative-path-to-diagram.html>"
```

- Path is a standard relative path resolved against the current diagram's directory (same resolution as `data-modal`). The target is another SVG HTML file following the same format.
- `#elementId` is the `data-interactive` ID on the target diagram. The viewer loads the target, finds the element, and centers the viewport on it.
- If `#elementId` is omitted, the viewport centers on the target diagram's root.

**Example — clicking Atom jumps to the reactive-primitives diagram, centered on the atom-detail element:**

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

### When to use which

| Use | When |
|---|---|
| `data-modal` | The target is a compact, contextual detail view. The user wants to peek at it without losing their place. |
| `data-link` | The target is a full diagram the user should navigate to. The current view is left behind (browser back returns). |
| Neither | The element only references source code. Normal click jumps to the editor (or alt+click when modal/link is present). |

### Click behavior with navigation attributes

- **Normal click** on an element with `data-modal`: opens the overlay
- **Normal click** on an element with `data-link`: executes the jump
- **Normal click** on an element with neither: jumps to source code in editor
- **Alt+click** on any interactive element: always jumps to source code in editor (bypasses modal/link)

An element can carry `data-modal` or `data-link` alongside all other interactive attributes (`data-ref`, `data-category`, `data-label`, `data-tt`). The navigation attribute adds a click behavior; it does not replace the element's code reference or tooltip.

---

## Visual Conventions

### Box styles

| Element type | Border color | Fill | Notes |
|---|---|---|---|
| Primary section | `#4C9AFF` (blue) | `#24292E` | Main concepts |
| Process / flow | `#D29922` (orange) | `#24292E` | Active operations |
| Success / green path | `#3FB950` (green) | `#24292E` | Positive outcomes |
| Error / red path | `#F85149` (red) | `#24292E` | Failures, warnings |
| Abstract / pattern | `#A371F7` (violet) | `#24292E` | Concepts, patterns |
| Nested / inner box | any color, `stroke-width="0.6"` | `#2D3339` | Sub-elements |
| Outer container | double border, `stroke-width="1.2"` | `#24292E` | Major boundaries |

### Text styles

| Role | Class | Size |
|---|---|---|
| Section title | `.white .title` | 14px bold |
| Block heading | `.{color} .heading` | 13px bold |
| Body text | `.white` or color class | 11px |
| Annotation | `.dim .subhead` | 10px |

### Animation

Use `class="fade-section"` with incremental `style="animation-delay: {N}s"` (start at 0, increment by 0.05s) for staggered entrance.

---

## Complete Example

```xml
<!-- Title -->
<g data-reflow-group="title" class="fade-section" style="animation-delay: 0s">
  <text x="20" y="28" class="white title">SYSTEM NAME</text>
  <text x="20" y="52" class="dim subhead">Description of the system</text>
</g>

<!-- Arrow: title → first section -->
<g data-arrow class="fade-section" style="animation-delay: 0.05s">
  <line x1="550" y1="60" x2="550" y2="100" stroke="#8B949E" stroke-width="1" marker-end="url(#a)"/>
</g>

<!-- First section — reflow group + interactive -->
<g data-reflow-group="entry-point"
   data-interactive="sys-entry"
   data-ref="src/main.ts:10-50"
   data-category="function"
   data-label="main"
   class="fade-section" style="animation-delay: 0.1s">

  <rect x="20" y="110" width="1060" height="80" rx="4"
        fill="#24292E" stroke="#4C9AFF" stroke-width="1"/>
  <text x="32" y="135" class="blue heading"
        data-tt="main.ts:10 — Application entry point">
    ► entry-point
  </text>
  <text x="32" y="155" class="dim subhead">Initializes the system and starts processing</text>
</g>

<!-- Arrow -->
<g data-arrow class="fade-section" style="animation-delay: 0.15s">
  <line x1="550" y1="200" x2="550" y2="240" stroke="#8B949E" stroke-width="1" marker-end="url(#a)"/>
</g>

<!-- Section with nested interactive elements -->
<g data-reflow-group="processor"
   data-interactive="sys-processor"
   data-ref="src/processor.ts:1-200"
   data-category="module"
   data-label="Processor"
   class="fade-section" style="animation-delay: 0.2s">

  <rect x="20" y="250" width="1060" height="160" rx="4"
        fill="#24292E" stroke="#D29922" stroke-width="1"/>
  <text x="32" y="275" class="orange heading">► processor</text>

  <!-- Nested interactive: a specific function -->
  <g data-interactive="sys-process-item"
     data-ref="src/processor.ts:45-80"
     data-category="function"
     data-label="processItem">
    <rect x="40" y="290" width="480" height="50" rx="3"
          fill="#2D3339" stroke="#D29922" stroke-width="0.6"/>
    <text x="52" y="315" class="orange"
          data-tt="processor.ts:45 — Processes a single work item">
      processItem()
    </text>
  </g>

  <!-- Another nested interactive -->
  <g data-interactive="sys-validate"
     data-ref="src/processor.ts:90-120"
     data-category="function"
     data-label="validate">
    <rect x="540" y="290" width="480" height="50" rx="3"
          fill="#2D3339" stroke="#3FB950" stroke-width="0.6"/>
    <text x="552" y="315" class="green"
          data-tt="processor.ts:90 — Validates input before processing">
      validate()
    </text>
  </g>
</g>
```
