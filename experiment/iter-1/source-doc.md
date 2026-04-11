# React Scheduler — Comprehensive Source Documentation

Canonical source file (all line numbers below refer to it unless stated otherwise):
`/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`
(598 lines total)

Sibling files:
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerMinHeap.js` (95 lines)
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerPriorities.js` (19 lines)
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerFeatureFlags.js` (20 lines)
- `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/SchedulerMock.js` (test fork)

Reconciler integration:
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberRootScheduler.js`
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberWorkLoop.js`

---

## 1. Overview

React's Scheduler is a tiny, self-contained **cooperative time-slicing engine**
that drains a priority queue of user callbacks on the browser main thread while
yielding frequently enough that the browser can handle input, layout, paint,
and other scripts. It solves a single problem: *how do you run a potentially
large unit of JavaScript work without blocking the main thread, on an engine
that has no real preemption?*

### The six ingredients

1. **A min-heap of `Task` records** keyed by `sortIndex`, where `sortIndex`
   means either "next time to wake up" (timerQueue) or "deadline / urgency"
   (taskQueue).
2. **A priority → timeout table** that converts user-supplied priority levels
   (Immediate / UserBlocking / Normal / Low / Idle) into an `expirationTime`.
   A smaller `expirationTime` means a higher priority.
3. **A host pump** (`performWorkUntilDeadline`) posted onto a fresh macrotask
   via `MessageChannel.postMessage(null)` (browser), `setImmediate` (Node),
   or `setTimeout(..., 0)` (fallback).
4. **A work loop** (`workLoop`) that drains the taskQueue until either the
   queue is empty or the time budget is spent, then returns control.
5. **A cooperative yield protocol**: a user callback can return a function
   meaning "call me again next slice" (continuation) or anything non-function
   meaning "I'm done" (task popped).
6. **Lazy tombstone cancellation**: `unstable_cancelCallback` just sets
   `task.callback = null`; the heap position is swept only when the dead
   task floats to the root.

### Architectural highlights

- **No true preemption.** Once a user callback is invoked, it runs to
  completion on the scheduler's stack. "Preemption" in React is a heap
  re-root that happens *between* macrotasks, not during one.
- **Module-global state, self-healing via try/finally.** Every moving part
  lives on module-level `var`/`let`s. `finally` blocks restore the invariants
  so a thrown callback leaves the scheduler in a consistent state.
- **Errors are never swallowed.** The only catch clause in the scheduler is
  profiling instrumentation that re-throws. Errors propagate through
  `flushWork` into `performWorkUntilDeadline`'s `finally`, which guarantees
  the pump re-schedules itself.
- **No dependency on the reconciler.** The Scheduler does not know about
  fibers, lanes, or React. The reconciler is one consumer; `SchedulerMock`
  is a second; `SchedulerPostTask` / `SchedulerNative` are others.

### The end-to-end flow, for orientation

```
user calls unstable_scheduleCallback(priority, cb)
    └─ creates Task, push(taskQueue or timerQueue, newTask)
         └─ requestHostCallback()   // if not already running
              └─ schedulePerformWorkUntilDeadline()  // MessageChannel.postMessage(null)
                   └─ onmessage fires → performWorkUntilDeadline()
                        ├─ needsPaint = false
                        ├─ startTime = getCurrentTime()
                        ├─ flushWork(currentTime)
                        │    └─ workLoop(initialTime)
                        │         ├─ advanceTimers()        // promote fired timers
                        │         ├─ while (peek(taskQueue) !== null)
                        │         │     yield check → break if needed
                        │         │     cb(didTimeout)      // user code runs
                        │         │     if returned fn → store continuation, return true
                        │         │     else → pop completed task
                        │         └─ return true | false
                        └─ if hasMoreWork → schedulePerformWorkUntilDeadline()
                           else → isMessageLoopRunning = false
```

---

## 2. Module-level state

All module-level state lives in `Scheduler.js`. Every piece is mutable
during the lifetime of the scheduler.

### 2.1 Time source — lines 59–71

```js
let getCurrentTime: () => number | DOMHighResTimeStamp;
const hasPerformanceNow =
  typeof performance === 'object' && typeof performance.now === 'function';

if (hasPerformanceNow) {
  const localPerformance = performance;
  getCurrentTime = () => localPerformance.now();
} else {
  const localDate = Date;
  const initialTime = localDate.now();
  getCurrentTime = () => localDate.now() - initialTime;
}
```

- Captured **once** at module init. Never re-checked.
- The `localPerformance`/`localDate` pattern pins the references so a later
  polyfill cannot hijack the clock.
- Fallback subtracts `initialTime` so the reading reads `0` on first call.
- Re-exported as `unstable_now` at line 586.

### 2.2 Constants — line 76

```js
var maxSigned31BitInt = 1073741823;
```

- `2^30 - 1`, not `2^31 - 1`. Kept at 31 bits so V8 treats it as a SMI on
  32-bit systems (avoids boxing).
- `1073741823 ms ≈ 12.4259 days`. This is the "idle never times out" value.
  Documents claiming idle priority ≈ 24.86 days are using the wrong constant.

### 2.3 Heaps — lines 78–80

```js
// Tasks are stored on a min heap
var taskQueue: Array<Task> = [];
var timerQueue: Array<Task> = [];
```

| Heap | Contains | `sortIndex` equals | Meaning of root |
|---|---|---|---|
| `taskQueue` | Ready-to-run tasks | `expirationTime` | Most urgent |
| `timerQueue` | Delayed tasks (`startTime > currentTime`) | `startTime` | Next to wake |

**Invariants:**
- A task is in at most one heap at a time.
- `task.sortIndex === task.startTime` while in `timerQueue`.
- `task.sortIndex === task.expirationTime` while in `taskQueue`.
- A task moves from `timerQueue` → `taskQueue` via `advanceTimers`, which
  mutates `sortIndex` *after* popping (so the old heap's invariant is never
  violated).

### 2.4 ID counter — line 83

```js
var taskIdCounter = 1;
```

Monotonically increasing. Stamped via `id: taskIdCounter++` at line 374.
The min-heap comparator uses `id` as a FIFO tiebreaker for equal `sortIndex`.

### 2.5 Execution state — lines 85–86

```js
var currentTask = null;
var currentPriorityLevel: PriorityLevel = NormalPriority;
```

- `currentTask` — the task currently being processed by `workLoop`.
  Written at line 191 (`peek(taskQueue)`) and line 240 (re-peek). Reset to
  `null` in `flushWork`'s `finally` at line 178.
- `currentPriorityLevel` — the ambient priority returned by
  `unstable_getCurrentPriorityLevel()`. Mutated by `runWithPriority`,
  `next`, `wrapCallback`, `workLoop` (per task at line 205), and saved/
  restored by `flushWork` at lines 158/179.

### 2.6 Re-entry / host-loop flags — lines 89–92

```js
// This is set while performing work, to prevent re-entrance.
var isPerformingWork = false;

var isHostCallbackScheduled = false;
var isHostTimeoutScheduled = false;
```

- `isPerformingWork` — `true` between `flushWork` entry (line 157) and its
  `finally` (line 180). Used at line 409 to suppress redundant
  `requestHostCallback` calls when a new task is scheduled from *inside* a
  running callback (the already-running loop will pick it up on its next
  iteration).
- `isHostCallbackScheduled` — `true` when a `performWorkUntilDeadline`
  message is in flight. Cleared at line 150 on `flushWork` entry. Suppresses
  duplicate host callback scheduling.
- `isHostTimeoutScheduled` — `true` when `handleTimeout` is armed via
  `requestHostTimeout` to promote a delayed task. Cleared on the first line
  of `handleTimeout` (128) and in `flushWork`'s pre-flush cleanup (153).

### 2.7 Paint flag — line 94

```js
var needsPaint = false;
```

- Set to `true` by `requestPaint()` (line 464) only when
  `enableRequestPaint` is `true`.
- Cleared at the *start* of every `performWorkUntilDeadline` slice (line 487).
- Read by `shouldYieldToHost` (line 448): if set, forces an immediate yield.

### 2.8 Captured native host APIs — lines 97–101

```js
const localSetTimeout = typeof setTimeout === 'function' ? setTimeout : null;
const localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : null;
const localSetImmediate =
  typeof setImmediate !== 'undefined' ? setImmediate : null; // IE and Node.js + jsdom
```

- Captured at module init to defeat later polyfill / zone.js / fake-timer
  monkey-patching.
- The `typeof X !== 'undefined'` guard is the portable alternative to
  `globalThis.X` and works in any environment without throwing a
  `ReferenceError` for undeclared globals.
- All three may be `null`; the host-pump selector at lines 516–547 branches
  on them.

### 2.9 Message-loop state — lines 437–438

```js
let isMessageLoopRunning = false;
let taskTimeoutID: TimeoutID = (-1: any);
```

- `isMessageLoopRunning` — guards the `MessageChannel`/`setImmediate` pump
  against double-scheduling. Set `true` by `requestHostCallback` (line 551)
  right before the first `schedulePerformWorkUntilDeadline`. Cleared to
  `false` inside `performWorkUntilDeadline` (line 510) when a flush finishes
  with no more work. A re-check at line 489 lets the pump cleanly bail if
  someone set the flag `false` between ticks.
- `taskTimeoutID` — the handle returned by `localSetTimeout` inside
  `requestHostTimeout` (line 561). `-1` means "no timeout armed".

### 2.10 Frame yielding — lines 444–445

```js
let frameInterval: number = frameYieldMs;
let startTime = -1;
```

- `frameInterval` — initialized from the imported `frameYieldMs` (default
  `5` in `SchedulerFeatureFlags.js` line 11; `10` in the www build;
  `5` in native-fb).
- `startTime` — module-level variable, **not to be confused with
  `Task.startTime`**. This is "wall clock when the current browser task
  began draining work". Written at line 493 at the top of
  `performWorkUntilDeadline`. Read by `shouldYieldToHost` at line 452.
  Initial sentinel `-1` is never observed because `shouldYieldToHost` is
  only called from inside `workLoop` which is only reachable via
  `performWorkUntilDeadline`.

### 2.11 Quick state summary

| Variable | Line | Purpose | Written by |
|---|---|---|---|
| `getCurrentTime` | 59 | Time source | once at init |
| `maxSigned31BitInt` | 76 | Idle timeout sentinel | const |
| `taskQueue` | 79 | Ready min-heap | `push`/`pop` |
| `timerQueue` | 80 | Delayed min-heap | `push`/`pop` |
| `taskIdCounter` | 83 | FIFO tiebreaker | `scheduleCallback` |
| `currentTask` | 85 | In-flight task | `workLoop`, `flushWork` finally |
| `currentPriorityLevel` | 86 | Ambient priority | `runWithPriority`, `workLoop` |
| `isPerformingWork` | 89 | Re-entry guard | `flushWork` try/finally |
| `isHostCallbackScheduled` | 91 | Pump-scheduled flag | `scheduleCallback`, `handleTimeout`, `flushWork` |
| `isHostTimeoutScheduled` | 92 | Timer-scheduled flag | `scheduleCallback`, `handleTimeout`, `flushWork` |
| `needsPaint` | 94 | Paint yield flag | `requestPaint`, `performWorkUntilDeadline` |
| `localSetTimeout` | 97 | Captured native API | once at init |
| `localClearTimeout` | 98 | Captured native API | once at init |
| `localSetImmediate` | 100 | Captured native API | once at init |
| `isMessageLoopRunning` | 437 | Pump guard | `requestHostCallback`, `performWorkUntilDeadline` |
| `taskTimeoutID` | 438 | Host timeout handle | `requestHostTimeout`, `cancelHostTimeout` |
| `frameInterval` | 444 | Slice budget in ms | `forceFrameRate` |
| `startTime` | 445 | Slice anchor | `performWorkUntilDeadline` line 493 |

---

## 3. Data structures

### 3.1 `Task` — lines 49–57

```js
export type Callback = boolean => ?Callback;

