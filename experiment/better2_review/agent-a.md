# Agent A — Accuracy audit: Module State, Data Structures, Priority → Timeout Axis

Source of truth:
- `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerMinHeap.js`
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerPriorities.js`
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerFeatureFlags.js`

Diagram audited (task's path `/home/john/kanban/experiment/better2_diagram.html` does not exist; the file lives at `/home/john/kanban/experiment/iter-1/better2_diagram.html`).

---

## Module State

Diagram rows (from `► Scheduler.js module scope`, lines 298–392 of the HTML).

### Cross-check of every variable

| # | Diagram text | Shown line | Source line | Correct? | Notes |
|---|--------------|-----------:|------------:|:--------:|-------|
| 1 | `taskQueue` (DATA, blue/heap) | L79 | L79 (`var taskQueue: Array<Task> = [];`) | OK | |
| 2 | `taskIdCounter` (DATA, blue/heap) | L83 | L83 (`var taskIdCounter = 1;`) | Minor: category | Value is an integer counter, not a heap/data structure. Icon choice defensible but "heap/data" is imprecise. |
| 3 | `getCurrentTime` (DATA, blue/heap) | L59 | L59 declaration, assigned 66/70 | Minor: category | It is a function reference, not heap/data. Blue "heap/data" icon is imprecise. Line number L59 matches source declaration. |
| 4 | `timerQueue` (DATA, blue/heap) | L80 | L80 (`var timerQueue: Array<Task> = [];`) | OK | |
| 5 | `maxSigned31BitInt` (DATA, blue/heap) | L76 | L76 (`var maxSigned31BitInt = 1073741823;`) | Minor: category | It is a `var` constant, not a heap/data structure. Icon/category imprecise, line correct. |
| 6 | `currentTask` (EXECUTION, orange/pointer) | L85 · "module-level pointer" | L85 (`var currentTask = null;`) | OK | Written 191/240; the "module-level pointer" comment matches preloop doc §2.5. |
| 7 | `currentPriorityLevel` (EXECUTION, orange/pointer) | L86 · "leaks mid-loop" | L86 (`var currentPriorityLevel: PriorityLevel = NormalPriority;`) | OK | "leaks mid-loop" is an accurate-enough hint (set at L205 in `workLoop`, restored in `flushWork` finally at L179). |
| 8 | `isPerformingWork` (EXECUTION, green/flag) | L89 · "re-entrance guard" | L89 (`var isPerformingWork = false;`) | OK | Matches source comment L88 (`// This is set while performing work, to prevent re-entrance.`). |
| 9 | `isHostCallbackScheduled` (PUMP, green/flag) | L91 | L91 (`var isHostCallbackScheduled = false;`) | OK | |
| 10 | `isHostTimeoutScheduled` (PUMP, green/flag) | L92 | L92 (`var isHostTimeoutScheduled = false;`) | OK | |
| 11 | `isMessageLoopRunning` (PUMP, green/flag) | L437 · "cancel = flip false" | L437 (`let isMessageLoopRunning = false;`) | OK | Effective cancel is `isMessageLoopRunning = false` inside `performWorkUntilDeadline` finally at L510. |
| 12 | `taskTimeoutID` (PUMP, blue/heap) | L438 · "single-slot handle · −1 = none" | L438 (`let taskTimeoutID: TimeoutID = (-1: any);`) | Minor: category | "single-slot handle" and "−1 = none" are correct (reset to `-1` at L569). Icon should arguably be the pointer ring (orange), not heap/data (blue), since it stores a handle, not data. Minor inconsistency with EXECUTION row's `currentTask` using pointer for a similar single-slot handle. |
| 13 | `startTime` (SLICE, red/time) | L445 · "⚠ NOT Task.startTime" | L445 (`let startTime = -1;`) | OK | Naming-collision warning is correct and important — `Task.startTime` is a field on the task record (type declaration L53), while this module-level `startTime` is the per-slice anchor used by `shouldYieldToHost` at L452 and assigned at L493. |
| 14 | `frameInterval` (SLICE, red/time) | L444 · "= frameYieldMs (5 ms)" | L444 (`let frameInterval: number = frameYieldMs;`) | OK | `frameYieldMs = 5` at `SchedulerFeatureFlags.js:11`. |
| 15 | `needsPaint` (SLICE, green/flag) | L94 · "cleared L487 · set L464" | L94 (`var needsPaint = false;`) | OK | Source confirms: `needsPaint = false;` at L487 inside `performWorkUntilDeadline`, `needsPaint = true;` at L464 inside `requestPaint`. |

### Missing / extra variables
- **No missing variables.** All 15 module-level declarations (including the late-declared L437, L438, L444, L445 cluster) are shown.
- **No phantom variables.** Nothing is shown that does not exist in source.
- The diagram does not show the captured locals `localSetTimeout` (L97), `localClearTimeout` (L98), `localSetImmediate` (L100) or the function-level `schedulePerformWorkUntilDeadline` (L516). These are defensibly "not state", so omission is fine, but note they are technically module scope.

### Module State summary
- All line numbers match source exactly.
- All textual annotations are accurate ("re-entrance guard", "module-level pointer", "single-slot", "NOT Task.startTime", "cleared L487 · set L464", "= frameYieldMs (5 ms)").
- Icon assignment has a few minor type-system smells (`taskIdCounter`, `getCurrentTime`, `maxSigned31BitInt`, `taskTimeoutID` are not really heap/data in the legend's strict sense) but nothing is factually wrong.

---

## Data Structures

Section `► Min-heaps — SchedulerMinHeap.js` (HTML L400–514).

### Tree + flat array values

- **taskQueue tree:** root `100`, left `350`, right `5000`, left-left `5200`, left-right `5250`, right-left `MAX`. Flat: `[100, 350, 5000, 5200, 5250, MAX]`.
  - Heap order check: `100 ≤ 350`, `100 ≤ 5000`, `350 ≤ 5200`, `350 ≤ 5250`, `5000 ≤ MAX`. **All satisfied.** Valid min-heap. OK.
- **timerQueue tree:** root `t+100`, left `t+500`, right `t+1k`, left-left `t+2s`, left-right `t+3s`. Flat: `[t+100, t+500, t+1k, t+2s, t+3s]`.
  - Heap order check: `100 ≤ 500`, `100 ≤ 1000`, `500 ≤ 2000`, `500 ≤ 3000`. **All satisfied.** Valid min-heap by startTime. OK.

### Indexing formulas (`SchedulerMinHeap.js`)

Diagram shows (HTML L497–499):
```
parent(i) = (i − 1) >>> 1
left(i)   = 2 * i + 1
right(i)  = 2 * i + 2
```

Source (`SchedulerMinHeap.js`):
- `parentIndex = (index - 1) >>> 1;` (L45) — **MATCHES**.
- `leftIndex = (index + 1) * 2 - 1;` (L64) — algebraically equals `2*i + 1`. **EQUIVALENT.**
- `rightIndex = leftIndex + 1;` (L66) — equals `2*i + 2`. **EQUIVALENT.**

All three formulas are correct. Minor note: the diagram's `left(i) = 2 * i + 1` form is a clean algebraic simplification of the source's `(index + 1) * 2 - 1`. The exported/teachable form is standard and correct. **OK.**

### `compare(a, b)` formula

Diagram (HTML L503–505):
```
compare(a, b) · SchedulerMinHeap.js:91
(a.sortIndex − b.sortIndex)  ||  (a.id − b.id)
primary key ◀ · FIFO tiebreaker (taskIdCounter) ▶
```

Source (`SchedulerMinHeap.js:91–95`):
```
function compare(a: Node, b: Node) {
  // Compare sort index first, then task id.
  const diff = a.sortIndex - b.sortIndex;
  return diff !== 0 ? diff : a.id - b.id;
}
```

The shown formula is semantically correct: `diff !== 0 ? diff : a.id - b.id` is the long form of `(a.sortIndex - b.sortIndex) || (a.id - b.id)` when `diff` is a non-zero integer. **Line reference `SchedulerMinHeap.js:91` is the function declaration line — correct.** OK.

### `advanceTimers` description

Diagram (HTML L510–511):
```
advanceTimers · L103-125 (the timerQueue → taskQueue migration loop)
loop peek timerQueue:   cb null? → pop (cancelled sweep)   ·
                        fired? → pop + rewrite sortIndex + push(taskQueue)   ·
                        future? → return
```

Source (`Scheduler.js:103–125`):
```
103: function advanceTimers(currentTime: number) {
104:   // Check for tasks that are no longer delayed and add them to the queue.
105:   let timer = peek(timerQueue);
106:   while (timer !== null) {
107:     if (timer.callback === null) {
108:       // Timer was cancelled.
109:       pop(timerQueue);
110:     } else if (timer.startTime <= currentTime) {
111:       // Timer fired. Transfer to the task queue.
112:       pop(timerQueue);
113:       timer.sortIndex = timer.expirationTime;
114:       push(taskQueue, timer);
...
119:     } else {
120:       // Remaining timers are pending.
121:       return;
122:     }
123:     timer = peek(timerQueue);
124:   }
125: }
```

The three branches (cb null → pop; fired → pop + rewrite sortIndex + push; future → return) and the line range L103–L125 **match exactly.** OK.

### Complexity line

Diagram (HTML L513):
```
peek O(1) · push O(log n) · pop O(log n) · cancelCb O(1) (tombstone only)
```

All four correct:
- `peek` is an array index read (`heap[0]`). O(1).
- `push` is siftUp. O(log n).
- `pop` is siftDown. O(log n).
- `unstable_cancelCallback` (Scheduler.js:418) just sets `task.callback = null` with no heap removal — O(1) tombstone. Matches the source comment at L427–L429. OK.

### Line references for heap ops

The diagram currently only references `SchedulerMinHeap.js` as a module (L496 says "indexing formulas (SchedulerMinHeap.js)") and cites `:91` for compare. The task prompt mentions "Line references for push/pop/peek (SchedulerMinHeap.js:17,23,27)". The diagram does **not** actually display these three line references inline. Source confirms:

- `push` — L17 OK
- `peek` — L23 OK
- `pop` — L27 OK

Those are factually correct, but the diagram does not carry them, so there is nothing to verify beyond "the task prompt's claim is accurate." Minor: worth adding these three line refs next to the complexity line for consistency with the rest of the diagram's citation style.

### Data Structures summary
- Heap trees are valid min-heaps.
- Flat array mapping 0–5 is correct for both trees.
- Indexing formulas are mathematically equivalent to source (source uses `(i+1)*2-1` form).
- Compare formula is semantically equivalent to source L91–95.
- `advanceTimers` behavior and L103–125 reference are exact.
- Complexity annotation is correct.

---

## Priority Axis

Section `► Priority → timeout → expirationTime` (HTML L221–289).

### Timeout constants

Diagram claims / axis labels:

| Priority | Diagram timeout | Source | Source line |
|----------|----------------:|-------:|------------:|
| Immediate | `−1 ms` | `timeout = -1;` | `Scheduler.js:350` |
| UserBlocking | `250 ms · clicks` | `userBlockingPriorityTimeout = 250` | `SchedulerFeatureFlags.js:13` (ref `Scheduler.js:354`) |
| Normal | `5 s` | `normalPriorityTimeout = 5000` | `SchedulerFeatureFlags.js:14` (ref `Scheduler.js:367`) |
| Low | `10 s · unused` | `lowPriorityTimeout = 10000` | `SchedulerFeatureFlags.js:15` (ref `Scheduler.js:362`) |
| Idle | `≈ 12.43 d` | `timeout = maxSigned31BitInt;` (= 1073741823 ms) | `Scheduler.js:358`, constant at L76 |

All five timeout values match source. OK.

### Source line range

Diagram header (HTML L225):
```
Scheduler.js:346-369 · expirationTime = startTime + timeout
```

Source: the `switch (priorityLevel)` block spans L347–L369, with `var timeout;` at L346 and `var expirationTime = startTime + timeout;` at L371. **The cited range L346–369 matches exactly** (it starts at the `var timeout;` declaration and ends at the closing `}` of the switch). The formula `expirationTime = startTime + timeout` is source L371 and is correct. OK.

### Log-scale axis positions

Axis definition: `x = 90` at `log10 = 0` (1 ms), `x = 1140` at `log10 = 9` (1 Gs). Slope = `(1140 − 90) / 9 = 116.667` px per decade.

| Priority | Timeout (ms) | log10 | Expected x | Diagram x (cx) | Δ px |
|----------|-------------:|------:|-----------:|---------------:|-----:|
| UserBlocking | 250 | 2.3979 | 369.76 | 370 | +0.2 |
| Normal | 5000 | 3.6990 | 521.55 | 521 | −0.5 |
| Low | 10000 | 4.0000 | 556.67 | 557 | +0.3 |
| Idle | 1073741823 | 9.0309 | 1143.60 | 1140 | **−3.6** |

- UserBlocking, Normal, Low: within sub-pixel accuracy. OK.
- Idle: visually pinned at x=1140 (end of the "1 Gs" tick). The mathematically correct position is x≈1143.6, i.e. **just past the axis end-cap**. The inline comment at HTML L282 (`x ≈ 1144`) acknowledges this, but the actual `cx` attribute used is `1140`. Minor: the placement is rounded to the axis end for visual reasons; the comment contradicts the actual attribute value by ~3.6 px. Labeling-level nitpick only.

Immediate is shown off-axis at x=55 with a dashed gap to the axis start at x=90 — this matches the "Imm is not on the log scale because `-1 ms` is not representable" logic and is correctly flagged as "always expired" (HTML L231). OK.

### "Low (10 s · unused)" label

Diagram (HTML L279–280):
```
Low (10 s · unused)
```

Verification:
- `SchedulerFeatureFlags.js:15` — `export const lowPriorityTimeout = 10000;` — timeout is 10 s. OK.
- Reconciler usage: `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberRootScheduler.js:480–498` shows the only switch that maps lane priority to Scheduler priority. The cases are `DiscreteEventPriority` / `ContinuousEventPriority` → `UserBlockingSchedulerPriority`, `DefaultEventPriority` → `NormalSchedulerPriority`, `IdleEventPriority` → `IdleSchedulerPriority`, `default` → `NormalSchedulerPriority`. **`LowPriority` is never selected by the reconciler.**
- `LowPriority` is still exported from `Scheduler.js` (L577) as `unstable_LowPriority` for external users, but is unused inside React proper.

"Low (10 s · unused)" is **factually correct**. OK.

### Idle timeout exact value

Diagram (HTML L286–288):
```
≈12.43 d
Idle = maxSigned31BitInt = 2³⁰−1 = 1 073 741 823 ms ≈ 12.43 d (V8 SMI)
```

- `maxSigned31BitInt = 1073741823` at `Scheduler.js:76`. Matches.
- `2^30 − 1 = 1073741823` — correct (not `2^31 − 1`, which is 2147483647).
- Source comment at L73–75 says "Max 31 bit integer. The max integer size in V8 for 32-bit systems. Math.pow(2, 30) - 1". The diagram's "2³⁰−1" is consistent with source comment (and correct arithmetic: a signed 31-bit max value is `2^30 − 1`).
- `1073741823 / (1000 * 60 * 60 * 24) = 12.4276` days ≈ "12.43 d". OK.
- "V8 SMI" annotation: Small Integer tagging in V8 historically uses 31 bits on 32-bit systems; the source comment confirms the "Max integer size in V8 for 32-bit systems" motivation. OK.

### Priority Axis summary
- All 5 priorities with correct timeouts.
- Source line reference `Scheduler.js:346-369` is exact for the switch block (including the preceding `var timeout;`).
- Log-scale positioning is mathematically accurate to sub-pixel for UserBlocking / Normal / Low.
- Idle dot is pinned at x=1140 instead of its mathematical x≈1143.6 (diagram comment says `≈ 1144` but the SVG attribute is 1140) — MINOR 3.6 px visual placement inconsistency.
- `Low (10 s · unused)` is correct: reconciler never routes to `LowPriority`.
- Idle timeout value, `2^30 − 1`, decimal, day conversion, and "V8 SMI" annotation are all correct.

---

## Summary

### CRITICAL (factually wrong)
**None.** No variable names, line numbers, comments, formulas, heap values, timeouts, or source line ranges are factually incorrect.

### MINOR (imprecise / nitpick)
1. **Idle dot placement** — `cx="1140"` in SVG (HTML L283), but the inline comment at L282 says "x ≈ 1144" and the mathematical position is x≈1143.6. Visually Idle is clipped to the end-cap instead of sitting ~4 px past it. Diagram and its own comment disagree; choose one. (`/home/john/kanban/experiment/iter-1/better2_diagram.html:282-283`)
2. **Icon category for `taskIdCounter`** — shown with the blue "heap/data" circle (HTML L321) but it is an incrementing integer counter, not a data structure. (`:321`)
3. **Icon category for `maxSigned31BitInt`** — blue heap/data circle (HTML L332) but it is a `var` constant. (`:332`)
4. **Icon category for `getCurrentTime`** — blue heap/data circle (HTML L324) but it is a function reference. (`:324`)
5. **Icon category for `taskTimeoutID`** — blue heap/data circle (HTML L369) but it is a single-slot timer handle. The pointer ring icon (orange) would be more consistent with `currentTask` also being a "single-slot handle"-ish field. (`:369`)
6. **Missing line citations for heap operations** — the complexity line "peek O(1) · push O(log n) · pop O(log n) · cancelCb O(1)" (HTML L513) would benefit from `SchedulerMinHeap.js:17,23,27` inline, matching the citation style used elsewhere. The prompt listed these line numbers; they are correct but not currently shown in the diagram.
7. **`left(i) = 2*i + 1` notational fidelity** — source at `SchedulerMinHeap.js:64` actually writes `leftIndex = (index + 1) * 2 - 1;`. The diagram's form is mathematically equivalent and more readable; flagged only as a notation-vs-source fidelity tradeoff, not an error.
8. **UserBlocking label "250 ms · clicks"** — technically both `DiscreteEventPriority` and `ContinuousEventPriority` map to `UserBlockingSchedulerPriority` (`ReactFiberRootScheduler.js:485-488`), so "clicks" is a simplification (mouse-move, pointer-move, etc. also route here). Defensible as a one-word hint.

### OK (matches source exactly)
- All 15 module-level variable names and line numbers (L59, 76, 79, 80, 83, 85, 86, 89, 91, 92, 94, 437, 438, 444, 445).
- Role groupings DATA / EXECUTION / PUMP / SLICE are sensible and match preloop doc §2 clustering.
- All comments: "re-entrance guard" (L89), "module-level pointer" (L85), "leaks mid-loop" (L86), "−1 = none" (L438), "cleared L487 · set L464" (L94), "= frameYieldMs (5 ms)" (L444), "cancel = flip false" (L437).
- `⚠ NOT Task.startTime` collision warning on module-level `startTime` (L445) — correct and important; `Task.startTime` is the task-record field declared in the `Task` type at L53.
- Both heap example trees satisfy the min-heap parent≤child invariant.
- Flat array 0–5 mapping matches tree breadth-first layout for both heaps.
- `parent(i) = (i-1) >>> 1` at `SchedulerMinHeap.js:45`. Exact.
- `left`/`right` formulas algebraically equal to `SchedulerMinHeap.js:64,66`.
- `compare(a, b)` semantics and `SchedulerMinHeap.js:91` reference (function declaration line).
- `advanceTimers` three branches and line range `Scheduler.js:103-125`. Exact.
- All 5 priority timeout constants (-1, 250, 5000, 10000, 1073741823).
- `Scheduler.js:346-369` switch statement range. Exact.
- Log-scale x positions for UserBlocking (370), Normal (521), Low (557). Sub-pixel accurate.
- `Low (10 s · unused)` — reconciler never routes to LowPriority (verified in `ReactFiberRootScheduler.js:480-498`).
- Idle = `1073741823` ms ≈ `12.43 d`, `2^30 − 1` exponent, V8 SMI annotation.
- `frameInterval ≈ frameYieldMs (default 5 ms)` — `SchedulerFeatureFlags.js:11` is `frameYieldMs = 5`.
- `needsPaint` clear/set line references L487 / L464. Exact.

### Relevant source file paths
- `/home/john/kanban/experiment/iter-1/better2_diagram.html` (audited; lines 298–392, 400–514, 221–289)
- `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js` (ground truth for module state and priority switch)
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerMinHeap.js` (ground truth for heap formulas + compare)
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerPriorities.js` (priority constants)
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerFeatureFlags.js` (frameYieldMs + timeout constants)
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberRootScheduler.js` (verification that LowPriority is unused by reconciler, L480–498)
- `/home/john/kanban/experiment/preloop/01-scheduler-core.md` (prior doc cross-ref)
- `/home/john/kanban/experiment/iter-2/source-doc.md` (prior doc cross-ref)
