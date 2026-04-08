# Prompt: Diagram Generation

This document is the combined LLM instruction set for generating a complete diagram with both reflow groups and interactive elements in a single pass. 
---

## Output Format

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
7. **For expandable sections**, add `data-expandable="true"`, `data-expand-src`, `data-expand-w`, `data-expand-h`, and the two child `<g>` containers:

```xml
<g data-reflow-group="message-channel" data-expandable="true"
   data-expand-src="message-channel.html" data-expand-w="1060" data-expand-h="340">
  <g class="collapsed-content">
    <!-- visible when collapsed -->
  </g>
  <g class="expanded-content">
    <!-- populated by framework when expanded -->
  </g>
</g>
```

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
