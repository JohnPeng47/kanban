---
name: diagfren
description: Use when generating or updating ASCII diagrams in this repo. Produces a diagram .txt file wrapped in ```diagram fences plus a .diagfren/ sidecar .anchors file that maps diagram text to code references for ctrl+click navigation.
---

# Prompt: Generate diagfren Metadata for ASCII Diagrams

You are given a plain ASCII diagram and a codebase context. Your job is to produce a diagfren-compatible diagram file and its sidecar anchors file that maps visible text in the diagram to source code references.

---

## Output Format

The diagram lives in a `.txt` file wrapped in a ` ```diagram ` block. The anchor metadata lives in a separate `.anchors` file under the `.diagfren/` directory, mirroring the diagram's path.

### Diagram file (`<path>/<name>.txt`)

```diagram
{THE ASCII DIAGRAM — unchanged}
```

### Anchors sidecar (`.diagfren/<path>/<name>.anchors`)

```
# anchor-text            code-ref                                    label
SomeVisibleText           src/path/to/file.ts:10-50                   Description of what this references
AnotherFunction           src/other/file.ts:42                        One-line reference
```

The sidecar file contains **only** the anchor rows — no fences, no wrappers. Lines starting with `#` are comments.

### Path mapping

For a diagram at `diagrams/my-feature/overview.txt`, the sidecar goes at `.diagfren/diagrams/my-feature/overview.anchors`.

The rule: take the diagram's path relative to the workspace root, replace the `.txt` extension with `.anchors`, and place it under `.diagfren/`.

---

## Rules

### Diagram block

- Copy the ASCII diagram exactly as-is into the ` ```diagram ` block. Do not modify the diagram content.
- Do not add entity ID markers like `[EXX]` or bare corner IDs. The diagram should contain only the original visible text.

### Anchors file

Each row has three columns separated by **two or more spaces**:

| Column | Description |
|---|---|
| **anchor-text** | An exact string that appears literally in the diagram. This is what becomes ctrl+clickable. |
| **code-ref** | `filepath:startLine` or `filepath:startLine-endLine`. Path is relative to the workspace root. |
| **label** | A short human-readable description shown on hover. |

### Choosing anchor text

- The anchor text must be a **visible substring** of a line in the diagram. The extension finds it via exact string match.
- Prefer specific, unique text: function names (`handleNavigate`), type names (`SceneElement`), component names (`DiagramContentArea`).
- Avoid overly generic text (`state`, `props`, `data`) that appears many times — if it matches multiple occurrences, all of them become clickable (which may be fine if they all refer to the same thing).
- For duplicate text that refers to different things, use a longer surrounding substring to disambiguate (e.g., `useDiagram(content)` instead of just `useDiagram`).
- Anchor text cannot span multiple lines.

### Choosing code-refs

- Point to the most specific location: the function definition, type declaration, or component — not the whole file.
- Use `file:startLine-endLine` for multi-line definitions, `file:line` for single-line references.
- Paths are relative to the workspace root (e.g., `src/utils/foo.ts`, not `/home/user/project/src/utils/foo.ts`).
- Code-refs can point to **any file type** — source code, other diagram `.txt` files, markdown docs, etc.

### Cross-diagram references

When a diagram references concepts detailed in another diagram, mark the reference in the diagram text with square brackets: `[See viewport-overview]` or `[→ rendering detail]`. The bracketed text becomes the anchor-text in the `.anchors` file, with the code-ref pointing to the target diagram's `.txt` file and line.

Example in diagram:
```
│  Viewport handles pan/zoom [→ viewport-detail]  │
```

Corresponding anchor:
```
[→ viewport-detail]  diagrams/viewport-detail.txt:1  Viewport pan/zoom detail diagram
```

This keeps cross-diagram links visually distinct from code references in the diagram source.

### What to anchor

- Every **function name**, **component name**, **type name**, **hook name**, or **class name** visible in the diagram that corresponds to real code.
- Every **file path** or **module name** mentioned in the diagram.
- **API endpoints**, **CLI commands**, or **configuration keys** if they appear and have a code location.
- **Cross-diagram references** in `[..]` brackets pointing to other diagram `.txt` files.
- Skip purely decorative text: box-drawing characters, section titles that don't correspond to code, generic labels like "Browser" or "Server".

---

## Example

Given this ASCII diagram and codebase knowledge:

```
┌─ Viewport ─────────────────────────┐
│                                     │
│  transformDiv (CSS transform)       │
│  OverLayer (absolute, z:10)         │
│    badges: OverlayBadge[]           │
│    resolveAnchor(anchor, t, scene)  │
│                                     │
└─────────────────────────────────────┘
```

Produce two files:

**`diagrams/viewport-overview.txt`**

```diagram
┌─ Viewport ─────────────────────────┐
│                                     │
│  transformDiv (CSS transform)       │
│  OverLayer (absolute, z:10)         │
│    badges: OverlayBadge[]           │
│    resolveAnchor(anchor, t, scene)  │
│                                     │
└─────────────────────────────────────┘
```

**`.diagfren/diagrams/viewport-overview.anchors`**
```
# anchor-text                          code-ref                                                  label
Viewport                                src/diagram/rendering/viewport.tsx:48-463                  Viewport component (pan/zoom container)
transformDiv                            src/diagram/rendering/viewport.tsx:77-80                   transformDiv (SVG mount, CSS transform)
OverLayer                               src/diagram/rendering/over-layer.tsx:64-127                OverLayer component (badge positioning)
OverlayBadge[]                          src/diagram/types.ts:176-186                              OverlayBadge interface
resolveAnchor(anchor, t, scene)         src/diagram/rendering/over-layer.tsx:6-52                  resolveAnchor function
```

