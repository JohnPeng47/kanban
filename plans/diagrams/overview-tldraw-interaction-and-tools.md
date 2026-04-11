# tldraw Interaction System: Tools & State Machines

How user input flows through the system and how complex interactions are decomposed.

## Event routing: DOM to active tool

```
Browser DOM event (pointerdown, pointermove, wheel, keydown, ...)
    │
    ▼
Canvas event handlers → normalize into TLEventInfo
    │
    │  TLEventInfo = { name, target, ... }
    │  name: 'pointer_down' | 'pointer_move' | 'pointer_up' |
    │        'key_down' | 'key_up' | 'wheel' | 'pinch' |
    │        'double_click' | 'long_press' | 'cancel' | 'tick' | ...
    │  target: 'canvas' | 'shape' | 'handle' | 'selection'
    │
    ▼
Editor.dispatch(info)
    │
    │  High-frequency events (pointer_move, wheel, pinch):
    │    → queued in _pendingEventsForNextTick
    │    → flushed on next tick (coalesced)
    │
    │  All other events:
    │    → flushed immediately
    │
    ▼
Editor._flushEventForTick(info)
    │
    ├── 1. Update editor.inputs (pointer position, modifier keys)
    │
    ├── 2. Handle special cases:
    │      wheel → camera pan or zoom (based on cameraOptions.wheelBehavior)
    │      pinch → camera zoom + pan
    │
    └── 3. Route to state machine:
           this.root.handleEvent(info)
               │
               ▼
           StateNode.handleEvent(info)
               │
               ├── Call this[EVENT_NAME_MAP[info.name]]?.(info)
               │     e.g., pointer_down → this.onPointerDown(info)
               │
               └── If still active, delegate to current child:
                     this._current?.handleEvent(info)
                         │
                         └── Recursive: walks down active path
```

## StateNode: the state machine primitive

```
class StateNode
    │
    │  Static config:
    │  ├── id: string              ← unique identifier
    │  ├── initial?: string        ← default child state
    │  ├── children?: () => []     ← child state constructors
    │  ├── isLockable: boolean     ← can be "locked" as active tool
    │  └── useCoalescedEvents      ← batch pointer_move events
    │
    │  Type: 'root' | 'branch' | 'leaf'
    │    root:   single RootState, parent of all tools
    │    branch: has children + initial state
    │    leaf:   terminal node, no children
    │
    │  Reactive state:
    │  ├── _isActive: Atom<boolean>
    │  ├── _current: Atom<StateNode | undefined>  ← active child
    │  └── _path: Computed<string>                 ← e.g. "select.idle"
    │
    │  Lifecycle:
    │  ├── enter(info, from)  ← called when state becomes active
    │  │     Sets _isActive = true
    │  │     Calls onEnter(info, from)
    │  │     Auto-transitions to initial child
    │  │
    │  ├── exit(info, to)     ← called when state becomes inactive
    │  │     Calls onExit(info, to)
    │  │     Recursively exits children
    │  │     Sets _isActive = false
    │  │
    │  └── transition(id, info)  ← navigate to child state
    │        Exits current child
    │        Enters new child
    │        Supports dot paths: 'crop.pointing_crop_handle'
    │
    │  Event handlers (all optional):
    │  ├── onPointerDown, onPointerMove, onPointerUp
    │  ├── onDoubleClick, onTripleClick, onQuadrupleClick
    │  ├── onRightClick, onMiddleClick, onLongPress
    │  ├── onKeyDown, onKeyUp, onKeyRepeat
    │  ├── onWheel, onPinchStart, onPinch, onPinchEnd
    │  ├── onCancel, onComplete, onInterrupt
    │  └── onTick
    │
    │  Key pattern: handlers call this.parent.transition('newState', info)
    │  to switch states. The parent manages which child is active.
```

## SelectTool state machine (17 child states)