export opaque type Task = {
  id: number,
  callback: Callback | null,
  priorityLevel: PriorityLevel,
  startTime: number,
  expirationTime: number,
  sortIndex: number,
  isQueued?: boolean,
};
```

| Field | Purpose |
|---|---|
| `id` | Monotonic insertion stamp, used as FIFO tiebreaker in the heap comparator. |
| `callback` | The user function. `null` means "cancelled or in-flight or completed". |
| `priorityLevel` | One of `ImmediatePriority`, `UserBlockingPriority`, `NormalPriority`, `LowPriority`, `IdlePriority`. Written into `currentPriorityLevel` at line 205 before invocation. |
| `startTime` | Earliest wall time the task is allowed to run. For immediate tasks, this is `getCurrentTime()` at scheduling time. For delayed tasks, `currentTime + options.delay`. |
| `expirationTime` | `startTime + timeout` where `timeout` comes from the priority switch (lines 347–369). The task is "overdue" when `expirationTime <= currentTime`. |
| `sortIndex` | The heap key. Equals `startTime` in `timerQueue`, equals `expirationTime` in `taskQueue`. Initialized `-1` at creation, rewritten immediately. |
| `isQueued?` | Only touched under `enableProfiling`. Bookkeeping for profile events. |

**Callback contract:** `Callback = (didTimeout: boolean) => ?Callback`. The
Scheduler calls the callback with `didUserCallbackTimeout` (whether
`expirationTime <= currentTime`). A return of another function means
"continuation — call me again next slice"; a return of `null`/`undefined`/
anything non-function means "task is done".

### 3.2 `SchedulerMinHeap` — a flat-array binary heap

Source: `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerMinHeap.js`

API:

```js
type Node = { id: number, sortIndex: number, ... };
type Heap<T: Node> = Array<T>;

push<T>(heap, node): void       // lines 17-21
peek<T>(heap): T | null         // lines 23-25
pop<T>(heap): T | null          // lines 27-40
```

- `push`: append then `siftUp`.
- `peek`: `heap[0]` or `null`.
- `pop`: saves `heap[0]`, `Array.pop()`s the last element, moves last to
  index 0, sifts down. No-op sift when heap had one element.

**Comparator (lines 91–95):**

```js
function compare(a: Node, b: Node) {
  const diff = a.sortIndex - b.sortIndex;
  return diff !== 0 ? diff : a.id - b.id;
}
```

Primary key: `sortIndex`. Secondary (tiebreaker): `id` — so insertion order
wins for equal sort keys (FIFO). `id` is strictly increasing via
`taskIdCounter++` at line 374.

`siftUp` (lines 42–57) uses `(index - 1) >>> 1` (unsigned shift) for the
parent-index calculation. `siftDown` (lines 59–89) uses
`leftIndex = (index + 1) * 2 - 1` which is algebraically `2*index + 1`,
and prefers the left child on a tie.

**The heap only supports popping the root.** There is no `removeAt(i)`.
This is the constraint that forces the lazy tombstone approach to
cancellation (§11).

| Operation | Cost |
|---|---|
| `peek` | O(1) |
| `push` | O(log n) |
| `pop` | O(log n) |
| `unstable_cancelCallback` | O(1) (tombstone only) |
| `advanceTimers` draining k timers | O(k log n) |

**Call sites of `push`/`peek`/`pop`** are restricted to `advanceTimers`,
`workLoop`, `handleTimeout`, and `unstable_scheduleCallback`. The heap is
**never iterated**.

### 3.3 Why two queues

Splitting delayed from ready tasks lets the scheduler answer both questions
it cares about in O(1) via `peek`:

1. "What should I run right now?" → `peek(taskQueue)`.
2. "How long until the earliest delayed task wakes?" →
   `peek(timerQueue).startTime - currentTime`.

The `Task` object is the same shape in both heaps; only `sortIndex` is
rewritten on promotion.

### 3.4 `sortIndex` semantics

The same field means two different things in the two heaps. When a delayed
task migrates inside `advanceTimers` at line 113, the field is rewritten:

```js
timer.sortIndex = timer.expirationTime;
```

This mutation happens **after** `pop(timerQueue)` (line 112) and **before**
`push(taskQueue, timer)` (line 114) — so at no point is a node present in
a heap with an incorrect sortIndex.

---

## 4. Priorities

### 4.1 The six levels — `SchedulerPriorities.js`

```js
// Line 10
export type PriorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

