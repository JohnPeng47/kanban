# Graph Metadata Information
You are going to go over each of the generated diagram files and add the following sections

## ID Prefixes
All IDs use a single-letter prefix to disambiguate their namespace:
- **`C` prefix** — code-ref IDs (e.g. `CPO`, `CDV`). These map to source code locations.
- **`E` prefix** — entity IDs (e.g. `EPO`, `EDV`). These label visual elements on the diagram.

The base ID (e.g. `PO`) is shared — `CPO` and `EPO` refer to the same conceptual element, but the prefix tells you which lookup table to use.

## 1. Code Refs
Add a ```code-refs``` section mapping IDs to source code locations.

### Section Format

```code-refs
CPO  web-ui/src/components/popup-overlay.tsx:63-145   PopupDiagramOverlay component
CPL  web-ui/src/components/popup-overlay.tsx:36-60    computePopupLayout
```

Columns:
- **id**: `C`-prefixed ID (e.g. `CPO`)
- **file**: path relative to repo root
- **lines**: line range (e.g. `63-145`)
- **description**: terse

## 2. Diagram Entities
Add an ```entities``` section listing ALL visual elements in the diagram — boxes AND text paragraphs.

**Every paragraph must be an entity.** A paragraph is any group of text lines that are visually together (separated from other text by blank lines, box borders, or structural elements). This includes:
- Box titles and their content
- Multi-line text blocks (descriptions, field lists, logic steps)
- Section headers
- Single-line annotations
- Title, cross-reference lines, etc.

Each entity's `[EXX]` label must appear in the diagram body on the first line of its paragraph (for text) or at the box corner (for boxes).

Indentation reflects containment (matches diagram nesting). `#` lines are comments for grouping.

### Section Format

```entities
# name                   id_type  id     parent  description

# Section Group
popup-overlay            box      EPO    --      PopupDiagramOverlay (full component)
  backdrop-desc          text     EBK    EPO     Backdrop styling and click-to-close
  positioned-popup       box      EPP    EPO     Positioned popup div
    popup-layout         text     EPL    EPP     computePopupLayout: input/output
    sizing-logic         text     ESZ    EPP     Sizing: maxW/H 85%, min 200x150
```

Columns:
- **name**: kebab-case, human-readable
- **id_type**: how to resolve the ID on the diagram
  - `box` — find `EXX` on the bottom-right corner of a box border
  - `text` — find `[EXX]` appended to a text paragraph's first line
  - `marker` — find `{#exx}` token placed inline (for sequence steps, etc.)
- **id**: `E`-prefixed entity ID (e.g. `EPO`). Use `--` for section headers with no ID.
- **parent**: entity ID of the containing element, or `--` for top-level
- **description**: terse

## 3. Edges for Intra-Diagram Connections
Look through each of your generated diagram files and create an edges section that explicitly enumerates each of the intra-diagram arrow connections in the diagram

The purpose of this exercise is not only to generate the relevant metadata for downstream processing, but to also get *you* to verify each arrow connection is both clearly drawn and correctly illustrates a *real* relationship in the codebase

### Section Format
You will be adding an arrows section ```arrows\n<arrows>\n``` to each diagram file
The format for this section will look like this:

```arrows
# src              target           description
EUD                ESS              useDiagram → new SvgScene(svg)
EEJ.cross          **01-arch#EUV   cross-diagram jump → useDiagramViewer
```

- `src` and `target` are `E`-prefixed entity IDs from the entities section
- Dot notation for sub-paths: `EHC.hitTest`, `ESE.interactive`
- Cross-diagram arrows: `**filename#EXX`
- One row per arrow drawn on the diagram
- Description is terse — what flows along the arrow

## 4. Notes
Add a standard ```notes``` section to each file:

```notes
Code-ref IDs use a "C" prefix (e.g. CPO, CPL) and entity IDs use an "E" prefix
(e.g. EPO, EPL) to disambiguate the two namespaces. Every text paragraph in the
diagram is labeled with its entity ID in [EXX] brackets. Box entities show their
ID at the box corner. Cross-diagram jump targets: ** filename.txt#EXX.
```
