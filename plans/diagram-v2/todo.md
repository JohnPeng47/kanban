# diagram-v2 TODOs

## DiagramSlot belongs in the creation layer

`StitchedDiagram.slots` and `DiagramSlot` carry layout information (slot positions, roles, transforms) that is really the responsibility of the upstream Diagram creation layer — the system that takes SubDiagrams and composes them into a single HTML artifact.

Kanban should receive fully constructed Diagrams (just an `id`, `name`, `type`, and `contentPath`). The slot metadata is retained in Kanban's types for now so we can display it (e.g. showing slot roles, compression ratios), but the long-term goal is to push this into the creation layer and have Kanban treat stitched Diagrams as opaque HTML files — same as single Diagrams.

### Migration path

1. Move slot composition logic into the upstream creation tool
2. Have the creation tool embed any slot metadata Kanban needs as `data-*` attributes in the generated HTML (e.g. `data-slot-id`, `data-slot-role`) — same pattern as `data-reflow-group` and `data-interactive`
3. Remove `slots` and `DiagramSlot` from `StitchedDiagram` in Kanban's types
4. `StitchedDiagram` collapses to just `{ id, name, type: "stitched", contentPath }` — structurally identical to `SingleDiagram` except for the type tag
5. At that point, consider whether the single/stitched distinction even matters to Kanban, or if it can be a single `Diagram` type with an optional `type` hint