```
RootState (type: 'root')
    │
    ├── SelectTool (id: 'select', initial: 'idle')
    │   │
    │   ├── Idle ◄─────────────────────────────────── default
    │   │   │  Waits for user interaction
    │   │   │  onPointerDown:
    │   │   │    target === 'canvas'    → getShapeAtPoint()
    │   │   │      hit shape?           → transition('pointing_shape')
    │   │   │      no hit?              → transition('pointing_canvas')
    │   │   │    target === 'shape'     → transition('pointing_shape')
    │   │   │    target === 'selection' → transition('pointing_selection')
    │   │   │    target === 'handle'    → transition('pointing_handle')
    │   │   │  onDoubleClick:
    │   │   │    shape is editable?     → transition('editing_shape')
    │   │   │    shape is croppable?    → transition('crop')
    │   │   │
    │   │   ▼
    │   ├── PointingCanvas ──────── pointer down on empty canvas
    │   │   │  onPointerMove (if dragging):
    │   │   │    → transition('brushing')
    │   │   │  onPointerUp:
    │   │   │    → deselect all, transition('idle')
    │   │   │
    │   │   ▼
    │   ├── Brushing ────────────── drag-select rectangle
    │   │   │  onPointerMove: update brush box, hit test shapes
    │   │   │  onPointerUp: finalize selection, transition('idle')
    │   │   │  onKeyDown(Alt): switch to ScribbleBrushing
    │   │   │
    │   │   ▼
    │   ├── ScribbleBrushing ───── alt+drag freeform selection
    │   │   │  Uses line-segment hit testing (not box)
    │   │   │
    │   │   ▼
    │   ├── PointingShape ──────── pointer down on a shape
    │   │   │  onPointerMove (if dragging):
    │   │   │    → transition('translating')
    │   │   │  onPointerUp:
    │   │   │    → select shape, transition('idle')
    │   │   │
    │   │   ▼
    │   ├── Translating ─────────── dragging shapes
    │   │   │  onEnter: capture shape snapshot
    │   │   │  onPointerMove: move shapes (with snapping)
    │   │   │  onKeyDown(Alt): toggle clone mode
    │   │   │  onTick: edge scroll if near viewport edge
    │   │   │  onPointerUp: finalize, transition('idle')
    │   │   │  onCancel: revert via bailToMark(), transition('idle')
    │   │   │
    │   │   ▼
    │   ├── PointingSelection ──── pointer down on selection bounds
    │   │   │  → transition('translating') or ('idle')
    │   │   │
    │   │   ▼
    │   ├── PointingResizeHandle ─ pointer down on resize handle
    │   │   │  → transition('resizing')
    │   │   │
    │   │   ▼
    │   ├── Resizing ────────────── resizing via handles
    │   │   │  Complex: aspect ratio lock, snap, multi-shape
    │   │   │
    │   │   ▼
    │   ├── PointingRotateHandle ─ pointer down on rotation handle
    │   │   │  → transition('rotating')
    │   │   │
    │   │   ▼
    │   ├── Rotating ────────────── rotating via handle
    │   │   │
    │   │   ▼
    │   ├── PointingHandle ──────── pointer down on shape handle
    │   │   │  → transition('dragging_handle')
    │   │   │
    │   │   ▼
    │   ├── DraggingHandle ──────── dragging a shape handle
    │   │   │
    │   │   ▼
    │   ├── PointingArrowLabel ─── pointer down on arrow label
    │   │   │
    │   │   ▼
    │   ├── EditingShape ────────── text editing / shape editing
    │   │   │  onPointerDown outside: transition('idle')
    │   │   │  onComplete: transition('idle')
    │   │   │
    │   │   ▼
    │   └── Crop (branch) ──────── crop mode for images
    │       ├── Idle
    │       ├── PointingCropHandle
    │       ├── Cropping
    │       └── TranslatingCrop
    │
    ├── HandTool (id: 'hand', initial: 'idle')
    │   ├── Idle → PointingCanvas → Dragging
    │   │  Dragging: pans camera via editor._setCamera()
    │   │  Double-click: zoom in, triple: zoom out, quad: zoom to fit
    │   │
    │   ▼
    ├── EraserTool (id: 'eraser')
    │   ├── Idle → Pointing → Erasing
    │   │
    │   ▼
    ├── DrawTool (id: 'draw')
    │   ├── Idle → Drawing
    │   │
    │   ▼
    ├── GeoTool (id: 'geo', extends BaseBoxShapeTool)
    │   ├── Idle → Pointing → (creates shape, transitions to select.resizing)
    │   │
    │   ▼
    ├── ArrowTool (id: 'arrow')
    │   ├── Idle → Pointing
    │   │
    │   ▼
    ├── TextTool, NoteTool, FrameTool, LineTool, HighlightTool, ...
    │
    └── ZoomTool (id: 'zoom')
        ├── Idle → ZoomBrushing (drag to zoom to area)
```

