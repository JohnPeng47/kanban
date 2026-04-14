# Generating Ascii Diagrams
I want you to take the information that you've collected about your codebase and think about generate a set of ascii diagrams from them

The purpose of these ascii diagrams is to provide a 2D map for navigating and performing actions on the codebase. 

## Output Sections 
Each diagram file should be a txt file with two sections:
- a diagram enclosed within ```diagram\n<diagram>\n```
- a code ranges section enclosed within ```code-refs\n<code_ranges>\n```

ie. this is the format they should use:
RC  web-ui/src/diagram/types.ts:4-9                 Rect interface
PT  web-ui/src/diagram/types.ts:12-15               Point interface
...

## Coverage
Not all of the code ranges that you've identified need to be covered by diagrams. Just focus on the important stuff, especially interface boundaries

## Linking Diagrams 
We want a connected graph out of the diagrams, so we need introduce links between them. Mark them on the diagram with a **

## Modals
We also want to make use of the modal feature that designate parts of the diagram for expansion. You can see an example of it here -> docs/diagram/diffs/modal-expansion. If your diagram does include a modal expansion, then you should generate two files like in the example, one 

## You are Horizontally Challenged (don't feel bad)
You have a bias to favoring generating ascii diagrams that expand along the vertical direction rather than horizontal, in part because most diagrams are generated for the terminal which have a fixed width and unlimited height (scroll). The ascii diagrams you are asked generate here are not going to displayed in a terminal, and are instead used to wireframe diagrams in an infinite scroll canvas. Therefore the diagrams you generate should, on average, be balanced in both the vertical and horizontal direction

## CodeRefs on Diagrams
We want to map code ranges to their respective elements in the diagram
We will do this by adding a column in the code-refs section of the txt file that is a 2-char ID. This ID should be added to its associated diagram element in the following way:

*Note: [ID] -> ie. [AB], [JD], etc ...

- if element is text, then append [ID] to the text
- if element is box, then add [ID] to the bottom-right corner of the box

## Aggregating Multiple Diagrams
**important** For a given diagram file, you may feel that multiple sub-diagrams (used loosely here to refer any one of the multiple diagrams in a single file) should be generated to get a full coverage of the topic. If this is the case, then consider the following:
1. Composition -> Can these be collapsed into a hierarchal relationship?
    1.b) Modal -> Can the sub-diagrams be rolled up into a modal pop-up?
2. Linking -> Can the sub-diagrams be linked (visually, using arrows) together?

## Output
Now go ahead and generate the diagrams