// Lines 13-18
export const NoPriority = 0;
export const ImmediatePriority = 1;
export const UserBlockingPriority = 2;
export const NormalPriority = 3;
export const LowPriority = 4;
export const IdlePriority = 5;
```

`NoPriority` is a sentinel; it is never a valid argument to
`unstable_scheduleCallback`. If you pass it, the default branch of the
switch coerces to `NormalPriority`.

### 4.2 Priority → timeout table

```js
// Scheduler.js:346-369
switch (priorityLevel) {
  case ImmediatePriority:
    timeout = -1;                     // from inline constant
    break;
  case UserBlockingPriority:
    timeout = userBlockingPriorityTimeout;   // 250 ms (feature flags line 13)
    break;
  case IdlePriority:
    timeout = maxSigned31BitInt;      // 1073741823 ms ≈ 12.43 days (inline)
    break;
  case LowPriority:
    timeout = lowPriorityTimeout;     // 10000 ms (feature flags line 15)
    break;
  case NormalPriority:
  default:
    timeout = normalPriorityTimeout;  // 5000 ms (feature flags line 14)
    break;
}
```

| Priority | Timeout | Where defined |
|---|---|---|
| `ImmediatePriority` | `-1` | inline (Scheduler.js line 350) |
| `UserBlockingPriority` | `250` | `SchedulerFeatureFlags.js` line 13 |
| `NormalPriority` | `5000` | `SchedulerFeatureFlags.js` line 14 |
| `LowPriority` | `10000` | `SchedulerFeatureFlags.js` line 15 |
| `IdlePriority` | `1073741823` | inline (Scheduler.js line 358), `maxSigned31BitInt` |

**Non-obvious details:**

- Idle is hoisted *above* Low / Normal in the switch order to handle the
  special case before the fall-through.
- `NormalPriority` shares the `default:` arm, so unknown values silently
  become normal priority.
- `NoPriority` (0) is not a case — it falls through to normal.
- `ImmediatePriority` uses `-1`, so `expirationTime = startTime - 1` is
  already in the past at the moment of creation. This makes the task
  "always expired" (§13), so `shouldYieldToHost` is bypassed on every pass
  and the task runs to completion.

### 4.3 `expirationTime` computation — line 371

```js
var expirationTime = startTime + timeout;
```

This single expression is the entire priority system. A smaller
`expirationTime` = higher priority = closer to heap root = runs sooner.
There is no separate "priority" field used for ordering.

- `ImmediatePriority`: `startTime - 1` → smallest possible → always root,
  always expired.
- `UserBlockingPriority`: `startTime + 250` → gets to the top quickly.
- `NormalPriority`: `startTime + 5000`.
- `LowPriority`: `startTime + 10000`.
- `IdlePriority`: `startTime + 1073741823` → practically infinite.

### 4.4 `currentPriorityLevel` and the ambient-priority API

Module-level variable, line 86:

```js
var currentPriorityLevel: PriorityLevel = NormalPriority;
```

Read/written by:
- `unstable_getCurrentPriorityLevel()` (lines 433–435) — reads it.
- `workLoop` (line 205) — sets it per-task before invoking the callback.
- `flushWork` (line 158 snapshot, line 179 restore) — restores on exit.
- `unstable_runWithPriority` (lines 275–281) — save/swap/restore.
- `unstable_next` (lines 300–306) — save/swap/restore, but "demote to
  Normal, never promote".
- `unstable_wrapCallback` (lines 316–322) — captures at wrap time, restores
  on each call.

Note: changing `currentPriorityLevel` is purely ambient. It does not
schedule anything; callbacks scheduled via `unstable_scheduleCallback` use
whatever `priorityLevel` is passed explicitly.

### 4.5 Reconciler's effective priority usage

| Scheduler priority | React uses? | Trigger |
|---|---|---|
| `ImmediatePriority` | Rarely | Only microtask-unavailable fallback |
| `UserBlockingPriority` | Very common | Discrete / continuous input events |
| `NormalPriority` | Very common | Default render, passive effects, cache abort |
| `LowPriority` | **No** | Exported but no production caller |
| `IdlePriority` | Yes | Idle lanes, post-paint transition callbacks |

Sync work **bypasses the scheduler entirely** — it runs via microtask in
`processRootScheduleInMicrotask`. See ReactFiberRootScheduler.js:482–484:
> "Scheduler does have an 'ImmediatePriority', but now that we use
> microtasks for sync work we no longer use that."

---

## 5. Public API

All exports are at lines 572–588:

```js
export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  shouldYieldToHost as unstable_shouldYield,
  requestPaint as unstable_requestPaint,
  getCurrentTime as unstable_now,
  forceFrameRate as unstable_forceFrameRate,
};
```

Plus an `unstable_Profiling` object (lines 590–598) which is `null` unless
`enableProfiling` is true.

### 5.1 `unstable_scheduleCallback(priorityLevel, callback, options?): Task`
Lines 327–416. See §6.1 for the full body.

### 5.2 `unstable_cancelCallback(task: Task): void`
Lines 418–431. Sets `task.callback = null` (tombstone). Never removes
from the heap. See §11.

### 5.3 `unstable_getCurrentPriorityLevel(): PriorityLevel`
Lines 433–435. Returns the module-level `currentPriorityLevel`.

### 5.4 `unstable_runWithPriority(priorityLevel, eventHandler): T`
Lines 260–283. Validates `priorityLevel` (coerces unknown to `NormalPriority`),
save/swap/restore the ambient priority around `eventHandler()`. Does not
schedule anything.

### 5.5 `unstable_next(eventHandler): T`
Lines 285–308. "Demote to Normal, but never promote":

```js
switch (currentPriorityLevel) {
  case ImmediatePriority:
  case UserBlockingPriority:
  case NormalPriority:
    priorityLevel = NormalPriority;      // shift down
    break;
  default:
    priorityLevel = currentPriorityLevel; // Low/Idle pass through
    break;
}
```

Purpose: so tasks scheduled right after an urgent event don't ride that
event's high priority unless the caller opts in.

### 5.6 `unstable_wrapCallback(callback): wrapped`
Lines 310–325. Captures the current ambient priority at wrap time into a
closure and returns a function that restores that priority each call. The
comment on line 315 says "This is a fork of runWithPriority, inlined for
performance." Preserves `this` via `callback.apply(this, arguments)`.

### 5.7 `shouldYieldToHost()` (exported as `unstable_shouldYield`)
Lines 447–460. Returns `true` when the scheduler has exhausted its slice
budget or a paint is pending. See §8.

### 5.8 `requestPaint()` (exported as `unstable_requestPaint`)
Lines 462–466. Sets `needsPaint = true` (only when `enableRequestPaint`).
The reconciler calls this in `ReactFiberWorkLoop.js:4167` after a commit
that produces visible changes, so the next `shouldYieldToHost` check will
return `true` and let the browser paint.

### 5.9 `getCurrentTime()` (exported as `unstable_now`)
Lines 59–71. High-res clock via `performance.now()` when available, else
`Date.now()` minus the module-init offset.

### 5.10 `forceFrameRate(fps: number)` (exported as `unstable_forceFrameRate`)
Lines 468–483. Adjusts `frameInterval`:

```js
function forceFrameRate(fps) {
  if (fps < 0 || fps > 125) {
    console['error']('forceFrameRate takes a positive int between 0 and 125, ' +
      'forcing frame rates higher than 125 fps is not supported');
    return;
  }
  if (fps > 0) {
    frameInterval = Math.floor(1000 / fps);
  } else {
    frameInterval = frameYieldMs;        // reset
  }
}
```

- Input validation: `[0, 125]` inclusive.
- `fps === 0` resets to `frameYieldMs` (the 5 ms default).
- `fps > 0` sets `frameInterval = floor(1000 / fps)`. Example: `fps=60 → 16`,
  `fps=120 → 8`.
- `console['error']` bracket notation evades Babel / ESLint transforms.
- The 125 fps ceiling corresponds to `frameInterval = 8 ms`. Notably, the
  built-in `frameYieldMs = 5 ms` default is *tighter* than anything
  `forceFrameRate` allows — because the default was set through the feature
  flag, not through this API.

### 5.11 APIs that are *not* present

These used to exist in older scheduler revisions but have been removed from
the production fork:

- `unstable_pauseExecution`
- `unstable_continueExecution`
- `unstable_getFirstCallbackNode`
- `cancelHostCallback` (only `cancelHostTimeout` exists)
- `isSchedulerPaused` flag
- `enableIsInputPending` / `isInputPending` / `continuousYieldTime` /
  `maxYieldInterval` (old Chromium integration — fully removed)

Some of these are still present in `SchedulerMock.js` for test purposes.

---

## 6. Task lifecycle

### 6.1 Schedule — `unstable_scheduleCallback` (lines 327–416)

```js
function unstable_scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: Callback,
  options?: {delay: number},
): Task {
  var currentTime = getCurrentTime();                          // (a) read clock once

  var startTime;                                                // (b) compute startTime
  if (typeof options === 'object' && options !== null) {
    var delay = options.delay;
    if (typeof delay === 'number' && delay > 0) {
      startTime = currentTime + delay;
    } else {
      startTime = currentTime;
    }
  } else {
    startTime = currentTime;
  }

  var timeout;                                                  // (c) priority → timeout
  switch (priorityLevel) { /* see §4.2 */ }

  var expirationTime = startTime + timeout;                     // (d)

  var newTask: Task = {                                         // (e) build Task
    id: taskIdCounter++,
    callback,
    priorityLevel,
    startTime,
    expirationTime,
    sortIndex: -1,
  };
  if (enableProfiling) {
    newTask.isQueued = false;
  }

  if (startTime > currentTime) {                                // (f) delayed branch
    newTask.sortIndex = startTime;
    push(timerQueue, newTask);
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      if (isHostTimeoutScheduled) {
        cancelHostTimeout();
      } else {
        isHostTimeoutScheduled = true;
      }
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {                                                      // (g) immediate branch
    newTask.sortIndex = expirationTime;
    push(taskQueue, newTask);
    if (enableProfiling) {
      markTaskStart(newTask, currentTime);
      newTask.isQueued = true;
    }
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    }
  }

  return newTask;
}
```

**Non-obvious rules:**

- `delay > 0` strict check — `{delay: 0}` does **not** delay; it falls to
  the immediate branch.
- `delay` must be a number; any other type falls to immediate.
- `sortIndex = -1` is set temporarily at task construction, rewritten
  immediately below (line 387 for delayed, line 401 for immediate) before
  the task enters a heap.
- The delayed-branch check
  `peek(taskQueue) === null && newTask === peek(timerQueue)` asks two
  questions via only `peek` operations: "is there any ready work?" (no →
  we'll need a host timeout) and "is this newly inserted timer now the
  earliest?" (yes → this timer is the one to wake up on).
- If a host timeout was already armed, it is cancelled and re-armed with
  the new (earlier) delay. The `isHostTimeoutScheduled` flag stays `true`
  across the cancel + re-arm.
- The immediate branch's `!isPerformingWork` guard is the "we're already
  inside a running workLoop" check — the live loop will pick up the new
  task on its next iteration, no need to spawn another pump.

### 6.2 Queue — pushed into `timerQueue` or `taskQueue`

Post-push invariants:

- `taskQueue` is a min-heap keyed by `expirationTime` — its root is "most
  urgent".
- `timerQueue` is a min-heap keyed by `startTime` — its root is "earliest
  to wake".
- The heap comparator breaks ties by `id`, giving FIFO order for equal keys.

### 6.3 Promote — `advanceTimers` (lines 103–125)

```js
function advanceTimers(currentTime: number) {
  // Check for tasks that are no longer delayed and add them to the queue.
  let timer = peek(timerQueue);
  while (timer !== null) {
    if (timer.callback === null) {
      // Timer was cancelled.
      pop(timerQueue);
    } else if (timer.startTime <= currentTime) {
      // Timer fired. Transfer to the task queue.
      pop(timerQueue);
      timer.sortIndex = timer.expirationTime;
      push(taskQueue, timer);
      if (enableProfiling) {
        markTaskStart(timer, currentTime);
        timer.isQueued = true;
      }
    } else {
      // Remaining timers are pending.
      return;
    }
    timer = peek(timerQueue);
  }
}
```

Three cases per peek:
1. Cancelled timer (`callback === null`) — pop and discard.
2. Fired timer (`startTime <= currentTime`) — pop, rewrite `sortIndex` from
   `startTime` → `expirationTime`, push into `taskQueue`.
3. Not yet fireable — return. (Min-heap invariant: if the root isn't ready,
   nothing deeper is either.)

Call sites of `advanceTimers`:
- `workLoop` line 190 (entry)
- `workLoop` line 223 (before continuation yield)
- `workLoop` line 235 (after task completion)
- `handleTimeout` line 129

### 6.4 Execute — see §7 (`workLoop`)

### 6.5 Complete / yield / cancel
See §7 for completion in `workLoop`, §10 for continuation-yield, and §11
for cancellation.

### 6.6 `handleTimeout` — host timeout fires (lines 127–142)

```js
function handleTimeout(currentTime: number) {
  isHostTimeoutScheduled = false;
  advanceTimers(currentTime);

  if (!isHostCallbackScheduled) {
    if (peek(taskQueue) !== null) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    } else {
      const firstTimer = peek(timerQueue);
      if (firstTimer !== null) {
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
    }
  }
}
```

Logic:
1. Clear `isHostTimeoutScheduled`.
2. Promote any fired timers.
3. If no host callback is already scheduled:
   - If there is now ready work, scheduleHostCallback and pump.
   - Else if a later timer is pending, re-arm the host timeout for it.
     **Note:** line 138 calls `requestHostTimeout` without setting
     `isHostTimeoutScheduled = true`. This is a minor inconsistency. Its
     effect is that a subsequent `scheduleCallback` taking the earlier-timer
     branch will go through the `else` at line 394 (the flag is `false` so
     it sets it to `true`) and arm a new timeout — orphaning the one from
     line 138. The orphaned timeout fires harmlessly because `handleTimeout`
     is idempotent (it re-reads the heap and re-decides from scratch).

---

## 7. The work loop

### 7.1 `workLoop(initialTime)` — lines 188–258

```js
function workLoop(initialTime: number) {
  let currentTime = initialTime;
  advanceTimers(currentTime);
  currentTask = peek(taskQueue);
  while (currentTask !== null) {
    if (!enableAlwaysYieldScheduler) {
      if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
        // This currentTask hasn't expired, and we've reached the deadline.
        break;
      }
    }
    const callback = currentTask.callback;
    if (typeof callback === 'function') {
      currentTask.callback = null;
      currentPriorityLevel = currentTask.priorityLevel;
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
      if (enableProfiling) {
        markTaskRun(currentTask, currentTime);
      }
      const continuationCallback = callback(didUserCallbackTimeout);
      currentTime = getCurrentTime();
      if (typeof continuationCallback === 'function') {
        // If a continuation is returned, immediately yield to the main thread
        // regardless of how much time is left in the current time slice.
        currentTask.callback = continuationCallback;
        if (enableProfiling) {
          markTaskYield(currentTask, currentTime);
        }
        advanceTimers(currentTime);
        return true;
      } else {
        if (enableProfiling) {
          markTaskCompleted(currentTask, currentTime);
          currentTask.isQueued = false;
        }
        if (currentTask === peek(taskQueue)) {
          pop(taskQueue);
        }
        advanceTimers(currentTime);
      }
    } else {
      pop(taskQueue);
    }
    currentTask = peek(taskQueue);
    if (enableAlwaysYieldScheduler) {
      if (currentTask === null || currentTask.expirationTime > currentTime) {
        break;
      }
    }
  }
  // Return whether there's additional work
  if (currentTask !== null) {
    return true;
  } else {
    const firstTimer = peek(timerQueue);
    if (firstTimer !== null) {
      requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
    }
    return false;
  }
}
```

Step-by-step:

1. **Line 189** — `currentTime = initialTime` (threaded in from `flushWork`).
2. **Line 190** — `advanceTimers(currentTime)` to promote any fired timers
   before the main loop starts.
3. **Line 191** — `currentTask = peek(taskQueue)`. Writes to the
   **module-level** `currentTask`, not a local.
4. **Line 192** — `while (currentTask !== null)`.
5. **Lines 193–198 — yield check** (skipped under `enableAlwaysYieldScheduler`):
   `if (currentTask.expirationTime > currentTime && shouldYieldToHost()) break;`
   Only yield if the task hasn't expired AND host wants control. Expired
   tasks bypass yield (§13).
6. **Line 200** — `const callback = currentTask.callback;` snapshot into a
   local.
7. **Line 201** — `if (typeof callback === 'function')` — live task branch.
   - **Line 203** — `currentTask.callback = null;` the **pre-invocation
     tombstone**. If the callback throws at line 212, the task is already
     dead; on the next slice it will be popped. If line 203 ran *after*
     line 212, a throwing task would be re-invoked infinitely.
   - **Line 205** — `currentPriorityLevel = currentTask.priorityLevel;`
     so `unstable_getCurrentPriorityLevel()` inside the callback sees the
     task's own priority.
   - **Line 207** — `didUserCallbackTimeout = currentTask.expirationTime <= currentTime;`
   - **Line 212** — `const continuationCallback = callback(didUserCallbackTimeout);`
     **No try/catch** around this call. The callback runs synchronously on
     the scheduler's stack.
   - **Line 213** — `currentTime = getCurrentTime();` the **post-callback
     clock refresh**. See §10 for why this matters.
   - **Line 214 — continuation branch:**
     - **Line 218** — `currentTask.callback = continuationCallback;`
       re-arms the same task. The heap position, `sortIndex`, `expirationTime`,
       and `id` are all unchanged.
     - **Line 223** — `advanceTimers(currentTime);` — promote timers that
       fired during the long callback.
     - **Line 224** — `return true;` — the only "yield with more work"
       early-return.
   - **Line 225 — completion branch:**
     - **Lines 232–234** — `if (currentTask === peek(taskQueue)) pop(taskQueue);`
       The user callback might have scheduled a more urgent task making
       `currentTask` no longer the root. If so, leave it (its callback is
       already `null`) — it becomes a tombstone that will be popped later.
     - **Line 235** — `advanceTimers(currentTime);`
8. **Line 237 — cancelled branch** (`callback === null`): `pop(taskQueue);`
   unconditionally (the task is known to be the root).
9. **Line 240** — `currentTask = peek(taskQueue);` refresh for next iter.
10. **Lines 241–246 — `enableAlwaysYieldScheduler` post-loop check:**
    break if no more tasks or next task hasn't expired. At most one expired
    task per slice in this experimental mode.
11. **Lines 248–257 — termination tail:**
    - If `currentTask !== null` (exited via break): `return true;`.
    - Else: heap empty. If there's a future timer, arm `handleTimeout` for
      its wake time, then `return false;`.

### 7.2 Return values

| Return | Meaning | Line |
|---|---|---|
| `true` | Yielded via continuation | 224 |
| `true` | Yielded for deadline / always-yield (heap non-empty) | 250 |
| `false` | Heap drained (no more tasks) | 256 |

### 7.3 `flushWork(initialTime)` — lines 144–186

```js
function flushWork(initialTime: number) {
  if (enableProfiling) {
    markSchedulerUnsuspended(initialTime);
  }

  // We'll need a host callback the next time work is scheduled.
  isHostCallbackScheduled = false;
  if (isHostTimeoutScheduled) {
    // We scheduled a timeout but it's no longer needed. Cancel it.
    isHostTimeoutScheduled = false;
    cancelHostTimeout();
  }

  isPerformingWork = true;
  const previousPriorityLevel = currentPriorityLevel;
  try {
    if (enableProfiling) {
      try {
        return workLoop(initialTime);
      } catch (error) {
        if (currentTask !== null) {
          const currentTime = getCurrentTime();
          markTaskErrored(currentTask, currentTime);
          currentTask.isQueued = false;
        }
        throw error;                      // re-throw after marking
      }
    } else {
      // No catch in prod code path.
      return workLoop(initialTime);
    }
  } finally {
    currentTask = null;
    currentPriorityLevel = previousPriorityLevel;
    isPerformingWork = false;
    if (enableProfiling) {
      const currentTime = getCurrentTime();
      markSchedulerSuspended(currentTime);
    }
  }
}
```

Structure:

- **Lines 149–155 — pre-flush cleanup:** clear `isHostCallbackScheduled` (we
  *are* the host callback now), and if a timeout was armed, cancel it
  because `workLoop`'s `advanceTimers` will handle promotions.
- **Line 157** — `isPerformingWork = true;` — combined with line 409 in
  `scheduleCallback`, prevents re-entrance of the host pump.
- **Line 158** — snapshot `previousPriorityLevel`.
- **Profiling path (160–172):** inner `try/catch` taps errors for
  `markTaskErrored`, then **re-throws**. Never swallows.
- **Production path (173–176):** bare `return workLoop(initialTime);` with
  no catch. Comment: `// No catch in prod code path.`