## Common state transition pattern

```
    ┌──────────┐  pointerDown   ┌────────────┐  pointerMove   ┌────────────┐
    │          │ ──────────────► │            │  (dragging)    │            │
    │   Idle   │                │  Pointing  │ ──────────────► │  Active    │
    │          │ ◄────────────── │            │                │ (Brushing/ │
    └──────────┘  pointerUp     └────────────┘                │ Translating│
         ▲        (no drag)           │                        │ /Resizing) │
         │                            │ cancel                 └────────────┘
         │                            ▼                              │
         │                       ┌────────────┐                      │
         └───────────────────────│  (revert)  │◄─────────────────────┘
                                 └────────────┘   pointerUp / cancel

    The "Pointing" intermediary state handles the ambiguity:
    - pointerUp without movement = click (select/deselect)
    - pointerMove past threshold = drag (start active interaction)
    - cancel = abort (revert any preview state)
```

## Tool chaining (onInteractionEnd)

```
GeoTool creates a shape, then hands off to SelectTool for resizing:

    GeoTool.Pointing
        │
        │  User starts dragging → create shape
        │
        ▼
    editor.setCurrentTool('select')
    editor.root.current.transition('resizing', {
        onInteractionEnd: 'geo',     ← return to GeoTool when done
        onCreate: (shape) => ...     ← callback
    })
        │
        ▼
    SelectTool.Resizing
        │  ... user resizes ...
        │
        │  onComplete:
        │    editor.setCurrentTool('geo')  ← back to GeoTool
        ▼
    GeoTool.Idle
```

## Advanced patterns

```
Tool ID masking (visual state ≠ internal state):
────────────────────────────────────────────────
    Hand tool activated via spacebar while in Select:
    editor.setCurrentToolIdMask('select')  ← UI shows "select" active
    But internally: root.current = HandTool.Dragging

    On spacebar release: mask cleared, actual tool shown


Long-press detection:
────────────────────
    pointer_down → start timer (500ms)
        │
        timer fires → editor.dispatch({ name: 'long_press', ... })
        │               (handled like any other event)
        │
        pointer_move beyond threshold → cancel timer


Snapshot pattern (efficient multi-shape updates):
─────────────────────────────────────────────────
    const snapshot = getTranslatingSnapshot(editor)
    // Captures: shape positions, parent transforms, binding info
    // Computed ONCE on drag start

    onPointerMove:
      for (shape of snapshot.shapes) {
        newX = snapshot.initialX + deltaX
        newY = snapshot.initialY + deltaY
      }
      editor.updateShapes(changes)  // Batched update


Edge scrolling (during drag near viewport edge):
─────────────────────────────────────────────────
    onTick (60fps):
      if (pointer near viewport edge) {
        camera.pan(direction * speed * dt)
        // Shapes follow camera movement automatically
      }
```

## Key file locations

```
packages/editor/src/lib/editor/
├── tools/
│   ├── StateNode.ts                   ← Base state machine class
│   └── BaseBoxShapeTool/              ← Template for shape creation tools
│       ├── BaseBoxShapeTool.ts
│       └── childStates/Idle.ts, Pointing.ts
├── types/
│   └── event-types.ts                 ← TLEventInfo union type

packages/tldraw/src/lib/tools/
├── SelectTool/
│   ├── SelectTool.ts                  ← Root with 17 children
│   └── childStates/
│       ├── Idle.ts                    ← ~700 lines, entry point for all
│       ├── PointingCanvas.ts
│       ├── PointingShape.ts
│       ├── Brushing.ts               ← Rectangle selection
│       ├── ScribbleBrushing.ts       ← Freeform selection
│       ├── Translating.ts            ← Shape dragging
│       ├── Resizing.ts               ← Handle-based resize
│       ├── Rotating.ts               ← Rotation handle
│       ├── EditingShape.ts           ← Text/content editing
│       ├── DraggingHandle.ts         ← Custom shape handles
│       └── Crop/                     ← Nested branch
├── HandTool/
│   ├── HandTool.ts
│   └── childStates/Idle.ts, Pointing.ts, Dragging.ts
├── EraserTool/
├── DrawTool/
└── ZoomTool/
```
