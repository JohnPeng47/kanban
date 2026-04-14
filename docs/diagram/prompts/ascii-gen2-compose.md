  Diagram Composition: Connected Flow Style

  Problem to avoid

  Sub-diagrams separated by section headers with no visual connections. Each section is a standalone "encyclopedia entry" about a topic. The reader has to
  infer how they relate.

  Principles

  1. Nest by containment, not by topic. If component A renders inside component B at runtime, draw A's box physically inside B's box. Don't give them
  separate sections.
  2. Arrow every data dependency. If box A produces something that box B consumes, draw an arrow between them with a label. Common examples:
    - A function returns a value consumed by another → arrow with the value name
    - A ref is shared between siblings → ◄── shared ──► annotation
    - A state change invalidates a cache → arrow labeled with the side-effect
    - A callback fires across component boundaries → arrow from source to handler
  3. Show the flow direction. The diagram should have a dominant flow that the reader follows — typically top-to-bottom for construction/lifecycle,
  left-to-right for data transformation. Place the entry point at the top or left.
  4. Consolidate related islands with connecting tissue. If two boxes are in separate sections but one calls methods on the other, remove the section break
  and place them adjacent with arrows. The section headers can become labels inside a larger containing box.
  5. Side-by-side for parallel/sibling things. Dispatch branches (if/else/switch), sibling components, or independent subsystems go side-by-side
  horizontally. Sequential steps go top-to-bottom.
  6. Cross-diagram links go on the arrows, not floating. Instead of ** other-diagram.txt as a disconnected note, attach it to the specific arrow or box edge
   where the handoff happens.

  Checklist for redrawing

  - Can I trace a continuous path from the entry point to every box without jumping across a section break?
  - Does every box that produces output have an arrow showing where that output goes?
  - Are runtime parent-child relationships reflected by physical nesting?
  - Are shared resources (refs, caches, state) shown with arrows to all consumers?
  - Are side-effects (cache invalidation, DOM mutation) shown as arrows back to the affected box?