- **Finally (177–185):** unconditionally restore `currentTask = null`,
  `currentPriorityLevel = previousPriorityLevel`, `isPerformingWork = false`.

Two layers of `try`: outer `try/finally` for state restoration; inner
`try/catch` (profiling only) for error instrumentation that must happen
while `currentTask` is still live.

### 7.4 `performWorkUntilDeadline` — lines 485–514

```js
const performWorkUntilDeadline = () => {
  if (enableRequestPaint) {
    needsPaint = false;
  }
  if (isMessageLoopRunning) {
    const currentTime = getCurrentTime();
    // Keep track of the start time so we can measure how long the main thread
    // has been blocked.
    startTime = currentTime;

    // If a scheduler task throws, exit the current browser task so the
    // error can be observed.
    //
    // Intentionally not using a try-catch, since that makes some debugging
    // techniques harder. Instead, if `flushWork` errors, then `hasMoreWork` will
    // remain true, and we'll continue the work loop.
    let hasMoreWork = true;
    try {
      hasMoreWork = flushWork(currentTime);
    } finally {
      if (hasMoreWork) {
        // If there's more work, schedule the next message event at the end
        // of the preceding one.
        schedulePerformWorkUntilDeadline();
      } else {
        isMessageLoopRunning = false;
      }
    }
  }
};
```

Walk-through:

