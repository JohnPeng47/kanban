❯ Okay just to clarify:
  # The overall goal here is to take generated sub-diagrams and convert them into a UI representation such that:
  - the sub-diagram and all its components are rendered 1:1 to their current coordinate system
  > *important*: this is important to note because it means that relative spatial relationships need to be worked out *precisely* here, now at the sub-diagram
  generation stage rather than relying on some magic translation stage later
  - the final output should be a graph of sub-diagrams where any sub-diagram (in its rendered form, more on this later) will be fully reachable from any other starting
  point on the final rendered form
  - the way we build this graph is via the 3 methods described

  # Let's also clarify some terminology:
  - SubDiagram refers to the individual diagram files that we have generated previously
  - Diagram refers to a single rendered Diagram file in the UX
  > a Diagram may be composed of one or more SubDiagrams (via. #2 Connection method)
  > we will discuss how to join these in a later section
  - A Connection is when a SubDiagram is connected to another SubDiagram in one of the following 3 ways:
  1. Modal Popups -> takes a SubDiagram and associates it with an ExpansionPoint on a code-ref, such that when the code-ref is clicked, the SubDiagram is popped and
  overlays it itself on the existing graph
  2. Stitched -> multiple SubDiagrams per Diagram
  > ... -> write joining logic
  3. Links -> .. now that I think abt this, I realize the way we did it was wrong
  -> Currently we *only* had jump links mapped code-ref -> code-ref
  -> This makes sense in some cases, but we should generalize both the JumpSrc and JumpTarget a bit more generically
  -> Lets define these:
  --> JumpSrc: source of jump, will move camera to a JumpTarget
  ---> sources can be:
  ---> code-ref, *jump-src* -> this will just be a non-code ref region
  --> JumpTarget:
  ---> can jump between same Diagram (note that Links are a property of Diagrams) or to a point on a different Diagram -> we should label these differently
  ---> the target can be a code-ref or any arbitrary-
  ---> *Note: write this into experiments/ideas -> Links/Jumps should carry state data, so we can do quick multi-hop jumps ie. jump to other jump nodes to trace a flow,
  and on each jump trigger some different UI interaction ie. expand diff nodes based on which specific exact jump trace we are on

  # Connection Distribution:
  Currently, we only have links (3) connections, and only that of the code-ref -> code-ref variety. To achieve the of creating a fully connected, *balanced* UI output,
  we should have re-distribute some of the connections amongst the other types, Modal Popups (1) and Stitched (2)

  *important* -> the word "balanced" refers to a quality of feeling that we are not leaning too heavily on one abstraction over the other, and that over the set of
  SubDiagrams we are covering, all 3 types of Connections should be used .. which does not *nessescarily* imply a *uniform* distribution, but that they "spread out" the
  information amongst them, spatially, in a way that really makes the best use of each spatial relationship to encode the associated code information

  ## Distribution Tips
  ### Modal
  - Lets keep in mind when positioning Modals such that when multiple Modals are expanded, they have minimum overlap with each other
  - Another thing to keep in mind is that Modal pop-ups should almost always be smaller than their parents -> large Modals expansions are better off existing as a
  separate Diagram linked (3) or a connected part of the same Diagram (2)

  Okay this is alot of info, so Ill just enter this into your context for now. I have not yet specified a caveat on how to construct Stitched (2) systems yet. But we
  will work through some examples before we execute the whole workflow. Dont edit any files just yet, just tell me, does this all make sense?