# Graph Metadata Information
You are going to go over each of the generated diagram files and add the following sections

## 1. Diagram Entities
Add an ```entities``` section listing diagram elements that can be referenced as jump targets or arrow endpoints.

Indentation reflects containment (matches diagram nesting). `#` lines are comments for grouping.

### Section Format

```entities
# name                  id_type  id    description
component-name          box      XX    Short description
  child-element         text     YY    Short description
  another-child         marker   {#zz} Short description (no code-ref)
```

Columns:
- **name**: kebab-case, human-readable
- **id_type**: how to resolve the ID on the diagram
  - `box` — find `[XX]` on the bottom-right corner of a box
  - `text` — find `[XX]` appended to a text line
  - `marker` — find `{#xx}` token placed inline (for elements without a code-ref)
- **id**: the 2-char code-ref ID (e.g. `DV`) or a `{#xx}` marker for entities that don't map to source code. Use `--` for section headers with no ID.
- **description**: terse

Entity IDs and code-ref IDs share the same 2-char `[XX]` namespace. The `[brackets]` on the diagram already disambiguate from plain text — no prefix needed.

## 2. Edges for Intra-Diagram Connections
Look through each of your generated diagram files and create an edges section that explicitly enumerates each of the intra-diagram arrow connections in the diagram

The purpose of this excercise is not only to generate the relevant metadata for downstream processing, but to also get *you* to verify each arrow connection is both clearly drawn and correctly illustrates a *real* relationship in the codebase

### Section Format
You will be adding an arrows section ```arrows\n<arrows>\n``` to each diagram file
The format for this section will look like this:

```arrows
# src              target           description
UD                 SS               useDiagram → new SvgScene(svg)
EJ.cross           **01-arch#UV     cross-diagram jump → useDiagramViewer
```

- `src` and `target` are entity IDs from the entities section
- Dot notation for sub-paths: `HC.hitTest`, `SE.interactive`
- Cross-diagram arrows: `**filename#ID`
- One row per arrow drawn on the diagram
- Description is terse — what flows along the arrow

## 3. Notes
Add a standard ```notes``` section to each file:

```notes
Entity IDs and code-ref IDs share the same 2-char namespace. Both are resolved
by finding [XX] on the diagram (for box/text types) or {#xx} (for marker types).
No prefix is needed to disambiguate — the [brackets] already distinguish IDs from
surrounding text. Cross-diagram jump targets use the form: ** filename.txt#ID
```