1. **Lines 486–488** — reset `needsPaint = false`. The browser is about to
   get a chance to paint (we're between slices).
2. **Line 489** — re-check `isMessageLoopRunning`; bail if stopped.
3. **Line 490** — read clock once.
4. **Line 493** — `startTime = currentTime;`. This is the **per-slice
   anchor** that `shouldYieldToHost` compares against. Every slice gets a
   fresh `frameInterval` budget.
5. **Line 501** — `let hasMoreWork = true;` initialized **before** the try.
6. **Lines 502–503** — `hasMoreWork = flushWork(currentTime);` runs the
   work.
7. **Lines 504–511 — finally:**
   - `hasMoreWork === true` → `schedulePerformWorkUntilDeadline()` posts the
     next message.
   - `hasMoreWork === false` → `isMessageLoopRunning = false;` halts the
     pump.
8. **Error path:** if `flushWork` throws, the assignment on line 503 never
   happens, `hasMoreWork` stays `true` (initialized at line 501), the
   `finally` re-posts the next slice, and the thrown error propagates out
   of the macrotask into the browser's top-level error handler. Self-healing.

### 7.5 Glue summary

```
unstable_scheduleCallback
  └─ requestHostCallback
       └─ schedulePerformWorkUntilDeadline
            └─ MessageChannel message / setImmediate / setTimeout
                 └─ performWorkUntilDeadline
                      ├─ needsPaint = false
                      ├─ startTime = getCurrentTime()
                      ├─ flushWork(currentTime)
                      │    ├─ isHostCallbackScheduled = false
                      │    ├─ cancelHostTimeout if scheduled
                      │    ├─ isPerformingWork = true
                      │    ├─ workLoop(initialTime)
                      │    │    ├─ advanceTimers
                      │    │    ├─ peek + yield check + run callback
                      │    │    └─ return true | false
                      │    └─ finally: reset currentTask, priority, isPerformingWork
                      └─ finally: reschedule if hasMoreWork, else halt pump
```

---

## 8. Yield mechanism

### 8.1 `shouldYieldToHost()` — lines 447–460

```js
function shouldYieldToHost(): boolean {
  if (!enableAlwaysYieldScheduler && enableRequestPaint && needsPaint) {
    // Yield now.
    return true;
  }
  const timeElapsed = getCurrentTime() - startTime;
  if (timeElapsed < frameInterval) {
    // The main thread has only been blocked for a really short amount of time;
    // smaller than a single frame. Don't yield yet.
    return false;
  }
  // Yield now.
  return true;
}
```

Two decisions in strict order:

1. **Paint fast-path** (lines 448–451): if the experimental always-yield
   flag is off, `enableRequestPaint` is on (default), and `needsPaint` has
   been set, return `true` immediately regardless of remaining budget.
2. **Deadline check** (lines 452–459): `timeElapsed = getCurrentTime() - startTime`.
   If `timeElapsed < frameInterval`, return `false` (keep working). Else
   return `true` (yield).

| Time state | `shouldYieldToHost()` |
|---|---|
| `timeElapsed < frameInterval` | `false` (keep going) |
| `timeElapsed >= frameInterval` | `true` (yield) |
| `needsPaint === true` (in non-always-yield) | `true` (yield) |

Exported as `unstable_shouldYield` at line 584. The reconciler polls it via
the re-export in `react-reconciler/src/Scheduler.js` on every fiber
iteration inside `workLoopConcurrentByScheduler`.

### 8.2 `frameInterval` / `frameYieldMs`

Declared line 444:

```js
let frameInterval: number = frameYieldMs;
```

Defaults from `SchedulerFeatureFlags.js`:

| File | `frameYieldMs` |
|---|---|
| `SchedulerFeatureFlags.js` line 11 | `5` |
| `forks/SchedulerFeatureFlags.native-fb.js` line 11 | `5` |
| `forks/SchedulerFeatureFlags.www.js` line 16 | `10` |

- **Read**: only in `shouldYieldToHost` (line 453).
- **Written**: only by `forceFrameRate` (lines 478, 481).

The comment (lines 440–443):

> Scheduler periodically yields in case there is other work on the main
> thread, like user events. By default, it yields multiple times per frame.
> It does not attempt to align with frame boundaries, since most tasks don't
> need to be frame aligned; for those that do, use requestAnimationFrame.

The value is a **slice length**, not a cadence. Frames are ~16.67 ms at
60 Hz, so a 5 ms slice leaves room for 2–3 slices per frame with input /
layout / paint in between.

### 8.3 `startTime` — the per-slice anchor

Declared line 445 (`let startTime = -1;`). **Not to be confused with
`Task.startTime`**. Written exactly once per host-pump tick at line 493:

```js
startTime = currentTime;
```

This is "when did the current browser task begin draining work?". Read by
`shouldYieldToHost` at line 452. Every fresh `performWorkUntilDeadline`
re-samples it, so each slice starts with a full `frameInterval` budget.

### 8.4 `needsPaint`

Declared line 94 (`var needsPaint = false;`).

| Location | Action |
|---|---|
| line 94 | init `false` |
| line 464 (`requestPaint`) | set `true` (only if `enableRequestPaint`) |
| line 448 (`shouldYieldToHost`) | read — force yield if `true` |
| line 487 (`performWorkUntilDeadline`) | cleared at top of each slice |

The clear happens at the **start** of the slice *after* yielding, which
guarantees that at least one browser frame boundary was crossed between
"paint requested" and "paint cleared".

### 8.5 The 5 ms rationale

Why not `requestIdleCallback` (rIC): fires only when the browser is truly
idle; wrong for user-blocking updates; unpredictable cadence; aggressively
throttled in background tabs.

Why not `requestAnimationFrame` (rAF): tied to frame boundaries; wastes up
to ~16 ms waiting; paused in background tabs; cannot express "yield multiple
times per frame".

Why 5 ms: three slices per 60 Hz frame; amortizes scheduling overhead;
keeps input latency under one frame even when React is mid-render.

### 8.6 Features that no longer exist

A grep confirms the current scheduler has **no**:
- `continuousYieldTime`
- `maxYieldInterval`
- `enableIsInputPending`
- `navigator.scheduling.isInputPending` calls

Older versions used Chromium's experimental `isInputPending()` API with a
`maxYieldInterval` hard ceiling. That entire integration is gone. The only
trigger for yielding is `(timeElapsed >= frameInterval) || needsPaint`.

---

## 9. Host pump

### 9.1 Why the three-tier hierarchy

The scheduler needs a primitive that runs on the **next macrotask** with
minimal delay. Candidates:

| Primitive | Pros | Cons |
|---|---|---|
| `scheduler.postTask` | Native, priority-aware | Not universally shipped |
| Microtasks | Zero delay | Run *before* paint/input — blocks browser |
| `setTimeout(fn, 0)` | Universal | 4 ms clamp after 5 nestings, heavy background throttling |
| `MessageChannel` | No clamp, fast | Keeps Node process alive, throttled in bg tabs |
| `setImmediate` | Fast, doesn't block Node exit, fires earlier | Only in Node and legacy IE |
| `requestAnimationFrame` | Frame-aligned | Wastes up to 16 ms, paused in bg tabs |
| `requestIdleCallback` | True idle | Unpredictable, wrong priority semantics |

React picks the best available per environment via the selector at lines
516–547, falling through this hierarchy:

1. `localSetImmediate` — Node.js and legacy IE
2. `MessageChannel` — DOM and Workers
3. `setTimeout(fn, 0)` — fallback for exotic non-browser hosts

The choice is made once at module init and frozen.

### 9.2 `schedulePerformWorkUntilDeadline` — lines 516–547

```js
let schedulePerformWorkUntilDeadline;
if (typeof localSetImmediate === 'function') {
  // Node.js and old IE.
  // There's a few reasons for why we prefer setImmediate.
  //
  // Unlike MessageChannel, it doesn't prevent a Node.js process from exiting.
  // (Even though this is a DOM fork of the Scheduler, you could get here
  // with a mix of Node.js 15+, which has a MessageChannel, and jsdom.)
  // https://github.com/facebook/react/issues/20756
  //
  // But also, it runs earlier which is the semantic we want.
  // If other browsers ever implement it, it's better to use it.
  // Although both of these would be inferior to native scheduling.
  schedulePerformWorkUntilDeadline = () => {
    localSetImmediate(performWorkUntilDeadline);
  };
} else if (typeof MessageChannel !== 'undefined') {
  // DOM and Worker environments.
  // We prefer MessageChannel because of the 4ms setTimeout clamping.
  const channel = new MessageChannel();
  const port = channel.port2;
  channel.port1.onmessage = performWorkUntilDeadline;
  schedulePerformWorkUntilDeadline = () => {
    port.postMessage(null);
  };
} else {
  // We should only fallback here in non-browser environments.
  schedulePerformWorkUntilDeadline = () => {
    localSetTimeout(performWorkUntilDeadline, 0);
  };
}
```

#### Tier 1: `setImmediate` (Node / jsdom / legacy IE)

Chosen **first** even when `MessageChannel` is available (Node 15+ has
both). Reasons:

1. **Doesn't keep Node process alive.** A `MessageChannel` port keeps the
   event loop alive; a short-lived Node process using React (SSR, CLI,
   Jest) would hang waiting for a phantom event. Issue: facebook/react#20756.
2. **Runs earlier** in Node's event loop phases (before `setTimeout(fn, 0)`).
3. **Node+jsdom interop** — jsdom tests exposing `MessageChannel` still
   pick `setImmediate`.

Caveat from the code comment: "both of these would be inferior to native
scheduling." A real `scheduler.postTask()` would be the ideal.

#### Tier 2: `MessageChannel` (browsers, Workers)

Setup happens **once** at module init:

```js
const channel = new MessageChannel();
const port = channel.port2;
channel.port1.onmessage = performWorkUntilDeadline;
```

- Single `MessageChannel` instance for the lifetime of the app.
- `port1` is the listener (`.onmessage = performWorkUntilDeadline`).
- `port2` is the sender; `port.postMessage(null)` fires a `message` event
  on `port1` as a macrotask.
- Payload is `null` because the event itself is all that matters.

Why `MessageChannel` over `setTimeout(fn, 0)`: HTML spec clamping.
> If nesting level is greater than 5, and timeout is less than 4, then set
> timeout to 4.

Nested `setTimeout(fn, 0)` calls get clamped to 4 ms minimum after the 5th
level, adding ~4 ms of dead time per tick. `MessageChannel` has no such
clamping.

Downsides of `MessageChannel`:
- Background-tab throttling (intensive wake-up throttling ~1/min after
  prolonged hide).
- No inherent priority.
- Not zero-cost — `postMessage` involves structured cloning even of `null`.
- Keeps Node process alive (why Node uses `setImmediate` instead).

#### Tier 3: `setTimeout(fn, 0)` — fallback

```js
schedulePerformWorkUntilDeadline = () => {
  localSetTimeout(performWorkUntilDeadline, 0);
};
```

Used only in exotic non-browser, non-Node environments. Pays the full 4 ms
clamp tax and heavy background throttling. The comment says: "We should
only fallback here in non-browser environments."

### 9.3 `performWorkUntilDeadline` — lines 485–514

Already covered in §7.4. Key points relevant to the pump:

- `startTime = currentTime;` line 493 resets the per-slice anchor.
- `needsPaint = false;` line 487 clears the paint flag at slice start.
- The `try/finally` pattern (no `catch`) lets errors propagate while still
  rescheduling via the initial `hasMoreWork = true`.

### 9.4 `requestHostCallback` — lines 549–554

```js
function requestHostCallback() {
  if (!isMessageLoopRunning) {
    isMessageLoopRunning = true;
    schedulePerformWorkUntilDeadline();
  }
}
```

- Idempotent: the `!isMessageLoopRunning` guard means multiple calls
  collapse into one pump.
- Called from `unstable_scheduleCallback` (line 411) and `handleTimeout`
  (line 134).
- There is **no `cancelHostCallback`**. Once a message is posted, it will
  fire; the "cancel" is effectively flipping `isMessageLoopRunning = false`
  so the pump observes it and bails on line 489.

### 9.5 `requestHostTimeout` / `cancelHostTimeout` — lines 556–570

```js
function requestHostTimeout(
  callback: (currentTime: number) => void,
  ms: number,
) {
  taskTimeoutID = localSetTimeout(() => {
    callback(getCurrentTime());
  }, ms);
}

function cancelHostTimeout() {
  localClearTimeout(taskTimeoutID);
  taskTimeoutID = ((-1: any): TimeoutID);
}
```

- Uses real `setTimeout` (not `MessageChannel`) because the semantics are
  "wait N ms, then fire" — delay is intentional, clamping is irrelevant.
- Single-slot design: `taskTimeoutID` holds at most one handle at a time.
  Earlier-delayed tasks cause the existing timeout to be cancelled and
  re-armed (see `unstable_scheduleCallback` lines 391–398).
- The wrapper closure reads `getCurrentTime()` at fire time (not schedule
  time) so `handleTimeout` gets accurate `currentTime`.

### 9.6 Background tab behavior

| Primitive | Background behavior |
|---|---|
| `setImmediate` | Node only, N/A for browser tabs |
| `MessageChannel` | Throttled (~1/min after prolonged hide), continues |
| `setTimeout(fn, 0)` | Heavily throttled (1 s minimum), continues |
| `requestAnimationFrame` | Paused entirely (0 fps) |
| `requestIdleCallback` | Further deferred |

The scheduler via `MessageChannel` *continues running* in background tabs,
just slowly. This is usually fine because visible rendering isn't
happening anyway.

---

## 10. Continuation pattern

### 10.1 The protocol

> A scheduled callback is invoked with a boolean `didTimeout`. If it is
> not yet done, it returns a **function** (the continuation). The scheduler
> stores that function back on the same heap entry and yields. The next
> macrotask slice peeks the same task and runs the continuation. If the
> callback is done, it returns `null` (or anything non-function) and the
> task is popped.

No generators, no promises, no coroutines, no saved stacks. Just
`(fn) => fn ? callMeAgain : iAmDone`. All per-pause state lives in the
**reconciler's module-level globals**, not in the Scheduler's `Task`.

### 10.2 Scheduler side — the five moves (lines 200–234)

```js
const callback = currentTask.callback;
if (typeof callback === 'function') {
  currentTask.callback = null;                                 // (B)
  currentPriorityLevel = currentTask.priorityLevel;
  const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
  ...
  const continuationCallback = callback(didUserCallbackTimeout); // (C)
  currentTime = getCurrentTime();                                // (D)
  if (typeof continuationCallback === 'function') {
    currentTask.callback = continuationCallback;                 // (E)
    ...
    advanceTimers(currentTime);                                  // (F)
    return true;                                                 // (G)
  } else {
    ...
    if (currentTask === peek(taskQueue)) {
      pop(taskQueue);                                            // (H)
    }
    advanceTimers(currentTime);
  }
} else {
  pop(taskQueue);                                                // (I)
}
```

- **(B) Pre-invocation tombstone.** `currentTask.callback = null` runs
  **before** `callback(...)`. If the callback throws, the task is already
  a tombstone — the next peek pops it. This prevents infinite re-throwing.
- **(C) Synchronous invocation.** User callback runs inline, on the
  scheduler's stack. No microtask trampoline. No try/catch.
- **(D) Post-callback clock refresh.** `currentTime = getCurrentTime();`.
  The callback's duration is unbounded (5 ms typical, 500 ms pathological).
  Without this re-read, `advanceTimers(currentTime)` at line 223 would use
  a stale clock and fail to promote timers that fired during the callback.
- **(E) In-place callback replacement.** `currentTask.callback = continuationCallback;`
  — the *same* `Task` object is mutated. Its `sortIndex`, `expirationTime`,
  and `id` are unchanged; its **physical position in the heap is unchanged**.
  No `siftUp`/`siftDown` needed.
- **(F) `advanceTimers(currentTime)` before yielding.** Promotes timers
  that fired during the long callback so they're considered on the next
  slice.
- **(G) Early `return true`.** The only "yield with more work" return.
  Note the comment at lines 215–216: "If a continuation is returned,
  immediately yield to the main thread regardless of how much time is left
  in the current time slice." Continuation yields do **not** consult
  `shouldYieldToHost` — the callback is trusted when it says "I'm done for
  now, call me back."
- **(H) Defensive completion pop.** The guard
  `currentTask === peek(taskQueue)` exists because the user callback can
  schedule or cancel tasks; the previously-peeked reference may no longer
  be the root.
- **(I) Tombstone cleanup.** If `callback` is not a function on entry (i.e.
  cancelled), pop unconditionally.

### 10.3 Key invariant: heap entry is not re-inserted

1. `sortIndex` is not mutated when a continuation is stored, so the heap
   invariant is preserved automatically.
2. Any external code holding a reference to this `Task` (e.g. React's
   `root.callbackNode`) continues to point at the same allocation.
   Load-bearing for `performWorkOnRootViaSchedulerTask`'s
   `root.callbackNode === originalCallbackNode` check at
   `ReactFiberRootScheduler.js:600`.

### 10.4 Reconciler side — `performWorkOnRootViaSchedulerTask`

`ReactFiberRootScheduler.js:513-606`. Signature matches `Callback = boolean => ?Callback`:

```js
type RenderTaskFn = (didTimeout: boolean) => RenderTaskFn | null;

function performWorkOnRootViaSchedulerTask(
  root: FiberRoot,
  didTimeout: boolean,
): RenderTaskFn | null {
  ...
  if (hasPendingCommitEffects()) {
    root.callbackNode = null;
    root.callbackPriority = NoLane;
    return null;                                    // bail: commit pending
  }

  const originalCallbackNode = root.callbackNode;
  const didFlushPassiveEffects = flushPendingEffectsDelayed();
  if (didFlushPassiveEffects) {
    if (root.callbackNode !== originalCallbackNode) {
      return null;                                  // stale
    }
  }

  ...
  const lanes = getNextLanes(root, ...);
  if (lanes === NoLanes) {
    return null;                                    // nothing to do
  }

  const forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout;
  performWorkOnRoot(root, lanes, forceSync);        // runs the render slice

  scheduleTaskForRootDuringMicrotask(root, now());
  if (root.callbackNode != null && root.callbackNode === originalCallbackNode) {
    // The task node scheduled for this root is the same one that's
    // currently executed. Need to return a continuation.
    return performWorkOnRootViaSchedulerTask.bind(null, root);
  }
  return null;
}
```

- **`originalCallbackNode = root.callbackNode`** — capture the Scheduler
  `Task` handle so we can detect if it changes underneath us.
- **`forceSync = didTimeout`** — if Scheduler said the task expired,
  disable time-slicing for the rest of the render (finish sync).
- **`performWorkOnRoot`** — runs `renderRootConcurrent` →
  `workLoopConcurrentByScheduler`:

  ```js
  // ReactFiberWorkLoop.js:3051-3057
  function workLoopConcurrentByScheduler() {
    while (workInProgress !== null && !shouldYield()) {
      performUnitOfWork(workInProgress);
    }
  }
  ```

  `shouldYield()` is `shouldYieldToHost` from the Scheduler. When it returns
  `true`, the loop exits with `workInProgress !== null`, meaning there are
  more fibers to process. `renderRootConcurrent` returns `RootInProgress`
  (line 3014) and `performWorkOnRoot` breaks out.
- **`scheduleTaskForRootDuringMicrotask`** — reconciles `root.callbackNode`
  with the latest priority. Either leaves the same task in place or cancels
  and reassigns.
- **The identity check** — if `root.callbackNode === originalCallbackNode`
  still holds, return a fresh bound `performWorkOnRootViaSchedulerTask`.
  Scheduler stores that at line 218. Otherwise return `null`, Scheduler
  pops the now-stale task at line 233.

### 10.5 Where per-pause state actually lives

The Scheduler's entire memory of an in-progress render is literally:

```js
task.callback = performWorkOnRootViaSchedulerTask.bind(null, root)
```

Everything else lives in **reconciler globals** in `ReactFiberWorkLoop.js`:

- `workInProgress` — next fiber to process
- `workInProgressRoot` — root currently being rendered
- `workInProgressRootRenderLanes` — which lanes
- `workInProgressSuspendedReason`, `workInProgressThrownValue`
- The partial fiber tree under `root.current.alternate`

When the continuation is invoked on the next slice, `renderRootConcurrent`
at line 2787 says:

> // This is a continuation of an existing work-in-progress.

If the globals still match, skip `prepareFreshStack` and resume from where
`workInProgress` was left. If they don't match, rebuild via
`prepareFreshStack` (the "restart", §12).

### 10.6 Path I (continuation) vs Path II (deadline break)

Both yield, both cause `flushWork` to return `true`, both trigger another
`MessageChannel` post. But they're structurally different:

| | Path I: continuation | Path II: deadline break |
|---|---|---|
| Exits `workLoop` via | `return true` (line 224) | `break` (line 196) then `return true` (line 250) |
| Did the callback run this slice? | Yes, exactly once | No |
| `currentTask.callback` | Replaced with continuation | Unchanged |
| `advanceTimers(currentTime)` before exit? | Yes (line 223) | No (implicit on next entry) |
| `markTaskYield` profile? | Yes (line 221) | No |
| Semantics | "Pause in the middle of a task" | "Pause between tasks" |
| Where is partial state? | Reconciler module globals | Nowhere — nothing is partial |

### 10.7 Why this design is good

- **Zero serialization.** No generator frames, no `.next(value)`, no
  suspendable stacks. One in-place function replacement.
- **Zero coupling.** Scheduler has no idea what a fiber is. Same module
  works for React DOM, React Native, React Test Renderer, etc.
- **Trivial cancellation.** `unstable_cancelCallback(task)` just sets
  `task.callback = null`. Next peek pops. No partial state to clean up
  because Scheduler holds none.
- **Identity stability.** `root.callbackNode === originalCallbackNode`
  works because the `Task` object reference is stable across all slices
  of the same logical render.
- **Priority changes are a free restart.** If priority changed mid-render,
  the reconciler cancels the old task, schedules a new one, returns `null`;
  old task is popped, new task runs next, `prepareFreshStack` rebuilds.

---

## 11. Cancellation

### 11.1 `unstable_cancelCallback` — lines 418–431

```js
function unstable_cancelCallback(task: Task) {
  if (enableProfiling) {
    if (task.isQueued) {
      const currentTime = getCurrentTime();
      markTaskCanceled(task, currentTime);
      task.isQueued = false;
    }
  }

  // Null out the callback to indicate the task has been canceled. (Can't
  // remove from the queue because you can't remove arbitrary nodes from an
  // array based heap, only the first one.)
  task.callback = null;
}
```

The comment is the whole story: **the heap only supports removing the
root**. `SchedulerMinHeap` has no `removeAt(i)` because arbitrary-node
removal would require knowing the node's index and re-heapifying — O(n)
to find + O(log n) to fix per cancel, which is intolerable when the
reconciler cancels and re-schedules on every click.

So cancellation is a **tombstone**: `task.callback = null` is the entire
operation. Profiling side marks the task as cancelled if still queued.

### 11.2 Where tombstones are swept

**`advanceTimers`** (line 107–109): for cancelled delayed tasks.

```js
if (timer.callback === null) {
  pop(timerQueue);
}
```

**`workLoop` — live branch completion guard** (lines 232–234): if the user
callback scheduled a more urgent task making `currentTask` no longer the
root, the completed task is left with `callback = null` (set at line 203)
and becomes a tombstone that will be popped later.

**`workLoop` — cancelled branch** (lines 237–238):

```js
} else {
  pop(taskQueue);
}
```

When `callback === null` on entry (either cancelled externally or left by
the above completion path), the task is at the root (by the heap
invariant) and is popped unconditionally.

### 11.3 Why the tombstone approach is correct

1. **Heap invariant preserved.** `callback = null` doesn't touch
   `sortIndex` or `id`.
2. **Tombstones can only starve the root.** A cancelled node at the root
   is dropped immediately; deeper tombstones wait until they bubble up.
3. **O(1) cancellation.** Cost is amortized into the next consumer.
4. **Memory pressure tradeoff.** Pathological "schedule then cancel
   without draining" could grow either heap unbounded. Not an issue in
   practice because normal operation drains the heap.
5. **You cannot un-cancel.** The callback reference is gone; caller must
   schedule a new one.

### 11.4 Cancellation from the reconciler

The reconciler holds `root.callbackNode` (the `Task` handle) so it can
cancel the stale render task when priorities change:

```js
// ReactFiberRootScheduler.js
if (newCallbackPriority === existingCallbackPriority && ...) {
  return;                                   // reuse existing
} else {
  cancelCallback(existingCallbackNode);     // tombstone the old task
}
// ...
const newCallbackNode = scheduleCallback(schedulerPriorityLevel, ...);
root.callbackPriority = newCallbackPriority;
root.callbackNode = newCallbackNode;
```

Cancel call sites in `ReactFiberRootScheduler.js`:
- line 434: root has no more work
- line 452: sync work path (no scheduler task needed)
- line 477: priority change — cancel old, schedule new

The old task stays in the heap until it floats to the root, at which point
`workLoop`'s else branch pops it harmlessly.

### 11.5 There is no `cancelHostCallback`

The scheduler has `cancelHostTimeout` (lines 566–570) but no
`cancelHostCallback`. Once a `MessageChannel` message is posted, there is
no way to un-post it. The design instead:

- Lets the message arrive.
- `performWorkUntilDeadline` re-reads `isMessageLoopRunning` on entry.
- `flushWork` can return `false` if there's nothing to do.

The effective "cancel" is flipping `isMessageLoopRunning = false` and
letting the queued message become a no-op.

---

## 12. Preemption

### 12.1 The thesis

React's scheduler does **not** preempt. JavaScript is single-threaded; once
a callback is running, it runs to completion. What's called "preemption"
is a tight **cooperative yield loop + heap re-root**:

1. A long render periodically asks `shouldYield()`.
2. When it yields, it returns a continuation and unwinds.
3. Between slices, a higher-priority task may be pushed onto the heap.
4. Because the heap is a min-heap on `sortIndex = expirationTime`, the
   new task becomes the new root.
5. Next `performWorkUntilDeadline` calls `peek(taskQueue)` and picks it —
   not the old continuation.
6. The old transition task sits in the heap with its stashed continuation.
   It runs later, after the urgent task drains.

**Preemption is a heap re-root between macrotasks, not during one.**

### 12.2 Why true preemption is impossible

Every scheduler task runs as the callback of a single MessageChannel
message. While that JS is executing:
- The event loop cannot dispatch any other task.
- No other `postMessage`, `setTimeout`, click handler, or microtask runs.
- The scheduler itself can't "notice" a new higher-priority task because
  the code doing the noticing is not running.

### 12.3 Cooperative yield — Scheduler + reconciler share a clock

`shouldYieldToHost` is the single source of truth, polled from two places:

1. Inside `workLoop` at line 194 (before calling a task).
2. Inside `workLoopConcurrentByScheduler` in the reconciler
   (`ReactFiberWorkLoop.js:3051`) on every fiber.

When the reconciler's loop sees `shouldYield() === true`, it exits the
inner while with `workInProgress !== null`, `renderRootConcurrent` returns
`RootInProgress`, `performWorkOnRoot` returns early,
`performWorkOnRootViaSchedulerTask` returns a continuation, `workLoop`
stores it and yields. That gap is the preemption window.

### 12.4 Where the re-root actually happens

`performWorkUntilDeadline` (lines 485–514). When `flushWork` returns `true`
(yielded), the function posts a fresh message via
`schedulePerformWorkUntilDeadline`. That message goes to the back of the
browser's task queue. Before it's dispatched, the browser can process:

1. Native input events that arrived while we were running.
2. Paint.
3. Microtasks.
4. Other timers.

If an input handler calls `scheduleCallback(UserBlocking, …)`, a new task
is pushed into `taskQueue` with a smaller `expirationTime` (≈ 250 ms)
than the existing transition's (≈ 5000 ms). `siftUp` inside
`SchedulerMinHeap.push` lifts it to the root. When
`performWorkUntilDeadline` fires again, `peek(taskQueue)` returns the
new task.

### 12.5 Reconciler-level "restart" — prepareFreshStack

When a urgent update lands on a root that's mid-transition, the transition's
partial WIP fiber tree is thrown away and rebuilt from the committed tree.
This happens in `renderRootConcurrent` at line 2785:

```js
if (workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes) {
  ...
  prepareFreshStack(root, lanes);
} else {
  // This is a continuation of an existing work-in-progress.
  workInProgressRootIsPrerendering = checkIfRootIsPrerendering(root, lanes);
}
```

This works because **render is side-effect-free** (no DOM mutation, no
ref attachment, no effects). Render and commit are separate phases.
Commit (in `commitRoot`) is synchronous, single-slice, and non-yielding.
The time-slicing and preemption machinery only applies to the render
phase.

### 12.6 Two distinct concepts

| Level | Trigger | Mechanism | State preserved? |
|---|---|---|---|
| Scheduler yield | `shouldYield()` true | Return continuation, post new message | Yes, WIP tree + module vars |
| Heap re-root | Higher-prio task pushed | `peek` finds different root | Yes, old task still in heap |
| Lazy cancel | `cancelCallback(task)` | `task.callback = null` until popped | N/A (dead) |
| Reconciler restart | `prepareFreshStack(root, lanes)` | New WIP fiber from `root.current` | No, WIP tree discarded |
| Starvation escape | Expiration time reached | Scheduler won't yield; reconciler goes sync | Yes, finishes uninterrupted |

What people call "preemption" is assembled from these five pieces.

### 12.7 Lane → Event → Scheduler priority mapping

Three priority systems layered:

```
Lane (bit in bitfield)
  → EventPriority (coarser bucket; also a Lane, one of four)
    → SchedulerPriority (1..5 from SchedulerPriorities.js)
```

`ReactEventPriorities.js:55` defines the event priorities:

```js
export const DiscreteEventPriority: EventPriority = SyncLane;
export const ContinuousEventPriority: EventPriority = InputContinuousLane;
export const DefaultEventPriority: EventPriority = DefaultLane;
export const IdleEventPriority: EventPriority = IdleLane;
```

`ReactFiberRootScheduler.js:481` maps to Scheduler priority:

```js
switch (lanesToEventPriority(nextLanes)) {
  case DiscreteEventPriority:
  case ContinuousEventPriority:
    schedulerPriorityLevel = UserBlockingSchedulerPriority; break;
  case DefaultEventPriority:
    schedulerPriorityLevel = NormalSchedulerPriority; break;
  case IdleEventPriority:
    schedulerPriorityLevel = IdleSchedulerPriority; break;
  default:
    schedulerPriorityLevel = NormalSchedulerPriority; break;
}
```

A click at `DiscreteEventPriority` / `SyncLane` ends up as
`UserBlockingSchedulerPriority` (250 ms timeout), which beats a transition
at `NormalSchedulerPriority` (5000 ms).

Note: `SyncLane` work is flushed inline via microtask
(`ReactFiberRootScheduler.js:442-456`) and never goes through the scheduler
heap. So `ImmediatePriority` is effectively unreachable from the reconciler
in concurrent mode; the highest priority it ever requests is `UserBlocking`.

### 12.8 `enableAlwaysYieldScheduler` — experimental opposite

Gated on `__EXPERIMENTAL__` (`SchedulerFeatureFlags.js:18`). Flips yielding
upside down:

- **Top of loop** (lines 193–198) — skipped entirely.
- **Bottom of loop** (lines 241–246) — added:
  ```js
  if (enableAlwaysYieldScheduler) {
    if (currentTask === null || currentTask.expirationTime > currentTime) {
      break;
    }
  }
  ```

Semantics: "run exactly one task that is either the first one or a
successor that has already expired, then yield unconditionally". The
`frameInterval` budget check is removed; yielding is now per-task instead
of per-5ms. `needsPaint` check at line 448 is also short-circuited in this
mode.

Rationale: on devices with native frame-aligned scheduling (e.g.
`postTask`), the heuristic is redundant; always-yielding gives the host
finer-grained paint/input interleaving. Cost is task-switching overhead.

---

## 13. Starvation prevention

### 13.1 Scheduler-level — expired tasks bypass yield

The yield check in `workLoop` is:

```js
if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
  break;
}
```

**AND** — yield only if both "task hasn't expired" AND "host wants yield".
If the task has expired (`expirationTime <= currentTime`), the first
conjunct is false; the loop does not break regardless of
`shouldYieldToHost`. Expired tasks get forced through.

Combined with the timeout table:

| Priority | Becomes "non-yieldable" after |
|---|---|
| Immediate | Instantly (timeout = -1) |
| UserBlocking | 250 ms |
| Normal | 5000 ms |
| Low | 10000 ms |
| Idle | ~12.43 days (effectively never) |

A `LowPriority` task scheduled 10 seconds ago will have
`expirationTime <= currentTime`, and once it reaches the root, it runs
to at least one completion step even under continuous high-priority
pressure.

### 13.2 The `didTimeout` signal

The callback is told whether it's been starved:

```js
const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
...
const continuationCallback = callback(didUserCallbackTimeout);
```

For `ImmediatePriority` (timeout `-1`), `didUserCallbackTimeout` is true
on the very first call. React's `performWorkOnRootViaSchedulerTask` uses
`didTimeout` to set `forceSync = true`, switching the reconciler from
time-sliced to synchronous rendering.

### 13.3 Reconciler-level — `markStarvedLanesAsExpired` + `includesExpiredLane`

`ReactFiberLane.js:541` — `markStarvedLanesAsExpired(root, currentTime)`
walks `root.pendingLanes` and flags lanes whose expiration timestamp has
passed into `root.expiredLanes`. Called at the top of
`scheduleTaskForRootDuringMicrotask` (`ReactFiberRootScheduler.js:397`).

`ReactFiberWorkLoop.js:1153`:

```js
const shouldTimeSlice =
  (!forceSync &&
    !includesBlockingLane(lanes) &&
    !includesExpiredLane(root, lanes)) ||
  checkIfRootIsPrerendering(root, lanes);
```

If any expired lane is in play, `shouldTimeSlice` is `false` and
`performWorkOnRoot` calls `renderRootSync` (line 1166), which uses
`workLoopSync` — no `shouldYield()` check, runs to completion in one slice.

The two guards compose: reconciler bypasses its own yield loop, AND the
scheduler won't yield because the task's `expirationTime` has already
passed.

---

## 14. Error handling

### 14.1 The scheduler never swallows errors

Three layers, none silent.

#### Layer 1: `workLoop`

No `try/catch` around `callback()` at line 212. Exception propagates
straight out.

#### Layer 2: `flushWork`

- **Profiling path** (lines 160–172): inner `try/catch` wraps `workLoop`
  only to run `markTaskErrored(currentTask, currentTime)` and **re-throw**.
  It's an error tap, not a handler.
- **Production path** (lines 173–176): bare `return workLoop(initialTime);`
  with no catch. Comment: `// No catch in prod code path.`
- The outer `try/finally` at lines 159–185 unconditionally restores
  `currentTask = null`, `currentPriorityLevel = previousPriorityLevel`,
  `isPerformingWork = false`.

Two layers of `try` in the profiling path: outer `try/finally` for state
restoration; inner `try/catch` for error instrumentation that must run
while `currentTask` is still set.

#### Layer 3: `performWorkUntilDeadline`

```js
let hasMoreWork = true;
try {
  hasMoreWork = flushWork(currentTime);
} finally {
  if (hasMoreWork) {
    schedulePerformWorkUntilDeadline();
  } else {
    isMessageLoopRunning = false;
  }
}
```

No `catch`. Comment (lines 495–500):

> // If a scheduler task throws, exit the current browser task so the
> // error can be observed.
> //
> // Intentionally not using a try-catch, since that makes some debugging
> // techniques harder. Instead, if `flushWork` errors, then `hasMoreWork` will
> // remain true, and we'll continue the work loop.

### 14.2 Self-healing via `hasMoreWork` initialization

`let hasMoreWork = true;` is initialized **before** the `try`. If
`flushWork` throws, the assignment on line 503 never happens → `hasMoreWork`
stays `true` → `finally` re-schedules the pump. The thrown error
propagates out of the macrotask into the browser's top-level error handler
(where DevTools and `window.onerror` can observe it), while the scheduler
automatically retries on the next slice.

### 14.3 Tombstone prevents re-throw loops

Because `currentTask.callback = null` runs at line 203 **before** line 212
invokes the callback, a throwing task is already a tombstone by the time
the exception propagates. On the next slice, `peek(taskQueue)` returns
the same task, but `callback === null` takes the cancelled branch at
lines 237–238 and pops it. So a throwing task is popped and the scheduler
moves on — no infinite re-invocation.

### 14.4 Reconciler-level handling

React wraps most errors via `handleThrow` inside `renderRootConcurrent`'s
try/catch at line 2998. Ordinary component errors are caught inside
`renderRootConcurrent`, re-thrown into the error-boundary logic, and never
escape to `workLoop`. The Layer 1-3 chain above is only reached for
genuinely catastrophic errors (OOM, errors inside `handleThrow` itself).

---

## 15. Reconciler integration

### 15.1 Wrapper: `react-reconciler/src/Scheduler.js`

A thin re-export layer that aliases scheduler exports (e.g.
`NormalSchedulerPriority`, `requestPaint`, `shouldYield`, `now`). This is
the reconciler's single import surface for Scheduler.

### 15.2 `scheduleCallback` call sites

| File | Line | Priority | Trigger |
|---|---|---|---|
| `ReactFiberRootScheduler.js` | 487 | `UserBlockingSchedulerPriority` | Discrete/continuous input events |
| `ReactFiberRootScheduler.js` | 490 | `NormalSchedulerPriority` | `DefaultEventPriority` — standard render |
| `ReactFiberRootScheduler.js` | 493 | `IdleSchedulerPriority` | `IdleEventPriority` — idle-lane work |
| `ReactFiberRootScheduler.js` | 496 | `NormalSchedulerPriority` | Default fallback |
| `ReactFiberRootScheduler.js` | 500–503 | (chosen above) | Main `scheduleCallback(priority, performWorkOnRootViaSchedulerTask)` |
| `ReactFiberRootScheduler.js` | 680–683 | `ImmediateSchedulerPriority` | Safari workaround (microtask in Render/Commit) |
| `ReactFiberRootScheduler.js` | 690–693 | `ImmediateSchedulerPriority` | Fallback when `supportsMicrotasks` false |
| `ReactFiberWorkLoop.js` | 3784 | `NormalSchedulerPriority` | `flushPassiveEffects` (legacy) |
| `ReactFiberWorkLoop.js` | 4401 | `IdleSchedulerPriority` | `schedulePostPaintCallback` — transition callbacks |
| `ReactFiberWorkLoop.js` | 4808 | `IdleSchedulerPriority` | Second copy of transition callbacks |
| `ReactFiberCacheComponent.js` | 114 | `NormalPriority` | `cache.controller.abort()` on refCount=0 |

The main production path is `ReactFiberRootScheduler.js:500–503`:

```js
const newCallbackNode = scheduleCallback(
  schedulerPriorityLevel,
  performWorkOnRootViaSchedulerTask.bind(null, root),
);
```

The returned `Task` is stored on `root.callbackNode` for later cancellation
and identity checks.

### 15.3 `performWorkOnRootViaSchedulerTask`

`ReactFiberRootScheduler.js:513`. See §10.4 for the full body.

Signature: `(root: FiberRoot, didTimeout: boolean) => RenderTaskFn | null`.

Returns either:
- A fresh bound `performWorkOnRootViaSchedulerTask` (continuation) if the
  root's callback node is still the original task.
- `null` if the work is done, the task is stale, or a different task is
  now scheduled for the root.

The body sequence:
1. Early exit on `hasPendingCommitEffects()`.
2. Capture `originalCallbackNode = root.callbackNode`.
3. `flushPendingEffectsDelayed()` — if the task became stale during passive
   effects, return `null`.
4. Compute `lanes`; bail if `NoLanes`.
5. Compute `forceSync = didTimeout`.
6. `performWorkOnRoot(root, lanes, forceSync)` — the actual render slice.
7. `scheduleTaskForRootDuringMicrotask(root, now())` — reconcile priorities.
8. Identity check: same task? → return continuation. Different? → return
   `null`.

### 15.4 `workLoopConcurrentByScheduler`

`ReactFiberWorkLoop.js:3051-3057`:

```js
function workLoopConcurrentByScheduler() {
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}
```

This is the fiber-level equivalent of Scheduler's `workLoop`. Each iteration
processes one fiber. `shouldYield()` imports `shouldYieldToHost` from
Scheduler — the same clock both sides use.

The alternative `workLoopConcurrent` (line 3034) exists under
`enableThrottledScheduling` with a 25 ms slice for non-idle transitions and
5 ms for idle — intentional throttling so 60 fps animations aren't starved.

### 15.5 Identity preservation via `root.callbackNode`

`root.callbackNode` is the Scheduler `Task` opaque handle. Because
continuations mutate the existing `Task` in place rather than pushing a
new one, the reference is stable across all slices of the same logical
render.

- At schedule time: `root.callbackNode = newCallbackNode;`
- Inside a slice: `currentTask === root.callbackNode` is true while the
  slice is running.
- The identity check at line 600:
  `root.callbackNode != null && root.callbackNode === originalCallbackNode`
  tells `performWorkOnRootViaSchedulerTask` whether the currently-executing
  task is still "the right task" for this root's current priority.

### 15.6 Sync work bypasses the scheduler

`ReactFiberRootScheduler.js:482–484`:

> "Scheduler does have an 'ImmediatePriority', but now that we use
> microtasks for sync work we no longer use that."

Sync work goes through `performSyncWorkOnRoot` directly via microtask
(`queueMicrotask`) without touching the scheduler heap. The only remaining
uses of `ImmediateSchedulerPriority` are the two non-microtask Safari
fallbacks.

---

## 16. Non-obvious details and gotchas

1. **`maxSigned31BitInt = 1073741823 = 2^30 - 1`, not `2^31 - 1`**.
   The "31 bit" name refers to V8's SMI tagging on 32-bit systems. Idle
   timeout is ~12.43 days, not ~24.86 days.

2. **`{delay: 0}` is not a delay.** The strict `> 0` check falls through
   to `startTime = currentTime`.

3. **`NoPriority` is a sentinel**, not a valid argument. It falls through
   the switch to `NormalPriority`.

4. **`LowPriority` is dead in the production reconciler.** Defined,
   exported, has its own switch arm — but no production call site.

5. **`sortIndex` is the heap key, but its meaning changes per queue.**
   `startTime` in `timerQueue`, `expirationTime` in `taskQueue`. The
   rewrite happens in `advanceTimers` at line 113, **after** `pop`
   removes the task from the `timerQueue`.

6. **`currentTask` is a module-level variable, not a local.** Written at
   line 191 and 240. Reset to `null` only in `flushWork`'s `finally` at
   line 178.

7. **`currentTask.callback = null` at line 203 MUST run before the
   callback invocation at line 212.** If this order were reversed, a
   throwing task would be re-invoked infinitely across slices.

8. **Continuation yield bypasses `shouldYieldToHost` entirely.** Comment
   lines 215–216: "regardless of how much time is left in the current time
   slice." The callback is trusted when it says "I'm done for now."

9. **`currentTime = getCurrentTime()` at line 213 is crucial.** Without
   the refresh, the `advanceTimers(currentTime)` call at line 223 would
   use a stale clock and miss timers that fired during the callback.

10. **Continuation stores on the same `Task` object.** Heap position
    unchanged, no re-push. `siftUp`/`siftDown` not triggered. Reference
    identity of `root.callbackNode` is preserved across slices.

11. **Defensive completion pop guard at line 232.** `if (currentTask === peek(taskQueue))`
    exists because the user callback may have scheduled a more urgent task
    that's now the root. Leaving the old task with `callback = null`
    creates a tombstone that's popped later.

12. **`isHostTimeoutScheduled` is not set at line 138.** This is a minor
    inconsistency in `handleTimeout`'s re-arm path. Orphaned timeouts fire
    harmlessly because `handleTimeout` is idempotent.

13. **Cancellation is lazy — the task stays in the heap.** The comment at
    lines 427–429 says it outright: "Can't remove from the queue because
    you can't remove arbitrary nodes from an array based heap, only the
    first one."

14. **`performWorkUntilDeadline` initializes `hasMoreWork = true` BEFORE
    the `try`.** This is the self-healing trick: a thrown `flushWork`
    leaves `hasMoreWork` at its initial `true`, so the pump re-schedules.

15. **No `try/catch` around `callback()` at line 212.** Errors propagate
    out of `workLoop`, through `flushWork`, out of `performWorkUntilDeadline`,
    into the browser's top-level error handler. The scheduler
    self-restarts via `hasMoreWork`.

16. **`frameInterval` default (5 ms) is tighter than `forceFrameRate`'s
    ceiling (125 fps → 8 ms).** Because the default was set via feature
    flag, not via the API. `forceFrameRate` cannot make it tighter than
    8 ms.

17. **The 125 fps cap in `forceFrameRate`** — `Math.floor(1000/125) = 8`.
    Higher fps would round the interval to zero.

18. **`console['error']` bracket notation at line 471** — deliberate way
    to evade Babel / ESLint rewrites.

19. **Native reference capture uses `typeof X !== 'undefined'`, not
    `globalThis.X`.** Portable across all hosts, doesn't throw
    `ReferenceError` on missing globals, pins references before polyfills.

20. **`MessageChannel` is preferred over `setTimeout(fn, 0)`** because of
    the HTML spec 4 ms clamping after 5 levels of nesting. A rapid
    scheduling loop would take a ~4 ms dead tax per tick otherwise.

21. **`setImmediate` is preferred over `MessageChannel` in Node** because
    `MessageChannel` keeps the Node process alive (issue facebook/react#20756).
    It also fires earlier in Node's event loop phases.

22. **`startTime` (module-level) ≠ `Task.startTime`.** The module variable
    is the per-slice anchor set inside `performWorkUntilDeadline`; the
    Task field is the earliest time a delayed task is allowed to run.

23. **`currentPriorityLevel` leak between tasks within a single
    `workLoop`.** Line 205 sets it per-task, but the change is NOT unwound
    between tasks. A higher-priority task running before a lower-priority
    one could leak its priority through `unstable_getCurrentPriorityLevel`
    reads *between* iterations. `flushWork`'s `finally` at line 179 only
    restores at the end of the whole slice. In practice this is fine
    because tasks rarely query the priority outside their own callback.

24. **There is no `cancelHostCallback`.** Only `cancelHostTimeout`. Once
    a MessageChannel message is posted, it fires; the effective "cancel"
    is flipping `isMessageLoopRunning = false` so the pump bails on entry.

25. **`unstable_next` never promotes**, only demotes. Low/Idle priorities
    pass through; Immediate/UserBlocking/Normal all shift to Normal.

26. **`unstable_wrapCallback` captures priority at wrap time**, not at
    invocation time. Useful for "remember my priority for later async
    callbacks".

27. **`enableAlwaysYieldScheduler` has TWO code changes**: skip line 193
    top-of-loop check AND add bottom-of-loop check at line 241. Also
    short-circuits `needsPaint` at line 448.

28. **`performWorkOnRoot` uses `forceSync = didTimeout`** to switch from
    time-sliced to sync rendering when the scheduler reports the task
    expired. This is how starvation bypass works at the reconciler layer.

29. **`root.callbackNode` identity depends on the Scheduler's in-place
    mutation invariant.** If the Scheduler ever allocated a new task
    instead of mutating, React's identity check would break.

30. **The `needsPaint` flag crosses exactly one frame boundary.** It's
    set during a callback, read on the next yield check, cleared at the
    start of the slice *after* yielding. This guarantees at least one
    browser paint opportunity.

---

## 17. Quick-reference table: every function → line number

### Scheduler.js

| Function | Lines | Purpose |
|---|---|---|
| `getCurrentTime` (perf.now branch) | 66 | High-res clock |
| `getCurrentTime` (Date.now branch) | 70 | Fallback clock |
| `advanceTimers` | 103–125 | Promote fired timers to taskQueue |
| `handleTimeout` | 127–142 | Host timeout fires → promote + pump |
| `flushWork` | 144–186 | Top-level flush: guards + try/finally around workLoop |
| `workLoop` | 188–258 | Main execution loop |
| `unstable_runWithPriority` | 260–283 | Ambient priority save/swap/restore |
| `unstable_next` | 285–308 | Demote-only priority helper |
| `unstable_wrapCallback` | 310–325 | Closure that restores captured priority |
| `unstable_scheduleCallback` | 327–416 | Create and enqueue a Task |
| `unstable_cancelCallback` | 418–431 | Tombstone a Task |
| `unstable_getCurrentPriorityLevel` | 433–435 | Return `currentPriorityLevel` |
| `shouldYieldToHost` (→ `unstable_shouldYield`) | 447–460 | Paint check + deadline check |
| `requestPaint` (→ `unstable_requestPaint`) | 462–466 | Set `needsPaint = true` |
| `forceFrameRate` (→ `unstable_forceFrameRate`) | 468–483 | Adjust `frameInterval` |
| `performWorkUntilDeadline` | 485–514 | Host pump body |
| `schedulePerformWorkUntilDeadline` (setImmediate) | 529–531 | Node / IE branch |
| `schedulePerformWorkUntilDeadline` (MessageChannel) | 538–540 | Browser / Worker branch |
| `schedulePerformWorkUntilDeadline` (setTimeout) | 543–546 | Fallback |
| `requestHostCallback` | 549–554 | Start the pump (idempotent) |
| `requestHostTimeout` | 556–564 | Arm a delayed-task setTimeout |
| `cancelHostTimeout` | 566–570 | Clear the armed timeout |

### SchedulerMinHeap.js

| Function | Lines | Purpose |
|---|---|---|
| `push` | 17–21 | Append + siftUp |
| `peek` | 23–25 | Read root |
| `pop` | 27–40 | Extract minimum |
| `siftUp` | 42–57 | Bubble up toward root |
| `siftDown` | 59–89 | Bubble down toward leaves |
| `compare` | 91–95 | `sortIndex` primary, `id` tiebreaker |

### SchedulerPriorities.js

| Constant | Line | Value |
|---|---|---|
| `NoPriority` | 13 | 0 |
| `ImmediatePriority` | 14 | 1 |
| `UserBlockingPriority` | 15 | 2 |
| `NormalPriority` | 16 | 3 |
| `LowPriority` | 17 | 4 |
| `IdlePriority` | 18 | 5 |

### SchedulerFeatureFlags.js (production)

| Flag | Line | Default |
|---|---|---|
| `enableProfiling` | 10 | `false` |
| `frameYieldMs` | 11 | `5` |
| `userBlockingPriorityTimeout` | 13 | `250` |
| `normalPriorityTimeout` | 14 | `5000` |
| `lowPriorityTimeout` | 15 | `10000` |
| `enableRequestPaint` | 16 | `true` |
| `enableAlwaysYieldScheduler` | 18 | `__EXPERIMENTAL__` |

### Reconciler entry points

| File | Line | Function / Purpose |
|---|---|---|
| `ReactFiberRootScheduler.js` | 384 | `scheduleTaskForRootDuringMicrotask` |
| `ReactFiberRootScheduler.js` | 500–503 | Main `scheduleCallback(priority, performWorkOnRootViaSchedulerTask.bind(null, root))` |
| `ReactFiberRootScheduler.js` | 513 | `performWorkOnRootViaSchedulerTask` definition |
| `ReactFiberRootScheduler.js` | 599 | `scheduleTaskForRootDuringMicrotask` at end of the task |
| `ReactFiberRootScheduler.js` | 600 | `root.callbackNode === originalCallbackNode` check |
| `ReactFiberRootScheduler.js` | 603 | `return performWorkOnRootViaSchedulerTask.bind(null, root)` |
| `ReactFiberWorkLoop.js` | 1122 | `performWorkOnRoot` |
| `ReactFiberWorkLoop.js` | 1153 | `shouldTimeSlice` computation |
| `ReactFiberWorkLoop.js` | 1166 | `renderRootSync` (expired lane path) |
| `ReactFiberWorkLoop.js` | 2001 | `prepareFreshStack` |
| `ReactFiberWorkLoop.js` | 2757 | `renderRootConcurrent` |
| `ReactFiberWorkLoop.js` | 2785 | `prepareFreshStack` call for lane mismatch |
| `ReactFiberWorkLoop.js` | 2787 | `// This is a continuation of an existing work-in-progress.` |
| `ReactFiberWorkLoop.js` | 3034 | `workLoopConcurrent` (throttled variant) |
| `ReactFiberWorkLoop.js` | 3051 | `workLoopConcurrentByScheduler` (standard variant) |
| `ReactFiberWorkLoop.js` | 4167 | `requestPaint()` call after commit |

---

## Appendix: concrete execution trace — big transition render

Assume `root.render(<BigTree/>)` with ~500 fibers at ~0.2 ms each, default
transition priority, `frameYieldMs = 5 ms`.

**Setup (before first slice):**
1. `root.render` → `scheduleUpdateOnFiber` → `ensureRootIsScheduled` →
   `processRootScheduleInMicrotask` → `scheduleTaskForRootDuringMicrotask`.
2. `scheduleCallback(NormalSchedulerPriority, performWorkOnRootViaSchedulerTask.bind(null, root))`.
3. Task created: `{id:1, priority:NormalPriority, startTime:0, expirationTime:5000, sortIndex:5000}`.
4. `push(taskQueue, task)`, `isHostCallbackScheduled = true`,
   `requestHostCallback()` posts MessageChannel message #1.
5. `root.callbackNode = task`.

**Slice 1 (t ≈ 0 ms):**
1. Message #1 fires → `performWorkUntilDeadline` → `startTime = 0`.
2. `flushWork(0)` → `workLoop(0)`.
3. `peek` → task. Yield check: not expired, `shouldYield=false`. Proceed.
4. `task.callback = null`. `continuationCallback = boundReact(false)`.
5. Inside: `performWorkOnRoot` → `renderRootConcurrent` → `prepareFreshStack`
   → `workLoopConcurrentByScheduler` walks ~25 fibers in 5 ms.
6. `shouldYield()` returns true. Loop exits with `workInProgress !== null`.
7. `renderRootConcurrent` returns `RootInProgress`.
8. `scheduleTaskForRootDuringMicrotask` — no priority change.
9. `root.callbackNode === originalCallbackNode` → return
   `performWorkOnRootViaSchedulerTask.bind(null, root)`.
10. Back in `workLoop`: `task.callback = continuationCallback`,
    `advanceTimers(5)`, `return true`.
11. `flushWork` returns true. `hasMoreWork = true`.
    `schedulePerformWorkUntilDeadline()` posts message #2.

**Between slices:** Browser paints, runs rAF callbacks, handles any input.
Task is still at heap root with continuation in its `callback` slot.

**Slices 2 through 19:** Same pattern. Each processes ~25 fibers. Each
stores a new bound continuation. Task's `sortIndex=5000` and `id=1`
never change.

**Slice 20 (completion):**
1. `workLoopConcurrentByScheduler` finishes last fiber. `workInProgress = null`.
2. `renderRootConcurrent` returns `RootCompleted`.
3. `performWorkOnRoot` → `finishConcurrentRender` → `commitRoot` (sync).
4. `ensureRootIsScheduled` → no more work → `root.callbackNode = null`.
5. `performWorkOnRootViaSchedulerTask`:
   - `scheduleTaskForRootDuringMicrotask` → `NoLanes` → cancels (no-op).
   - `root.callbackNode == null` → return `null`.
6. In `workLoop`: `continuationCallback` is `null` → completion branch.
   - `if (task === peek(taskQueue)) pop(taskQueue);` → removes task from heap.
7. Heap empty. Loop exits. `workLoop` returns `false`.
8. `performWorkUntilDeadline`: `hasMoreWork = false` →
   `isMessageLoopRunning = false`. Pump dormant.

**Summary:**
- 20 slices, 20 macrotask cycles.
- Heap held exactly 1 task the whole time.
- `task.callback` was mutated 20 times (1 initial + 19 continuation).
- `id`, `sortIndex`, `expirationTime` never changed.
- `workInProgress` fiber cursor in reconciler globals remembered where to
  resume; Scheduler knew nothing about it.
