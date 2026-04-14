# Cross-Diagram Links
Add a ```links``` section to each diagram file that explicitly maps local entities to entities in other diagram files.

## Purpose
The `**` markers in the diagram text indicate that a connection exists to another diagram, but they don't specify *where* in that diagram the reader should land. The links section resolves this by pairing each cross-diagram reference with a specific target entity ID.

## Section Format

```links
# local-id  target-file                          target-id  description
DA           02-rendering.txt                     UD         ContentArea → useDiagram
EJ           01-architecture-and-data-flow.txt    UV         cross-diagram jump → useDiagramViewer
SS           02-rendering-svgscene-detail.txt     SS         modal expansion (full SvgScene detail)
```

Columns:
- **local-id**: entity ID from this file's ```entities``` section
- **target-file**: filename of the target diagram (same directory)
- **target-id**: entity ID from the target file's ```entities``` section
- **description**: terse — what relationship this link represents

## Rules
- One row per cross-diagram connection
- Both local-id and target-id must exist in their respective ```entities``` sections
- A local entity can link to multiple targets (different files or different entities in the same file)
- Modal expansions get a link back to their parent: `SS  02-rendering.txt  SS  parent diagram`
- Keep arrows section for intra-diagram only, links section for cross-diagram only

## When to add a link
- An entity references code that is explained in detail on another diagram
- A callback/method call crosses into another diagram's domain
- A type is defined on one diagram and consumed on another
- A modal expansion exists (bidirectional link between parent and detail)
- The `**` marker in the diagram text names another file
