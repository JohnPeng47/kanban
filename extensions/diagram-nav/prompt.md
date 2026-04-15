# Prompt: Generate diagfren Metadata for ASCII Diagrams

You are given a plain ASCII diagram and a codebase context. Your job is to produce a diagfren-compatible `.txt` file by wrapping the diagram and adding an `anchors` block that maps visible text in the diagram to source code references.

---

## Output Format

Wrap the ASCII diagram in a ````diagram` block and append an ````anchors` block:

```
```diagram
{THE ASCII DIAGRAM — unchanged}
```

```anchors
# anchor-text            code-ref                                    label
SomeVisibleText           src/path/to/file.ts:10-50                   Description of what this references
AnotherFunction           src/other/file.ts:42                        One-line reference
```
```

## Rules

### Diagram block

- Copy the ASCII diagram exactly as-is into the ````diagram` block. Do not modify the diagram content.
- Do not add entity ID markers like `[EXX]` or bare corner IDs. The diagram should contain only the original visible text.

### Anchors block

Each row in the ````anchors` block has three columns separated by **two or more spaces**:

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

### What to anchor

- Every **function name**, **component name**, **type name**, **hook name**, or **class name** visible in the diagram that corresponds to real code.
- Every **file path** or **module name** mentioned in the diagram.
- **API endpoints**, **CLI commands**, or **configuration keys** if they appear and have a code location.
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

Produce:

```
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

```anchors
# anchor-text                          code-ref                                                  label
Viewport                                src/diagram/rendering/viewport.tsx:48-463                  Viewport component (pan/zoom container)
transformDiv                            src/diagram/rendering/viewport.tsx:77-80                   transformDiv (SVG mount, CSS transform)
OverLayer                               src/diagram/rendering/over-layer.tsx:64-127                OverLayer component (badge positioning)
OverlayBadge[]                          src/diagram/types.ts:176-186                              OverlayBadge interface
resolveAnchor(anchor, t, scene)         src/diagram/rendering/over-layer.tsx:6-52                  resolveAnchor function
```
```
