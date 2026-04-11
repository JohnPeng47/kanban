# React Scheduler — Comprehensive Source Documentation (iter 2)

Canonical source: `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js` (599 lines).

Siblings:
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerMinHeap.js` (96 lines)
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerPriorities.js` (19 lines)
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerFeatureFlags.js` (19 lines)

Reconciler integration:
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberRootScheduler.js` (738 lines)
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberWorkLoop.js` (~5600 lines; relevant slice: `performWorkOnRoot` 1122–, `renderRootConcurrent` 2757–, the three work loops 3033–3057)

All line numbers below are absolute line numbers in the files named. When the
file name is omitted it is `Scheduler.js`.

---

## 1. Overview & architectural thesis

React's Scheduler is a ~600-line **cooperative time-slicing engine**. Its
entire job is to drain a priority queue of user callbacks on the browser
main thread while yielding frequently enough that the browser stays
responsive to input, layout, paint, and other scripts.

It answers one question: *how do you run a potentially large unit of
JavaScript work without blocking the main thread, on an engine with no
real preemption?*

### 1.1 The thesis, in one paragraph

JavaScript is single-threaded; you cannot interrupt a running callback.
So the scheduler does the only thing that is possible: it **slices work
into short macrotasks**, and between slices it **re-reads a min-heap** to
decide what runs next. "Preemption" in React is a heap re-root between
macrotasks, not during one. "Cancellation" is a tombstone bit in the heap
entry, swept lazily. "Continuation" is in-place mutation of the same
`Task` object so external handles (e.g. `root.callbackNode`) stay stable.
"Starvation prevention" is the `expirationTime > currentTime` conjunct
in the yield check combined with a `didTimeout` signal back to the
callback. "Error recovery" is `hasMoreWork = true` initialized *before*
the `try`. Everything else is consequence.

### 1.2 Architectural highlights

- **Two min-heaps, no other data structures.** `taskQueue` (ready work,
  keyed by `expirationTime`) and `timerQueue` (delayed work, keyed by
  `startTime`). Both use the same flat-array binary heap from
  `SchedulerMinHeap.js`. Everything else is module-level flags and
  function pointers.
- **Module-global mutable state.** Every moving part lives on ~17
  module-level `var`/`let` declarations. `finally` blocks restore the
  invariants so a thrown callback leaves the scheduler consistent.
- **Cooperative only.** Once a user callback is invoked, it runs to
  completion on the scheduler's stack. `workLoop` does not wake up in the
  middle of it.
- **Self-healing.** The sole `try/catch` in production code is around
  `flushWork` inside `performWorkUntilDeadline`, where `hasMoreWork =
  true` is set *before* the `try` so a thrown task still schedules the
  next slice. The error propagates to `window.onerror`; the scheduler
  doesn't swallow it.
- **Three-tier host pump.** The primitive that posts the next macrotask
  is selected *once* at module init from `setImmediate` →
  `MessageChannel.postMessage(null)` → `setTimeout(fn, 0)`. The selector
  captures native references to defeat polyfills and mocks.
- **Zero React knowledge.** The scheduler does not import anything from
  the reconciler and does not know about fibers, lanes, or components.
  The reconciler is one consumer; `SchedulerMock`, `SchedulerPostTask`,
  `SchedulerNative` are others.

### 1.3 The six ingredients

1. A **`Task` record** with `{id, callback, priorityLevel, startTime,
   expirationTime, sortIndex}`.
2. A **priority → timeout table** that maps each priority level to a ms
   offset, which becomes `expirationTime = startTime + timeout`.
3. Two **min-heaps** whose root is "most urgent" (taskQueue) or "next to
   wake" (timerQueue).
4. A **host pump** (`performWorkUntilDeadline`) re-entered once per
   macrotask, via `MessageChannel`/`setImmediate`/`setTimeout`.
5. A **work loop** (`workLoop`) that drains `taskQueue` until either the
   queue is empty or `shouldYieldToHost()` returns true.
6. A **cooperative yield protocol**: a user callback either returns a
   function (continuation) or anything non-function (done).

### 1.4 End-to-end pipeline

```
unstable_scheduleCallback(priority, cb, options?)
  └─ build Task
       ├─ delayed branch:  push(timerQueue); maybe requestHostTimeout(handleTimeout, d)
       └─ immediate branch: push(taskQueue); maybe requestHostCallback()
                                                     └─ schedulePerformWorkUntilDeadline()
                                                          └─ setImmediate / MessageChannel / setTimeout
                                                               └─ performWorkUntilDeadline
                                                                    ├─ needsPaint = false
                                                                    ├─ startTime = getCurrentTime()
                                                                    ├─ flushWork(currentTime)
                                                                    │    ├─ isHostCallbackScheduled = false
                                                                    │    ├─ cancelHostTimeout() if armed
                                                                    │    ├─ isPerformingWork = true
                                                                    │    └─ workLoop(initialTime)
                                                                    │         ├─ advanceTimers
                                                                    │         └─ while (peek(taskQueue))
                                                                    │              ├─ yield check
                                                                    │              ├─ callback = null   (tombstone)
                                                                    │              ├─ cont = callback(didTimeout)
                                                                    │              ├─ currentTime = getCurrentTime()  (refresh)
                                                                    │              └─ continuation? store + return true
                                                                    │                 complete?  conditional pop
                                                                    │                 cancelled? pop
                                                                    └─ finally:
                                                                         hasMoreWork? schedulePerformWorkUntilDeadline()
                                                                         else        isMessageLoopRunning = false
```

---

## 2. Module-level state (exhaustive)

Every piece of mutable state in the scheduler, with exact line numbers
and notes on who writes what.

### 2.1 `getCurrentTime` — lines 59–71

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
- `localPerformance`/`localDate` pins the reference so a later polyfill
  cannot hijack the clock.
- Fallback subtracts `initialTime` so the reading reads `0` on first call.
- Re-exported as `unstable_now` (line 586).

### 2.2 `maxSigned31BitInt` — line 76

```js
// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;
```

- `2^30 - 1`, not `2^31 - 1`. Kept at 31 bits so V8 treats it as a SMI
  (small integer) on 32-bit systems, avoiding heap-boxing.
- `1073741823 ms ≈ 12.4259 days`. This is the idle-priority "never times
  out" value.

### 2.3 `taskQueue` / `timerQueue` — lines 79–80

```js
// Tasks are stored on a min heap
var taskQueue: Array<Task> = [];
var timerQueue: Array<Task> = [];
```

| Heap | Contains | `sortIndex` is... | Root means |
|---|---|---|---|
| `taskQueue` | Ready-to-run tasks | `expirationTime` | Most urgent |
| `timerQueue` | Delayed tasks (`startTime > currentTime`) | `startTime` | Earliest to wake |

**Invariants:**
- A task is in exactly one heap at a time (or neither, after completion).
- `task.sortIndex === task.startTime` ⟺ task is in `timerQueue`.
- `task.sortIndex === task.expirationTime` ⟺ task is in `taskQueue`.
- Migration `timerQueue → taskQueue` happens **only** inside
  `advanceTimers` at lines 112–114, and the `sortIndex` rewrite happens
  **between** the `pop` and the `push`, so no heap ever holds a node
  with the wrong key.

### 2.4 `taskIdCounter` — line 83

```js
// Incrementing id counter. Used to maintain insertion order.
var taskIdCounter = 1;
```

Monotonically increasing. Stamped at line 374 via `id: taskIdCounter++`.
Used as the **FIFO tiebreaker** in the heap comparator; equal-`sortIndex`
tasks run in insertion order.

### 2.5 `currentTask` / `currentPriorityLevel` — lines 85–86

```js
var currentTask = null;
var currentPriorityLevel: PriorityLevel = NormalPriority;
```

- `currentTask` — the task currently being processed by `workLoop`.
  Written at line 191 (`peek(taskQueue)`) and refreshed at line 240
  after each completed task. Reset to `null` in `flushWork`'s `finally`
  at line 178. Because it is **module-level**, the profiling error tap
  inside `flushWork` (line 164) can reach "the currently executing task"
  even though it is not a parameter to the catch.
- `currentPriorityLevel` — the ambient priority that
  `unstable_getCurrentPriorityLevel()` returns. Mutated by:
  - `workLoop` line 205 (per-task, not unwound between iterations)
  - `flushWork` lines 158/179 (save/restore around the whole flush)
  - `unstable_runWithPriority` lines 275/281
  - `unstable_next` lines 300/306
  - `unstable_wrapCallback` lines 316/322

### 2.6 Re-entry and host flags — lines 89–92

```js
// This is set while performing work, to prevent re-entrance.
var isPerformingWork = false;

var isHostCallbackScheduled = false;
var isHostTimeoutScheduled = false;
```

- `isPerformingWork` — `true` between `flushWork` entry (line 157) and
  its `finally` (line 180). The sole consumer is
  `unstable_scheduleCallback` at line 409, which suppresses a redundant
  `requestHostCallback` when a task is scheduled from **inside** a
  running callback (the live loop will pick it up on its next `peek`).
- `isHostCallbackScheduled` — `true` while a `performWorkUntilDeadline`
  message is "in flight" (posted but not yet drained). Set by
  `unstable_scheduleCallback` line 410 and `handleTimeout` line 133.
  Cleared by `flushWork` at line 150, meaning: "we are the host callback
  now; anything scheduled during this flush needs a new message."
- `isHostTimeoutScheduled` — `true` while `handleTimeout` is armed via
  `requestHostTimeout` for a delayed task. Set by
  `unstable_scheduleCallback` line 395. Cleared by `handleTimeout` entry
  line 128 and by `flushWork`'s pre-flush cleanup at line 153. See §17
  gotcha #11 for the subtle "orphaned re-arm" corner case in
  `handleTimeout` line 138.

### 2.7 `needsPaint` — line 94

```js
var needsPaint = false;
```

| Location | Action |
|---|---|
| line 94 | init `false` |
| line 464 (`requestPaint`) | set `true` iff `enableRequestPaint` |
| line 448 (`shouldYieldToHost`) | read — forces yield if `true` |
| line 487 (`performWorkUntilDeadline`) | cleared at *top* of each slice |

The clear happens at the **start** of the next slice *after* yielding.
This guarantees that at least one browser frame boundary was crossed
between "paint requested" and "paint cleared" — the browser is always
given a chance to actually paint before the flag is reset.

### 2.8 Captured native host APIs — lines 97–101

```js
// Capture local references to native APIs, in case a polyfill overrides them.
const localSetTimeout = typeof setTimeout === 'function' ? setTimeout : null;
const localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : null;
const localSetImmediate =
  typeof setImmediate !== 'undefined' ? setImmediate : null; // IE and Node.js + jsdom
```

- `typeof X !== 'undefined'` is the portable alternative to `globalThis.X`
  and works in environments that throw `ReferenceError` for undeclared
  globals.
- These references defeat later polyfills, `zone.js`, fake-timer
  libraries, and Jest mocks — anything that replaces `globalThis.setTimeout`
  *after* module init cannot hijack the scheduler's internal use.
- All three may be `null`. The host-pump selector at lines 517–547
  branches on them.

### 2.9 `isMessageLoopRunning` / `taskTimeoutID` — lines 437–438

```js
let isMessageLoopRunning = false;
let taskTimeoutID: TimeoutID = (-1: any);
```

- `isMessageLoopRunning` — guards the host pump against double-pumping.
  Set `true` by `requestHostCallback` (line 551) right before the first
  `schedulePerformWorkUntilDeadline`. Cleared to `false` inside
  `performWorkUntilDeadline` (line 510) when a flush finishes with no
  more work. A **re-check at line 489** lets the pump bail cleanly if
  the flag was flipped between ticks (this is the closest thing the
  scheduler has to `cancelHostCallback`).
- `taskTimeoutID` — the handle returned by `localSetTimeout` inside
  `requestHostTimeout` (line 561). Single-slot. Sentinel `-1` means "no
  timeout armed". Cleared to `-1` in `cancelHostTimeout` (line 569).

### 2.10 `frameInterval` / `startTime` — lines 444–445

```js
let frameInterval: number = frameYieldMs;
let startTime = -1;
```

- `frameInterval` — slice budget in ms, initialized from the imported
  `frameYieldMs` (default `5`). Only consumer: `shouldYieldToHost` at
  line 453. Only writer: `forceFrameRate` at lines 478/481.
- `startTime` — **module-level**; **not** `Task.startTime`. This is the
  wall-clock anchor when the current browser macrotask began draining.
  Written exactly once per host tick at line 493 inside
  `performWorkUntilDeadline`. Read by `shouldYieldToHost` at line 452.
  Sentinel `-1` is never observed because `shouldYieldToHost` is only
  reachable from inside `workLoop`, which is only reachable from
  `performWorkUntilDeadline`, which always writes it first.

### 2.11 Full module-state table

| # | Variable | Line | Scope | Purpose | Writers |
|---|---|---|---|---|---|
| 1 | `getCurrentTime` | 59 | func | Time source | once at init |
| 2 | `maxSigned31BitInt` | 76 | const | Idle sentinel | — |
| 3 | `taskQueue` | 79 | array | Ready min-heap | `push`/`pop` |
| 4 | `timerQueue` | 80 | array | Delayed min-heap | `push`/`pop` |
| 5 | `taskIdCounter` | 83 | number | FIFO tiebreaker stamp | `scheduleCallback` |
| 6 | `currentTask` | 85 | `Task?` | In-flight task pointer | `workLoop`, `flushWork` finally |
| 7 | `currentPriorityLevel` | 86 | `PriorityLevel` | Ambient priority | `workLoop`, `flushWork`, `runWithPriority`, `next`, `wrapCallback` |
| 8 | `isPerformingWork` | 89 | bool | Re-entry guard | `flushWork` try/finally |
| 9 | `isHostCallbackScheduled` | 91 | bool | Pump-scheduled flag | `scheduleCallback`, `handleTimeout`, `flushWork` |
| 10 | `isHostTimeoutScheduled` | 92 | bool | Timer-armed flag | `scheduleCallback`, `handleTimeout`, `flushWork` |
| 11 | `needsPaint` | 94 | bool | Paint yield flag | `requestPaint`, `performWorkUntilDeadline` |
| 12 | `localSetTimeout` | 97 | func? | Pinned native `setTimeout` | once |
| 13 | `localClearTimeout` | 98 | func? | Pinned native `clearTimeout` | once |
| 14 | `localSetImmediate` | 100 | func? | Pinned native `setImmediate` | once |
| 15 | `isMessageLoopRunning` | 437 | bool | Pump guard | `requestHostCallback`, `performWorkUntilDeadline` |
| 16 | `taskTimeoutID` | 438 | TimeoutID | Host timeout handle | `requestHostTimeout`, `cancelHostTimeout` |
| 17 | `frameInterval` | 444 | number | Slice budget | `forceFrameRate` |
| 18 | `startTime` | 445 | number | Per-slice anchor | `performWorkUntilDeadline` line 493 |
| 19 | `schedulePerformWorkUntilDeadline` | 516 | func | Pump primitive | once at init |

---

## 3. Data structures

### 3.1 `Task` record — lines 47–57

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

| Field | Purpose | Mutable after schedule? |
|---|---|---|
| `id` | Monotonic insertion stamp, FIFO tiebreaker. | No |
| `callback` | User function. `null` = cancelled / in-flight / completed. | **Yes** (tombstone + continuation) |
| `priorityLevel` | One of the five levels. Written to `currentPriorityLevel` before invocation. | No |
| `startTime` | Earliest wall time the task may run. For immediate tasks = `getCurrentTime()` at schedule time; for delayed = `currentTime + delay`. | No |
| `expirationTime` | `startTime + timeout` where `timeout` comes from the priority switch. Task is "overdue" when `expirationTime <= currentTime`. | No |
| `sortIndex` | The heap key. Equals `startTime` in `timerQueue`, `expirationTime` in `taskQueue`. Initialized `-1` then rewritten before push. | Rewritten once during `timerQueue → taskQueue` promotion. |
| `isQueued?` | Optional profiling bookkeeping. | Only with `enableProfiling`. |

**Callback contract:**

```js
Callback = (didTimeout: boolean) => ?Callback
```

- Called with `didUserCallbackTimeout` (true when `expirationTime <= currentTime`).
- Returning another `function` means "continuation — call me again next slice".
- Returning anything else (`undefined`, `null`, a value) means "done; pop me".
- The return type `?Callback` (`Callback | null | void`) is enforced at the
  type level; at runtime the check is `typeof continuationCallback === 'function'`.

### 3.2 `SchedulerMinHeap.js` — the only data-structure module

Flat-array binary heap. 96 lines total.

```js
// lines 10-15
type Heap<T: Node> = Array<T>;
type Node = {
  id: number,
  sortIndex: number,
  ...
};
```

Three public functions:

```js
// lines 17-21
export function push<T: Node>(heap: Heap<T>, node: T): void {
  const index = heap.length;
  heap.push(node);
  siftUp(heap, node, index);
}

// lines 23-25
export function peek<T: Node>(heap: Heap<T>): T | null {
  return heap.length === 0 ? null : heap[0];
}

// lines 27-40
export function pop<T: Node>(heap: Heap<T>): T | null {
  if (heap.length === 0) {
    return null;
  }
  const first = heap[0];
  const last = heap.pop();
  if (last !== first) {
    heap[0] = last;
    siftDown(heap, last, 0);
  }
  return first;
}
```

`siftUp` uses `(index - 1) >>> 1` (unsigned right shift) to compute the
parent index — cheap and avoids any negative-index shenanigans. `siftDown`
uses `leftIndex = (index + 1) * 2 - 1` (algebraically `2*index + 1`) and
prefers the left child on a tie.

**Comparator — lines 91–95:**

```js
function compare(a: Node, b: Node) {
  // Compare sort index first, then task id.
  const diff = a.sortIndex - b.sortIndex;
  return diff !== 0 ? diff : a.id - b.id;
}
```

- Primary key: `sortIndex` (smaller = higher priority = closer to root).
- Secondary key: `id` (FIFO tiebreaker — `taskIdCounter` is strictly
  increasing, so equal-priority tasks run in insertion order).

**The heap only supports popping the root.** There is no `removeAt(i)`,
no `heapify`, no `decreaseKey`. This is the single constraint that
forces the lazy tombstone approach to cancellation (§11). It also means
arbitrary-node removal would be O(n) to find + O(log n) to fix, which
is intolerable at the reconciler's cancel-and-reschedule rate.

**Cost table:**

| Operation | Cost | Why |
|---|---|---|
| `peek` | O(1) | `heap[0]` |
| `push` | O(log n) | siftUp |
| `pop` | O(log n) | siftDown |
| `unstable_cancelCallback` | O(1) | tombstone only |
| `advanceTimers` draining k | O(k log n) | k pops |

`push`/`pop`/`peek` are called **only** from `advanceTimers`, `workLoop`,
`handleTimeout`, and `unstable_scheduleCallback`. The heap is **never**
iterated.

### 3.3 Why two queues, not one

Splitting delayed from ready tasks lets the scheduler answer both
questions it cares about in O(1) via `peek`:

1. "What should I run right now?" → `peek(taskQueue)`.
2. "How long until the earliest delayed task wakes?" →
   `peek(timerQueue).startTime - currentTime`.

With a single heap and a "not yet ready" flag, you'd either have to
iterate (O(n)) or maintain a secondary index; the two-heap design makes
both questions structural peeks.

### 3.4 Dual semantics of `sortIndex`

The same `sortIndex` field is used to sort both heaps, but it means
different things in each. The rewrite during promotion is done
**between** the `pop(timerQueue)` and the `push(taskQueue)`:

```js
// advanceTimers, lines 111-114
pop(timerQueue);                            // remove from timerQueue (with startTime key)
timer.sortIndex = timer.expirationTime;     // rewrite key
push(taskQueue, timer);                     // insert into taskQueue (with expirationTime key)
```

At no point is a node present in a heap with the wrong key. This is the
entire reason two heaps can share a `Task` type.

---

## 4. Priorities & timeout mapping

### 4.1 The six levels — `SchedulerPriorities.js`

```js
// Lines 10-18
export type PriorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const NoPriority = 0;            // sentinel, never a valid argument
export const ImmediatePriority = 1;
export const UserBlockingPriority = 2;
export const NormalPriority = 3;
export const LowPriority = 4;
export const IdlePriority = 5;
```

`NoPriority` is a sentinel; if it ever reaches the switch in
`scheduleCallback`, the `default` branch coerces it to `NormalPriority`.

### 4.2 Priority → timeout — `Scheduler.js:346–369`

```js
var timeout;
switch (priorityLevel) {
  case ImmediatePriority:
    timeout = -1;                             // always-expired
    break;
  case UserBlockingPriority:
    timeout = userBlockingPriorityTimeout;    // 250 ms
    break;
  case IdlePriority:
    timeout = maxSigned31BitInt;              // 1073741823 ms ≈ 12.4259 days
    break;
  case LowPriority:
    timeout = lowPriorityTimeout;             // 10000 ms
    break;
  case NormalPriority:
  default:
    timeout = normalPriorityTimeout;          // 5000 ms
    break;
}
```

| Priority | Timeout (ms) | Source |
|---|---|---|
| `ImmediatePriority` | `-1` | inline constant, line 350 |
| `UserBlockingPriority` | `250` | `SchedulerFeatureFlags.js:13` |
| `IdlePriority` | `1073741823` | inline `maxSigned31BitInt`, line 358 |
| `LowPriority` | `10000` | `SchedulerFeatureFlags.js:15` |
| `NormalPriority` | `5000` | `SchedulerFeatureFlags.js:14` |

**Switch-order subtleties:**
- `IdlePriority` is listed *above* `LowPriority`/`NormalPriority` so the
  sentinel is handled before the fall-through.
- `NormalPriority` shares the `default:` arm, so any unknown value
  (including `NoPriority = 0`) silently becomes normal priority.
- `ImmediatePriority = -1` means `expirationTime = startTime - 1`,
  already in the past at the moment of creation. Every subsequent
  `expirationTime <= currentTime` check returns true, so the yield
  check (§8) is bypassed and the task runs to completion without
  yielding.

### 4.3 `expirationTime` — line 371

```js
var expirationTime = startTime + timeout;
```

This one expression **is** the entire priority system. A smaller
`expirationTime` = higher urgency = closer to the heap root = runs
sooner. There is no separate `priority` field used for ordering.

| Priority | `expirationTime` at `startTime = 0` |
|---|---|
| Immediate | `-1` (always expired) |
| UserBlocking | `250` |
| Normal | `5000` |
| Low | `10000` |
| Idle | `1073741823` |

### 4.4 `currentPriorityLevel` and the ambient-priority API

`currentPriorityLevel` is a module-level variable initialized to
`NormalPriority` (line 86). It is mutated by:

| Writer | Lines | When |
|---|---|---|
| `workLoop` | 205 | before each task invocation (set to that task's priority) |
| `flushWork` save | 158 | snapshot on entry |
| `flushWork` restore | 179 | restore in `finally` |
| `unstable_runWithPriority` | 275/281 | save/swap/restore around `eventHandler()` |
| `unstable_next` | 300/306 | demote-only save/swap/restore |
| `unstable_wrapCallback` | 316/322 | restore captured priority per call |

Note: changing `currentPriorityLevel` is purely ambient. It does not
schedule anything; callbacks scheduled via `unstable_scheduleCallback`
use whatever `priorityLevel` is passed explicitly. The ambient value is
only observable via `unstable_getCurrentPriorityLevel()` (lines 433–435)
from inside a running callback.

### 4.5 Reconciler's effective priority usage

| Scheduler priority | Reconciler uses? | Trigger |
|---|---|---|
| `ImmediatePriority` | Rarely | Safari microtask-unavailable fallback (`ReactFiberRootScheduler.js:680, 690`) |
| `UserBlockingPriority` | Very common | Discrete / continuous input events |
| `NormalPriority` | Very common | Default render, passive effects, cache abort |
| `LowPriority` | **No production caller** | Exported but unused |
| `IdlePriority` | Yes | Idle-lane work, post-paint transition callbacks |

**Sync work bypasses the scheduler entirely.** See
`ReactFiberRootScheduler.js:449–456`:

```js
if (
  includesSyncLane(nextLanes) &&
  !checkIfRootIsPrerendering(root, nextLanes)
) {
  // Synchronous work is always flushed at the end of the microtask, so we
  // don't need to schedule an additional task.
  if (existingCallbackNode !== null) {
    cancelCallback(existingCallbackNode);
  }
  root.callbackPriority = SyncLane;
  root.callbackNode = null;
  return SyncLane;
}
```

SyncLane work runs via microtask in `processRootScheduleInMicrotask`.
See the comment at `ReactFiberRootScheduler.js:482–484`:

> Scheduler does have an "ImmediatePriority", but now that we use
> microtasks for sync work we no longer use that. Any sync work that
> reaches this path is meant to be time sliced.

This means **`ImmediatePriority` is effectively unreachable from the
reconciler in concurrent mode**; the highest priority it ever requests
is `UserBlocking`.

---

## 5. Public API surface

The scheduler exports **14** functions plus **5** priority constants
plus the `unstable_Profiling` object. Lines 572–588:

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

export const unstable_Profiling = enableProfiling
  ? { startLoggingProfilingEvents, stopLoggingProfilingEvents }
  : null;
```

| Export | Lines | What it does |
|---|---|---|
| `unstable_ImmediatePriority` | 573 | Constant `1` |
| `unstable_UserBlockingPriority` | 574 | Constant `2` |
| `unstable_NormalPriority` | 575 | Constant `3` |
| `unstable_IdlePriority` | 576 | Constant `5` |
| `unstable_LowPriority` | 577 | Constant `4` |
| `unstable_runWithPriority` | 260–283 | Save/swap/restore ambient priority around a sync call |
| `unstable_next` | 285–308 | Demote-only ambient priority helper |
| `unstable_scheduleCallback` | 327–416 | Create a Task and enqueue it |
| `unstable_cancelCallback` | 418–431 | Tombstone a Task (`callback = null`) |
| `unstable_wrapCallback` | 310–325 | Closure that restores captured priority per call |
| `unstable_getCurrentPriorityLevel` | 433–435 | Read ambient priority |
| `unstable_shouldYield` | 447–460 | Yield-check primitive (re-exported name for `shouldYieldToHost`) |
| `unstable_requestPaint` | 462–466 | Set `needsPaint = true` |
| `unstable_now` | 59–71 | High-resolution clock |
| `unstable_forceFrameRate` | 468–483 | Override `frameInterval` |
| `unstable_Profiling` | 590–598 | `null` unless `enableProfiling` |

### 5.1 `unstable_runWithPriority(priorityLevel, eventHandler)` — lines 260–283

```js
function unstable_runWithPriority<T>(
  priorityLevel: PriorityLevel,
  eventHandler: () => T,
): T {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;  // coerce invalid → Normal
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}
```

- Validates `priorityLevel`: anything outside the 1..5 range (including
  `NoPriority = 0`) coerces to `NormalPriority`.
- Save/swap/restore the ambient priority around a **synchronous**
  `eventHandler()` call.
- Does **not** schedule anything. Purely ambient.

### 5.2 `unstable_next(eventHandler)` — lines 285–308

```js
function unstable_next<T>(eventHandler: () => T): T {
  var priorityLevel: PriorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      priorityLevel = NormalPriority;       // demote
      break;
    default:
      priorityLevel = currentPriorityLevel; // Low/Idle pass through
      break;
  }
  // ...save/swap/restore identical to runWithPriority
}
```

**Demote only; never promote.** Immediate / UserBlocking / Normal all
become Normal. Low / Idle stay where they are. The use case is "a new
task scheduled right after an urgent event should not ride that event's
high priority unless the caller opts in explicitly".

### 5.3 `unstable_wrapCallback(callback)` — lines 310–325

```js
function unstable_wrapCallback<T: (...Array<mixed>) => mixed>(callback: T): T {
  var parentPriorityLevel = currentPriorityLevel;
  return function () {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    currentPriorityLevel = parentPriorityLevel;
    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
    }
  };
}
```

- Captures `parentPriorityLevel` at **wrap time**, not invocation time.
- The returned closure restores that priority on every call via
  save/swap/restore.
- Uses `callback.apply(this, arguments)` so the wrapped function keeps
  `this` and variadic args. Because of this, the wrapper is `function
  () {}`, not an arrow.
- The comment explicitly says it's an inlined fork of `runWithPriority`
  to avoid an extra function call in what's a hot path.

### 5.4 `unstable_scheduleCallback(priorityLevel, callback, options?)` — lines 327–416

See §6.1 for the full annotated body.

### 5.5 `unstable_cancelCallback(task)` — lines 418–431

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

Tombstone, O(1). See §11.

### 5.6 `unstable_getCurrentPriorityLevel()` — lines 433–435

```js
function unstable_getCurrentPriorityLevel(): PriorityLevel {
  return currentPriorityLevel;
}
```

Returns the module-level `currentPriorityLevel`. Used by the reconciler
to snapshot the ambient scheduler priority for various bookkeeping.

### 5.7 `shouldYieldToHost()` — lines 447–460 (exported as `unstable_shouldYield`)

See §8.

### 5.8 `requestPaint()` — lines 462–466 (exported as `unstable_requestPaint`)

```js
function requestPaint() {
  if (enableRequestPaint) {
    needsPaint = true;
  }
}
```

- Sets `needsPaint = true` when `enableRequestPaint` is on (default in
  production fork).
- The reconciler calls this after a commit that produces visible changes.
- Consumed by `shouldYieldToHost` to force a yield even if the slice
  budget has not been exhausted.

### 5.9 `getCurrentTime()` — lines 59–71 (exported as `unstable_now`)

See §2.1. High-res `performance.now()` when available, else `Date.now()`
offset to start at 0.

### 5.10 `forceFrameRate(fps)` — lines 468–483 (exported as `unstable_forceFrameRate`)

```js
function forceFrameRate(fps: number) {
  if (fps < 0 || fps > 125) {
    // Using console['error'] to evade Babel and ESLint
    console['error'](
      'forceFrameRate takes a positive int between 0 and 125, ' +
        'forcing frame rates higher than 125 fps is not supported',
    );
    return;
  }
  if (fps > 0) {
    frameInterval = Math.floor(1000 / fps);
  } else {
    // reset the framerate
    frameInterval = frameYieldMs;
  }
}
```

- Input validation: `[0, 125]` inclusive.
- `fps === 0` resets to `frameYieldMs` (the 5 ms default).
- `fps > 0` sets `frameInterval = floor(1000 / fps)`. Example: `fps=60 → 16`,
  `fps=120 → 8`, `fps=125 → 8`.
- `console['error']` bracket notation evades Babel / ESLint transforms
  that warn about `console.error` calls.
- **The 125 fps ceiling corresponds to `frameInterval = 8 ms`, which is
  *looser* than the 5 ms default.** `forceFrameRate` cannot make
  yielding tighter than the built-in feature flag default.

### 5.11 APIs that no longer exist

Scheduler has removed several exports over time. Readers of older docs
or blog posts may encounter these names:

- `unstable_pauseExecution`
- `unstable_continueExecution`
- `unstable_getFirstCallbackNode`
- `cancelHostCallback` (only `cancelHostTimeout` exists; §9.5)
- `isSchedulerPaused` flag
- `enableIsInputPending`, `isInputPending`, `continuousYieldTime`,
  `maxYieldInterval` (the old Chromium `navigator.scheduling.isInputPending()`
  integration — fully removed; §8.6)

Some of these remain in `SchedulerMock.js` for test purposes.

---

## 6. Task lifecycle

### 6.1 `unstable_scheduleCallback` — lines 327–416 (full body)

```js
function unstable_scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: Callback,
  options?: {delay: number},
): Task {
  var currentTime = getCurrentTime();                  // (a)

  var startTime;                                        // (b)
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

  var timeout;                                          // (c)
  switch (priorityLevel) { /* see §4.2 */ }

  var expirationTime = startTime + timeout;             // (d)

  var newTask: Task = {                                 // (e)
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

  if (startTime > currentTime) {                        // (f) delayed
    newTask.sortIndex = startTime;
    push(timerQueue, newTask);
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      // All tasks are delayed, and this is the task with the earliest delay.
      if (isHostTimeoutScheduled) {
        cancelHostTimeout();
      } else {
        isHostTimeoutScheduled = true;
      }
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {                                              // (g) immediate
    newTask.sortIndex = expirationTime;
    push(taskQueue, newTask);
    if (enableProfiling) {
      markTaskStart(newTask, currentTime);
      newTask.isQueued = true;
    }
    // Schedule a host callback, if needed. If we're already performing work,
    // wait until the next time we yield.
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    }
  }

  return newTask;
}
```

**Step-by-step with invariants:**

**(a) Line 332 — read clock once.** `currentTime = getCurrentTime()`.
Every subsequent decision in this function uses this same reading.

**(b) Lines 334–344 — compute `startTime`.**
- If `options` is an object AND `options.delay` is a number AND `delay > 0`:
  `startTime = currentTime + delay`.
- Else: `startTime = currentTime`.
- **`{delay: 0}` is NOT a delay.** The strict `> 0` check falls through
  to the immediate branch. Only positive numeric delays delay.

**(c) Lines 346–369 — priority → timeout.** See §4.2.

**(d) Line 371 — `expirationTime = startTime + timeout`.**

**(e) Lines 373–383 — build the Task record.**
- `id: taskIdCounter++` stamps a monotonic FIFO tiebreaker.
- `sortIndex: -1` is a placeholder; the real key is written in the
  branch below **before** the heap push.

**(f) Lines 385–399 — delayed branch (`startTime > currentTime`):**
1. `newTask.sortIndex = startTime;` — key for `timerQueue`.
2. `push(timerQueue, newTask);`
3. If **both** `peek(taskQueue) === null` (no ready work) **and**
   `newTask === peek(timerQueue)` (this task is the earliest delayed
   one), arm `handleTimeout`:
   - If `isHostTimeoutScheduled` is already true, cancel the existing
     timeout (it was for a later delay) and re-arm.
   - Else flip the flag true.
   - Call `requestHostTimeout(handleTimeout, startTime - currentTime)`.
- **Note:** `isHostTimeoutScheduled` remains `true` across the
  cancel+re-arm (it is only cleared in the `else` branch).

**(g) Lines 400–413 — immediate branch:**
1. `newTask.sortIndex = expirationTime;` — key for `taskQueue`.
2. `push(taskQueue, newTask);`
3. Only schedule a host callback if `!isHostCallbackScheduled &&
   !isPerformingWork`. The second conjunct is the re-entrance guard: if
   we are already inside a running `workLoop`, it will pick up the new
   task on its next `peek` iteration — no new host pump needed.

Return the `newTask`. The reconciler stores it as `root.callbackNode`.

### 6.2 The two-question branch at lines 389–399

```js
if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
```

This two-question peek answers:
1. "Is there any ready work?" — if yes, a host callback is (or will be)
   scheduled anyway, so a host timeout is not needed.
2. "Is this new timer now the earliest?" — only then should we arm or
   re-arm the host timeout.

Both answers are obtained in O(1) via `peek`. No iteration over either
heap.

### 6.3 `advanceTimers(currentTime)` — lines 103–125

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

**Three cases per peek:**
1. **Cancelled timer** (`callback === null`) → pop and discard. This is
   the **only** cleanup path for cancelled delayed tasks (§11.2).
2. **Fired timer** (`startTime <= currentTime`) → pop, rewrite
   `sortIndex` from `startTime` → `expirationTime`, push into
   `taskQueue`. The sortIndex rewrite happens **between** `pop` and
   `push`, so no heap ever holds a node with the wrong key.
3. **Not yet fireable** → return. The min-heap invariant guarantees that
   if the root isn't ready, nothing deeper is.

**Call sites of `advanceTimers` (there are exactly four):**

| Caller | Line | When |
|---|---|---|
| `handleTimeout` | 129 | Host timeout fired |
| `workLoop` (entry) | 190 | Before the main drain loop begins |
| `workLoop` (pre-yield) | 223 | Before returning continuation yield |
| `workLoop` (post-completion) | 235 | After a task completes cleanly |

The latter three in `workLoop` are what keep the delayed-task clock
moving as user callbacks consume time.

### 6.4 `handleTimeout(currentTime)` — lines 127–142

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

**Logic:**
1. Line 128 — `isHostTimeoutScheduled = false;` — we are the timeout.
2. Line 129 — `advanceTimers(currentTime);` — promote any timers whose
   `startTime <= currentTime`.
3. Lines 131–141 — only if no host callback is already scheduled:
   - If there is now ready work → flip `isHostCallbackScheduled = true`
     and call `requestHostCallback()` to start the pump.
   - Else if a later timer is still pending → **re-arm the host timeout**
     for it. **Note the asymmetry at line 138:** this path calls
     `requestHostTimeout` **without** setting `isHostTimeoutScheduled =
     true`. The flag stays `false`. See §17 gotcha #11 for why this
     works out in practice (handleTimeout is idempotent, orphan timeouts
     fire harmlessly).
4. If `isHostCallbackScheduled` was already true (e.g. something slipped
   a task in between the timeout arming and now), this function is a
   no-op after the `advanceTimers` call.

### 6.5 Execute — see §7 (`workLoop`).

### 6.6 Complete / yield / cancel — see §7, §10, §11 respectively.

---

## 7. The work loop

Three nested layers, from outermost to innermost:
`performWorkUntilDeadline` → `flushWork` → `workLoop`. Each does a
specific job.

### 7.1 `workLoop(initialTime)` — lines 188–258 (innermost)

Full body:

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
        // This currentTask hasn't expired we yield to the browser task.
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

**Line-by-line with subtle ordering:**

1. **Line 189** — `let currentTime = initialTime;`. `initialTime` is
   threaded in from `flushWork` which got it from
   `performWorkUntilDeadline` (where it was read from `getCurrentTime`).
   `currentTime` is a **local** — as distinct from `currentTask` which
   is module-level.

2. **Line 190** — `advanceTimers(currentTime);`. Promote any timer
   whose `startTime <= currentTime` **before** the main loop so the
   first `peek(taskQueue)` below sees them.

3. **Line 191** — `currentTask = peek(taskQueue);`. Writes to the
   **module-level** `currentTask`, not a local. This is critical for
   the profiling error tap in `flushWork` (line 164), which accesses
   `currentTask` from inside a `catch` without it being in scope as a
   local.

4. **Line 192** — `while (currentTask !== null)`.

5. **Lines 193–198 — yield check** (skipped entirely under
   `enableAlwaysYieldScheduler`):
   ```js
   if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
     break;
   }
   ```
   **Both conjuncts matter.** Only yield if the task **has not** expired
   AND the host wants control. Expired tasks (expirationTime ≤
   currentTime) bypass yield entirely — this is the starvation escape
   hatch (§13).

6. **Line 200** — `const callback = currentTask.callback;` snapshot
   into a **local**. We need the local because `currentTask.callback`
   is about to be mutated at line 203.

7. **Line 201** — `if (typeof callback === 'function')` — live task
   branch.
   - **Line 203** — `currentTask.callback = null;` the
     **pre-invocation tombstone**. This runs **before** the callback
     invocation at line 212. If the callback throws, the task is
     already dead; on the next slice it will be popped via the
     cancelled branch at line 238. If lines 203 and 212 were swapped,
     a throwing task would be re-invoked infinitely. This is
     load-bearing for §14.3.
   - **Line 205** — `currentPriorityLevel = currentTask.priorityLevel;`
     so `unstable_getCurrentPriorityLevel()` inside the callback sees
     the task's own priority. Not unwound between tasks inside a single
     `workLoop` — only in `flushWork`'s finally.
   - **Line 207** — `const didUserCallbackTimeout =
     currentTask.expirationTime <= currentTime;`.
   - **Lines 208–211** — profiling tap.
   - **Line 212** — `const continuationCallback =
     callback(didUserCallbackTimeout);`. **No try/catch.** The callback
     runs synchronously on the scheduler's stack.
   - **Line 213** — `currentTime = getCurrentTime();`. **The
     post-callback clock refresh.** The callback's duration is unbounded;
     without this re-read, the `advanceTimers(currentTime)` calls below
     would use a stale clock and miss timers that fired during the long
     callback.
   - **Line 214 — continuation branch (`typeof continuationCallback === 'function'`):**
     - **Line 218** — `currentTask.callback = continuationCallback;`
       re-arms the same Task. `sortIndex`, `expirationTime`, `id`, and
       physical heap position are all unchanged. No siftUp/siftDown.
       The Task reference is stable — load-bearing for
       `root.callbackNode === originalCallbackNode`.
     - **Line 221** — profiling `markTaskYield`.
     - **Line 223** — `advanceTimers(currentTime);` — promote timers
       that fired during the long callback so they're considered on
       the next slice.
     - **Line 224** — `return true;` — the only "yield with more work
       in progress" early return.
     - **Comment at lines 215–216:** "If a continuation is returned,
       immediately yield to the main thread **regardless of how much
       time is left in the current time slice**." Continuation yields
       do **not** consult `shouldYieldToHost`. The callback is trusted
       when it says "I'm done for now, call me back."
   - **Line 225 — completion branch:**
     - **Lines 226–231** — profiling.
     - **Lines 232–234** — `if (currentTask === peek(taskQueue))
       pop(taskQueue);`. **Defensive completion pop guard.** The user
       callback might have scheduled a more urgent task making
       `currentTask` no longer the root. If so, leave it — its
       `callback` is already `null` (tombstoned at line 203), so it
       becomes a deferred tombstone that will be popped via the
       cancelled branch later.
     - **Line 235** — `advanceTimers(currentTime);`.

8. **Lines 237–239 — cancelled branch** (`callback === null` on entry):
   `pop(taskQueue);` **unconditionally**. The task is known to be at
   the root of the heap (we just `peek`ed it), so direct pop is safe.

9. **Line 240** — `currentTask = peek(taskQueue);` refresh for the next
   iteration. This is the only other write to module-level
   `currentTask` besides line 191.

10. **Lines 241–246 — `enableAlwaysYieldScheduler` post-loop check:**
    ```js
    if (enableAlwaysYieldScheduler) {
      if (currentTask === null || currentTask.expirationTime > currentTime) {
        break;
      }
    }
    ```
    Breaks if no more tasks or the next task hasn't expired. In this
    experimental mode the loop runs **at most one expired task per
    slice** — yielding is per-task instead of per-frame-interval.

11. **Lines 248–257 — termination tail:**
    ```js
    if (currentTask !== null) {
      return true;
    } else {
      const firstTimer = peek(timerQueue);
      if (firstTimer !== null) {
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
      return false;
    }
    ```
    - `currentTask !== null` (break was taken) → `return true` (caller
      reschedules host).
    - `currentTask === null` (heap drained):
      - If a future timer exists, arm `handleTimeout` to wake the
        scheduler at that time.
      - `return false` so `performWorkUntilDeadline` halts the pump.

### 7.2 Return values of `workLoop`

`workLoop` returns `true` from **two** physically different `return`
statements but only one boolean value — and `false` from one place:

| Line | Value | Reason |
|---|---|---|
| 224 | `true` | Continuation yield (mid-task pause) |
| 250 | `true` | Deadline break / always-yield break (heap non-empty) |
| 256 | `false` | Heap drained; host timeout armed for next timer if any |

`flushWork`'s caller (`performWorkUntilDeadline`) only sees the boolean
`hasMoreWork`. It does not distinguish between the continuation-yield
path and the deadline-break path — both reschedule the pump. The
distinction matters only for invariants about `callback` mutation and
`advanceTimers` ordering.

### 7.3 `flushWork(initialTime)` — lines 144–186 (middle layer)

Full body:

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
        throw error;
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

**Four distinct things happen, strictly in order:**

1. **Lines 145–147 — profiling unsuspend mark.**
2. **Lines 149–155 — pre-flush cleanup:**
   - `isHostCallbackScheduled = false;` — we *are* the host callback
     now, so any future scheduling needs a new message.
   - If a host timeout is armed, cancel it. `workLoop`'s `advanceTimers`
     will handle the promotion; no need to fire the timer separately.
3. **Lines 157–158 — enter work:**
   - `isPerformingWork = true;` — re-entrance guard on.
   - Snapshot `previousPriorityLevel` for restoration.
4. **Lines 159–176 — run `workLoop` inside a try/finally, with an
   optional inner try/catch under `enableProfiling`:**
   - **Profiling path (160–172):** inner `try { workLoop } catch {
     markTaskErrored; throw }`. This is an **error tap**, not a
     handler. It runs `markTaskErrored` while `currentTask` is still
     live, then **re-throws** so the error continues propagating. It
     never swallows.
   - **Production path (173–176):** bare `return workLoop(initialTime)`.
     Comment: `// No catch in prod code path.`
5. **Lines 177–185 — finally (always runs, thrown or returned):**
   - `currentTask = null;`
   - `currentPriorityLevel = previousPriorityLevel;`
   - `isPerformingWork = false;`
   - Profiling suspend mark.

**The two-layer try structure in profiling mode is important.** Outer
`try/finally` is for **state restoration**; inner `try/catch` is for
**error instrumentation that must happen while `currentTask` is still
set**. Without the inner catch, the outer finally would have already
cleared `currentTask` to `null` before the profiler could tag it.

### 7.4 `performWorkUntilDeadline` — lines 485–514 (outermost)

Full body:

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

**Walkthrough:**

1. **Lines 486–488** — `needsPaint = false;`. The browser is about to
   get another chance to paint (we're between slices).
2. **Line 489** — `if (isMessageLoopRunning)`. Re-check the pump guard;
   bail silently if it was flipped false between ticks. This is the
   scheduler's closest equivalent to `cancelHostCallback` — the queued
   message still fires, but this guard makes it a no-op.
3. **Line 490** — `const currentTime = getCurrentTime();` read clock
   once.
4. **Line 493** — `startTime = currentTime;`. **Per-slice anchor write.**
   Every invocation of `performWorkUntilDeadline` resamples `startTime`,
   so every slice begins with a full `frameInterval` budget. This is
   what makes the yield check in `shouldYieldToHost` measure "ms since
   the start of THIS slice" rather than "ms since some absolute zero".
5. **Line 501** — `let hasMoreWork = true;`. **Initialized BEFORE the
   try.** This is the self-healing trick (§14.2): a thrown `flushWork`
   leaves `hasMoreWork` at its initial `true`, so the `finally`
   reschedules the pump even though the assignment never ran.
6. **Lines 502–503** — `hasMoreWork = flushWork(currentTime);`. This is
   the only call to `flushWork` in the whole file.
7. **Lines 504–511 — finally:**
   - `hasMoreWork === true` → `schedulePerformWorkUntilDeadline()` posts
     the next message.
   - `hasMoreWork === false` → `isMessageLoopRunning = false;` halts the
     pump.
8. **Error path:** if `flushWork` throws, assignment on line 503 never
   happens, `hasMoreWork` stays `true` (initial value), the `finally`
   re-posts the next slice, and the thrown error propagates out of the
   macrotask into the browser's top-level error handler. Self-healing.

**No `catch` at any layer of the production path.** The three-layer
design is: `workLoop` has no catch; `flushWork` has no catch in prod
(only an error-tap in profiling); `performWorkUntilDeadline` has no
catch, only a `finally`.

### 7.5 Glue summary

```
performWorkUntilDeadline (outermost, macrotask body, no catch)
  ├─ needsPaint = false
  ├─ startTime = currentTime
  ├─ hasMoreWork = true
  └─ try:
       flushWork(currentTime)   ─────────────  (middle, state save/restore)
         ├─ isHostCallbackScheduled = false
         ├─ cancelHostTimeout() if armed
         ├─ isPerformingWork = true
         ├─ previousPriorityLevel = currentPriorityLevel
         └─ try:
              workLoop(initialTime)   ────────  (innermost, the drain)
                ├─ advanceTimers
                └─ while (peek(taskQueue) !== null):
                     ├─ yield check
                     ├─ callback = null  (tombstone)
                     ├─ cont = callback(didTimeout)  (NO try/catch)
                     ├─ currentTime = getCurrentTime()
                     └─ continuation? store + advanceTimers + return true
                        complete?  conditional pop + advanceTimers
                        cancelled? pop
         finally (flushWork):
            currentTask = null
            currentPriorityLevel = previousPriorityLevel
            isPerformingWork = false
  finally (performWorkUntilDeadline):
     hasMoreWork? schedulePerformWorkUntilDeadline()
     else         isMessageLoopRunning = false
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

Two decisions, strictly in order:

**Step 1 — Paint fast-path** (lines 448–451): if `enableAlwaysYieldScheduler`
is off (production), `enableRequestPaint` is on (default), AND
`needsPaint` is set → return `true` immediately, regardless of remaining
budget.

**Step 2 — Deadline check** (lines 452–459): `timeElapsed =
getCurrentTime() - startTime`. If `timeElapsed < frameInterval`, return
`false` (keep working). Else return `true` (yield).

| State | Return |
|---|---|
| `timeElapsed < frameInterval` | `false` (keep going) |
| `timeElapsed >= frameInterval` | `true` (yield) |
| `needsPaint === true` (non-always-yield mode) | `true` (yield) |

**Two callers share this function:**

1. **Scheduler's own `workLoop`** at line 194 — checks once per task
   iteration, before invoking the callback. Guarded by
   `expirationTime > currentTime` (expired tasks bypass yield).
2. **Reconciler's `workLoopConcurrentByScheduler`** at
   `ReactFiberWorkLoop.js:3053` — checks once per fiber. The reconciler
   imports `shouldYieldToHost` as `shouldYield()` through a thin
   re-export (`react-reconciler/src/Scheduler.js`).

**Both sides share one clock.** The `startTime` module variable is
written by `performWorkUntilDeadline` once per slice, and both callers
poll against the same variable. This is the "single source of truth"
for yield timing.

### 8.2 `frameInterval` / `frameYieldMs`

Declared at line 444:

```js
let frameInterval: number = frameYieldMs;
```

| File (fork) | `frameYieldMs` |
|---|---|
| `SchedulerFeatureFlags.js` line 11 | `5` |
| `forks/SchedulerFeatureFlags.native-fb.js` | `5` |
| `forks/SchedulerFeatureFlags.www.js` | `10` |

- Only **read**: line 453 in `shouldYieldToHost`.
- Only **written**: lines 478/481 in `forceFrameRate`.

The comment at lines 440–443 says:

> Scheduler periodically yields in case there is other work on the main
> thread, like user events. By default, it yields multiple times per
> frame. It does not attempt to align with frame boundaries, since most
> tasks don't need to be frame aligned; for those that do, use
> requestAnimationFrame.

The value is a **slice length**, not a frame cadence. A 60 Hz frame is
~16.67 ms, so a 5 ms slice leaves room for 2–3 slices per frame with
input / layout / paint in between.

### 8.3 `startTime` — the per-slice anchor

Declared at line 445 (`let startTime = -1;`). **Not** `Task.startTime`.
Written exactly once per host pump tick at line 493:

```js
startTime = currentTime;
```

Read by `shouldYieldToHost` at line 452. Every fresh
`performWorkUntilDeadline` resamples it, so each slice begins with a
full `frameInterval` budget. The initial `-1` sentinel is never
observed because `shouldYieldToHost` is only reachable from inside
`workLoop`, which is only reachable from `performWorkUntilDeadline`,
which always writes `startTime` first (line 493) before ever calling
`flushWork` (line 503).

### 8.4 `needsPaint` lifecycle

The flag crosses **exactly one frame boundary** by design:

```
slice N:
  ... callback runs ...
  someCallback calls requestPaint()      // line 464: needsPaint = true
  ... more work ...
  shouldYieldToHost() sees needsPaint    // line 448: return true
  workLoop breaks / returns true
flushWork returns true
performWorkUntilDeadline posts next message
  ----- browser gets control, paints, runs input -----
slice N+1:
  performWorkUntilDeadline fires
  needsPaint = false                     // line 487: cleared HERE
  ...
```

The clear happens at the **start of the next slice**, **after** the
browser has had a chance to paint. This guarantees at least one frame
boundary was crossed between "paint requested" and "paint cleared".

### 8.5 Why 5 ms

- **Not `requestIdleCallback`:** fires only when the browser is truly
  idle; wrong for user-blocking updates; unpredictable cadence;
  aggressively throttled in background tabs.
- **Not `requestAnimationFrame`:** tied to frame boundaries; wastes up
  to ~16 ms; **paused entirely in background tabs**; cannot express
  "yield multiple times per frame".
- **Not one frame (16 ms):** would mean only 1 yield per frame, no room
  for multiple input events inside a single render burst.
- **5 ms chosen:** three slices per 60 Hz frame; amortizes scheduling
  overhead; keeps input latency under one frame even when React is
  mid-render.

### 8.6 Features that no longer exist in the yield logic

- `continuousYieldTime`
- `maxYieldInterval`
- `enableIsInputPending`
- `navigator.scheduling.isInputPending()` integration

These used to exist. Older revisions used Chromium's experimental
`isInputPending()` to force yields when input was pending, plus a
`maxYieldInterval` hard ceiling. The entire integration has been
removed. Today the only trigger for yielding is
`(timeElapsed >= frameInterval) || needsPaint`.

---

## 9. Host pump (three-tier)

### 9.1 What "host pump" means

The host pump is the primitive that runs `performWorkUntilDeadline` on
the **next macrotask** with minimal delay. Candidates and their
tradeoffs:

| Primitive | Pros | Cons |
|---|---|---|
| Microtask (`queueMicrotask`) | Zero delay | Runs *before* paint/input — would block the browser |
| `setTimeout(fn, 0)` | Universal | 4 ms clamp after 5 nestings (HTML spec); heavy background throttling |
| `MessageChannel.postMessage(null)` | No clamping, fast | Keeps Node process alive; background-tab throttled (~1/min) |
| `setImmediate` | Fast; doesn't block Node exit; fires earlier in Node phases | Only available in Node and legacy IE |
| `requestAnimationFrame` | Frame-aligned | Wastes up to 16 ms; **paused in background tabs**; cannot yield multiple times per frame |
| `requestIdleCallback` | True idle | Unpredictable; wrong priority semantics |
| `scheduler.postTask` | Native, priority-aware | Not universally shipped |

React picks the best available per environment via the selector at
lines 517–547, falling through this hierarchy:

1. `setImmediate` (Node / legacy IE) — preferred even over MessageChannel
2. `MessageChannel` (browsers, Workers)
3. `setTimeout(fn, 0)` (exotic fallback)

The choice is made **once at module init** and frozen thereafter.

### 9.2 `schedulePerformWorkUntilDeadline` selector — lines 516–547

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
    // $FlowFixMe[not-a-function] nullable value
    localSetTimeout(performWorkUntilDeadline, 0);
  };
}
```

#### Tier 1: `setImmediate` — lines 517–531 (Node / jsdom / legacy IE)

**Chosen first, even when MessageChannel is available.** Node 15+ has
both; `setImmediate` wins. Three reasons from the comment block:

1. **Doesn't keep Node process alive.** A `MessageChannel` port keeps
   the Node event loop alive — a short-lived Node process (SSR, CLI
   scripts, Jest) would hang waiting for phantom messages. Tracked in
   **GitHub issue facebook/react#20756**.
2. **Runs earlier** in Node's event loop phases (before
   `setTimeout(fn, 0)`).
3. **Node+jsdom interop** — jsdom tests that expose `MessageChannel`
   still pick `setImmediate` because of the capture-at-init choice.

Caveat from the code comment: "both of these would be inferior to
native scheduling." A real `scheduler.postTask()` would be ideal, but
isn't universally shipped yet.

#### Tier 2: `MessageChannel` — lines 532–540 (browsers, Workers)

Setup happens **once** at module init:

```js
const channel = new MessageChannel();
const port = channel.port2;
channel.port1.onmessage = performWorkUntilDeadline;
schedulePerformWorkUntilDeadline = () => {
  port.postMessage(null);
};
```

- Single `MessageChannel` instance for the lifetime of the app.
- `port1` is the listener (`.onmessage = performWorkUntilDeadline`).
- `port2` is the sender; `port2.postMessage(null)` fires a `message`
  event on `port1` as a **macrotask**.
- Payload is `null` — the event itself is the signal; no data is carried.

**Why MessageChannel over `setTimeout(fn, 0)`:** HTML spec timer
clamping. From the Living Standard:

> If nesting level is greater than 5, and timeout is less than 4, then
> set timeout to 4.

Nested `setTimeout(fn, 0)` calls get clamped to 4 ms minimum after the
5th level, adding ~4 ms of dead time per tick. `MessageChannel` has no
such clamping — fires as fast as the browser's task queue allows.

**Downsides of MessageChannel:**
- Background-tab throttling (Chromium intensive-wakeup throttling
  ~1/min after prolonged hide).
- No inherent priority (all messages are equal).
- Not zero-cost — `postMessage` involves structured cloning even of
  `null`.
- Keeps Node process alive (why Node uses `setImmediate` instead).

#### Tier 3: `setTimeout(fn, 0)` — lines 541–547 (exotic fallback)

```js
schedulePerformWorkUntilDeadline = () => {
  localSetTimeout(performWorkUntilDeadline, 0);
};
```

Used only in exotic non-browser, non-Node environments. Pays the full
4 ms clamp tax after 5 nestings and heavy background throttling. The
comment: "We should only fallback here in non-browser environments."

### 9.3 `performWorkUntilDeadline` — see §7.4

The body is identical regardless of which tier posted the message. The
key points relevant to the pump:

- **Line 487:** `needsPaint = false;` — cleared at top of slice.
- **Line 493:** `startTime = currentTime;` — per-slice anchor.
- **Line 489:** `if (isMessageLoopRunning)` — pump guard re-check.
- The `try/finally` (no `catch`) that reschedules on `hasMoreWork`.

### 9.4 `requestHostCallback` — lines 549–554

```js
function requestHostCallback() {
  if (!isMessageLoopRunning) {
    isMessageLoopRunning = true;
    schedulePerformWorkUntilDeadline();
  }
}
```

- **Idempotent.** Multiple calls collapse into one pump thanks to the
  `!isMessageLoopRunning` guard.
- Callers: `unstable_scheduleCallback` line 411, `handleTimeout` line 134.
- **There is no `cancelHostCallback`.** Once a MessageChannel message
  is posted, it will fire. The "effective cancel" is flipping
  `isMessageLoopRunning = false`; the next tick's re-check at line 489
  short-circuits the whole body.

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

**This is a second, separate pump.** It uses the **real** `setTimeout`
(via `localSetTimeout`), **not** MessageChannel. Reasons:
- Semantics are "wait N ms, then fire" — delay is intentional.
- The HTML 4 ms clamp is irrelevant when you explicitly want a delay.
- MessageChannel has no delay parameter.

**Single-slot design:** `taskTimeoutID` holds at most one handle at a
time. Earlier-delayed tasks cancel and re-arm via
`unstable_scheduleCallback` lines 391–398.

The wrapper closure reads `getCurrentTime()` **at fire time**, not at
schedule time, so `handleTimeout` receives an accurate `currentTime`.

### 9.6 Background-tab behavior table

| Primitive | Background |
|---|---|
| `setImmediate` | Node only, N/A for browser tabs |
| `MessageChannel` | Throttled (~1/min after prolonged hide), continues |
| `setTimeout(fn, 0)` | Heavily throttled (1 s minimum), continues |
| `requestAnimationFrame` | **Paused entirely** (0 fps) |
| `requestIdleCallback` | Further deferred |

The scheduler via `MessageChannel` **continues running** in background
tabs, just slowly. This is usually fine because visible rendering isn't
happening anyway.

---

## 10. Continuation pattern

### 10.1 The protocol in one paragraph

> A scheduled callback is invoked with a boolean `didTimeout`. If it is
> not yet done, it returns a **function** (the continuation). The
> scheduler stores that function back on the same heap entry and
> yields. The next macrotask slice peeks the same Task (still at its
> original heap position) and invokes the new callback. If the task is
> done, it returns `null` (or anything non-function) and the task is
> popped.

No generators, no promises, no coroutines, no saved stacks. Just
`(fn) => fn ? callMeAgain : iAmDone`. All per-pause state lives in the
**reconciler's module-level globals**, not in the Scheduler's Task.

### 10.2 Scheduler side — the seven moves (lines 200–234)

```js
const callback = currentTask.callback;                        // (A) snapshot
if (typeof callback === 'function') {
  currentTask.callback = null;                                // (B) tombstone
  currentPriorityLevel = currentTask.priorityLevel;           // (B')
  const didUserCallbackTimeout =
    currentTask.expirationTime <= currentTime;                // (B'')
  if (enableProfiling) {
    markTaskRun(currentTask, currentTime);
  }
  const continuationCallback = callback(didUserCallbackTimeout); // (C) invoke
  currentTime = getCurrentTime();                             // (D) refresh clock
  if (typeof continuationCallback === 'function') {
    currentTask.callback = continuationCallback;              // (E) store
    if (enableProfiling) {
      markTaskYield(currentTask, currentTime);
    }
    advanceTimers(currentTime);                               // (F) promote
    return true;                                              // (G) yield
  } else {
    if (enableProfiling) {
      markTaskCompleted(currentTask, currentTime);
      currentTask.isQueued = false;
    }
    if (currentTask === peek(taskQueue)) {                    // (H) defensive
      pop(taskQueue);
    }
    advanceTimers(currentTime);
  }
} else {
  pop(taskQueue);                                             // (I) cancelled
}
```

**(A) Snapshot.** `callback = currentTask.callback` — a **local**
reference. We need this because line 203 is about to overwrite
`currentTask.callback`.

**(B) Pre-invocation tombstone.** `currentTask.callback = null;` runs
**before** the callback invocation at line 212. If the callback throws,
the task is already dead; on the next slice it will be popped via the
cancelled branch at lines 237–238. If (B) and (C) were swapped, a
throwing task would be re-invoked infinitely.

**(B')** `currentPriorityLevel = currentTask.priorityLevel;` so
`unstable_getCurrentPriorityLevel()` inside the callback sees the
task's own priority.

**(B'')** `didUserCallbackTimeout` — the starvation signal passed to the
callback (§13).

**(C) Synchronous invocation.** User callback runs inline, on the
scheduler's stack. **No try/catch.** The scheduler has no idea what the
callback does during this call.

**(D) Post-callback clock refresh.** `currentTime = getCurrentTime();`.
The callback's duration is unbounded (5 ms typical, 500 ms
pathological). Without this re-read, the `advanceTimers(currentTime)`
calls at (F) and line 235 would use a stale clock and fail to promote
timers that fired during the long callback. Critical for the
delayed-task wake guarantee.

**(E) In-place callback replacement.** `currentTask.callback =
continuationCallback;` — the **same Task object is mutated**. Its
`sortIndex`, `expirationTime`, `id`, **and physical position in the
heap** are all unchanged. No siftUp/siftDown. No re-push. The reference
is stable for the task's entire logical lifetime across N slices. This
is load-bearing for §10.3.

**(F) `advanceTimers(currentTime)` before yielding.** Promotes timers
that fired during the long callback so they're considered on the next
slice's `workLoop` entry.

**(G) Early `return true`.** The only "yield with more work" early
return. The comment at lines 215–216 says "**regardless of how much
time is left in the current time slice**" — continuation yields do
**not** consult `shouldYieldToHost`. The callback is trusted when it
says "call me back".

**(H) Defensive completion pop.** `if (currentTask === peek(taskQueue))`
exists because the user callback can schedule or cancel tasks; the
previously-peeked reference may no longer be the heap root. If it is
not, the current task has `callback = null` (from step B) and becomes a
tombstone that will be swept when it eventually bubbles to the root.

**(I) Cancelled branch.** If `callback` is not a function on entry
(either cancelled externally via `unstable_cancelCallback` or
tombstoned by a previous completion), pop unconditionally. The task is
at the root.

### 10.3 The stability invariant

After a continuation yield, these things are **true**:

1. `newTask.sortIndex` is unchanged.
2. `newTask.expirationTime` is unchanged.
3. `newTask.id` is unchanged.
4. The task's **physical position in the heap** is unchanged.
5. The **Task object reference** is unchanged — any external holder
   (e.g. `root.callbackNode`) still points at the same allocation.

Fact 5 is what makes
`ReactFiberRootScheduler.js:600`'s identity check valid:

```js
if (root.callbackNode != null && root.callbackNode === originalCallbackNode) {
  return performWorkOnRootViaSchedulerTask.bind(null, root);
}
```

If the Scheduler ever allocated a new Task on continuation instead of
mutating in place, this identity check would break silently, and the
reconciler would either miss continuations or schedule duplicates.

### 10.4 Reconciler side — `performWorkOnRootViaSchedulerTask`

`ReactFiberRootScheduler.js:513–606`. The signature matches the
Scheduler's `Callback = boolean => ?Callback`:

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
    return null;                           // bail: commit in progress
  }

  const originalCallbackNode = root.callbackNode;
  const didFlushPassiveEffects = flushPendingEffectsDelayed();
  if (didFlushPassiveEffects) {
    if (root.callbackNode !== originalCallbackNode) {
      return null;                         // stale
    }
  }

  const workInProgressRoot = getWorkInProgressRoot();
  const workInProgressRootRenderLanes = getWorkInProgressRootRenderLanes();
  const rootHasPendingCommit =
    root.cancelPendingCommit !== null || root.timeoutHandle !== noTimeout;
  const lanes = getNextLanes(
    root,
    root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes,
    rootHasPendingCommit,
  );
  if (lanes === NoLanes) {
    return null;                           // nothing to do
  }

  const forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout;
  performWorkOnRoot(root, lanes, forceSync);        // the actual render slice

  scheduleTaskForRootDuringMicrotask(root, now());
  if (root.callbackNode != null && root.callbackNode === originalCallbackNode) {
    return performWorkOnRootViaSchedulerTask.bind(null, root);
  }
  return null;
}
```

Sequence:
1. **Early exit on `hasPendingCommitEffects()`** — if another root is
   mid-commit, bail and wait.
2. **Capture `originalCallbackNode`** — the Scheduler Task handle that
   invoked us.
3. **`flushPendingEffectsDelayed()`** — passive effects may cancel the
   current task. Identity check after: if `root.callbackNode` no longer
   equals the captured node, return `null`.
4. **Compute lanes.** If `NoLanes`, return `null`.
5. **`forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout`** —
   bridge from scheduler's `didUserCallbackTimeout` to reconciler's
   time-slice switch.
6. **`performWorkOnRoot(root, lanes, forceSync)`** — runs the render
   slice (§10.5).
7. **`scheduleTaskForRootDuringMicrotask(root, now())`** — reconcile
   `root.callbackNode` with the latest priority. Either leaves the same
   task in place or cancels it and schedules a new one.
8. **Identity check** — if `root.callbackNode === originalCallbackNode`
   still holds, return a fresh bound
   `performWorkOnRootViaSchedulerTask`. Scheduler stores that at line
   218. Else return `null`, Scheduler pops the now-stale task at line
   233.

### 10.5 `performWorkOnRoot` and the three work loops

`ReactFiberWorkLoop.js:1122–1166` decides sync vs concurrent:

```js
const shouldTimeSlice =
  (!forceSync &&
    !includesBlockingLane(lanes) &&
    !includesExpiredLane(root, lanes)) ||
  checkIfRootIsPrerendering(root, lanes);

let exitStatus = shouldTimeSlice
  ? renderRootConcurrent(root, lanes)
  : renderRootSync(root, lanes, true);
```

Concurrent path enters `renderRootConcurrent` at line 2757, which
eventually calls one of three work loops at lines 2991–2995:

```js
if (__DEV__ && ReactSharedInternals.actQueue !== null) {
  workLoopSync();
} else if (enableThrottledScheduling) {
  workLoopConcurrent(includesNonIdleWork(lanes));
} else {
  workLoopConcurrentByScheduler();
}
```

The three loops:

```js
// workLoopSync (~line 2650, used by renderRootSync and inside act)
function workLoopSync() {
  while (workInProgress !== null) {
    performUnitOfWork(workInProgress);
  }
}

// workLoopConcurrent (line 3034, enableThrottledScheduling variant)
function workLoopConcurrent(nonIdle: boolean) {
  if (workInProgress !== null) {
    const yieldAfter = now() + (nonIdle ? 25 : 5);
    do {
      performUnitOfWork(workInProgress);
    } while (workInProgress !== null && now() < yieldAfter);
  }
}

// workLoopConcurrentByScheduler (line 3051, default)
function workLoopConcurrentByScheduler() {
  // Perform work until Scheduler asks us to yield
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}
```

`shouldYield()` is the re-exported `shouldYieldToHost` from the
Scheduler. This is the single clock shared between the two sides.

- **`workLoopSync`:** no yield check at all. Used by `renderRootSync`,
  which is entered when `shouldTimeSlice` is false (sync lane, expired
  lane, or `forceSync` from `didTimeout`). Also used inside `act`
  scopes.
- **`workLoopConcurrent`:** the `enableThrottledScheduling` variant.
  Uses a fixed 25 ms or 5 ms window (transitions vs idle) polled via
  `now()`. Purpose: intentional throttling so high-frequency scheduler
  slices don't starve animations. Not the default in production.
- **`workLoopConcurrentByScheduler`:** polls `shouldYield()` from the
  Scheduler directly on every fiber. This is the default production
  path and the one the §10.4 integration relies on.

### 10.6 Where per-pause state actually lives

The Scheduler's entire memory of an in-progress render is literally:

```js
task.callback = performWorkOnRootViaSchedulerTask.bind(null, root)
```

That's it. Everything else lives in **reconciler module globals** in
`ReactFiberWorkLoop.js`:

- `workInProgress` — next fiber to process
- `workInProgressRoot` — root currently being rendered
- `workInProgressRootRenderLanes` — which lanes
- `workInProgressSuspendedReason`, `workInProgressThrownValue`
- `workInProgressRootExitStatus`
- The partial fiber tree under `root.current.alternate`

When the continuation is invoked on the next slice,
`renderRootConcurrent` (line 2757) checks:

```js
if (workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes) {
  // fresh start
  prepareFreshStack(root, lanes);
} else {
  // This is a continuation of an existing work-in-progress.
  workInProgressRootIsPrerendering = checkIfRootIsPrerendering(root, lanes);
}
```

If the globals still match, it resumes from where `workInProgress` was
left. If they don't match, it rebuilds via `prepareFreshStack` — the
"restart" path (§12.5).

### 10.7 Continuation vs deadline-break — two structurally different yields

Both paths cause `flushWork` to return `true` and trigger another
MessageChannel post, but they are structurally different:

| | Continuation yield | Deadline-break yield |
|---|---|---|
| Exits `workLoop` via | `return true` (line 224) | `break` (line 196) then `return true` (line 250) |
| Did the callback run this slice? | Yes, exactly once | No |
| `currentTask.callback` | Replaced with continuation | Unchanged (still the live callback) |
| `advanceTimers(currentTime)` before exit? | Yes (line 223) | Implicit on next entry (line 190) |
| `markTaskYield` profiling? | Yes (line 221) | No |
| Semantics | "Pause in the middle of a task" | "Pause between tasks" |
| Partial state | Reconciler globals | None — nothing partial |
| Consults `shouldYieldToHost`? | **No** (§10.2.G) | Yes (that's what triggered it) |

### 10.8 Why this design is good

- **Zero serialization.** No generator frames, no `.next(value)`, no
  suspendable stacks. One in-place function replacement.
- **Zero coupling.** Scheduler has no idea what a fiber is. Same module
  works for React DOM, React Native, React Test Renderer.
- **Trivial cancellation.** `unstable_cancelCallback(task)` just sets
  `task.callback = null`. Next peek pops. No partial state to clean up
  because Scheduler holds none.
- **Identity stability.** `root.callbackNode === originalCallbackNode`
  works because the Task object reference is stable across all slices.
- **Priority changes are a free restart.** If priority changed
  mid-render, the reconciler cancels the old task, schedules a new one,
  and returns `null`; the old task is popped, the new task runs next,
  `prepareFreshStack` rebuilds.

---

## 11. Cancellation (tombstone approach)

### 11.1 `unstable_cancelCallback(task)` — lines 418–431

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
removal would require:
- O(n) to find the node (it is not indexed).
- O(log n) to re-heapify.

At the reconciler's cancel-and-reschedule rate (every keystroke, every
priority change), that cost is intolerable. So cancellation is a
**tombstone**: `task.callback = null` is the entire operation.

### 11.2 Where tombstones are swept

Three sites clean up tombstones lazily:

**(a) `advanceTimers`** — lines 107–109 (for `timerQueue`):

```js
if (timer.callback === null) {
  pop(timerQueue);
}
```

This is the **only** cleanup path for cancelled delayed tasks.

**(b) `workLoop` cancelled branch** — lines 237–239 (for `taskQueue`):

```js
} else {
  pop(taskQueue);
}
```

Executed when `peek(taskQueue).callback === null` on entry. The task is
at the heap root by construction (we just `peek`ed it). This branch
handles both externally cancelled tasks and tasks tombstoned by
completion path (c) below.

**(c) `workLoop` completion path** — the defensive pop guard at line 232
**leaves** a tombstone when the completed task is no longer the root
(because the user callback scheduled a more urgent task). The task's
`callback` is already `null` (tombstoned at line 203), so it becomes a
deferred tombstone that will be swept by branch (b) when it finally
bubbles up.

### 11.3 Why the tombstone approach is correct

1. **Heap invariant preserved.** `callback = null` doesn't touch
   `sortIndex` or `id`.
2. **Tombstones can only "starve" the root.** A cancelled node at the
   root is dropped immediately; deeper tombstones wait until they
   bubble up, but bubbling up is exactly what the heap does anyway.
3. **O(1) cancellation.** The cost is amortized into the next
   `peek`/`pop` cycle.
4. **Memory pressure tradeoff.** Pathological "schedule then cancel
   without draining" could grow either heap unbounded. Not an issue in
   practice because normal operation drains the heap.
5. **You cannot un-cancel.** The callback reference is gone; the
   caller must schedule a new one.

### 11.4 Cancellation from the reconciler

The reconciler holds `root.callbackNode` (the Task handle) so it can
cancel a stale render task when priorities change:

```js
// ReactFiberRootScheduler.js:462-478
if (
  newCallbackPriority === existingCallbackPriority &&
  !(/* act special case */)
) {
  // The priority hasn't changed. We can reuse the existing task.
  return newCallbackPriority;
} else {
  // Cancel the existing callback. We'll schedule a new one below.
  cancelCallback(existingCallbackNode);
}
```

Cancel call sites in `ReactFiberRootScheduler.js`:
- Line 434: root has no more work → cancel any existing handle.
- Line 452: sync work path (no scheduler task needed, cancel any
  concurrent one).
- Line 477: priority change — cancel old, schedule new.

The old task stays in the heap with `callback = null` until it floats
to the root, then `workLoop`'s cancelled branch pops it harmlessly.

### 11.5 There is no `cancelHostCallback`

Scheduler has `cancelHostTimeout` (lines 566–570) but **no**
`cancelHostCallback`. Once a `MessageChannel` message is posted, there
is no way to un-post it. The design instead:

- Lets the message arrive.
- `performWorkUntilDeadline` re-reads `isMessageLoopRunning` at entry
  (line 489).
- `flushWork` can return `false` if there is nothing to do.

The effective "cancel" is flipping `isMessageLoopRunning = false` and
letting the queued message become a no-op. This works because the pump
guard is re-checked at the top of each tick — the only state that needs
to survive is the flag itself, and any pending message will harmlessly
bail on entry.

---

## 12. Preemption (cooperative)

### 12.1 The thesis

**Preemption is a heap re-root between macrotasks, not during one.**

React's scheduler does not preempt. JavaScript is single-threaded; once
a callback is running, it runs to completion on the scheduler's stack.
What's called "preemption" is a tight **cooperative yield loop + heap
re-root**:

1. A long render periodically asks `shouldYield()`.
2. When it yields, it returns a continuation and unwinds all the way to
   `performWorkUntilDeadline`.
3. Between the old message ending and the new message firing, a
   higher-priority task may be pushed onto the heap.
4. Because the heap is a min-heap on `sortIndex = expirationTime`, the
   new task becomes the new root via `siftUp`.
5. Next `performWorkUntilDeadline` calls `peek(taskQueue)` and picks it
   — not the old continuation.
6. The old transition task sits in the heap with its stashed continuation.
   It runs later, after the urgent task drains.

### 12.2 Why true preemption is impossible

Every scheduler slice runs as the callback of a single
`MessageChannel` message (or `setImmediate` / `setTimeout` tick). While
that JS is executing:
- The event loop cannot dispatch any other task.
- No other `postMessage`, `setTimeout`, click handler, or microtask runs.
- The scheduler itself cannot "notice" a higher-priority task because
  the code doing the noticing is not running.

The only way another task can start is for the current JS stack to
fully unwind back to the event loop. React's trick is that during long
work, it unwinds **voluntarily** at safe checkpoints, re-reads the
heap, and lets the event loop decide what runs next.

### 12.3 Cooperative yield — Scheduler and reconciler share one clock

`shouldYieldToHost` is the single source of truth, polled from two
places:

1. Inside `workLoop` at line 194 (before calling a task).
2. Inside `workLoopConcurrentByScheduler` in
   `ReactFiberWorkLoop.js:3053` on every fiber.

When the reconciler's loop sees `shouldYield() === true`:
1. It exits the inner `while` with `workInProgress !== null`.
2. `renderRootConcurrent` returns `RootInProgress`.
3. `performWorkOnRoot` returns early (the outer `do { ... } while` in
   the exit status handler takes the break at line 1193).
4. `performWorkOnRootViaSchedulerTask` returns the continuation bind.
5. Scheduler's `workLoop` stores it at line 218 and returns `true`.
6. `performWorkUntilDeadline` posts the next message.

That entire return sequence is the "preemption window" — a few microseconds
between message dispatches during which the browser can paint, handle
input, run microtasks, and other timers.

### 12.4 Where the re-root actually happens

`performWorkUntilDeadline` (lines 485–514). When `flushWork` returns
`true` (yielded), the `finally` posts a fresh message via
`schedulePerformWorkUntilDeadline`. That message goes to the back of
the browser's task queue. Before it is dispatched, the browser can
process:

1. Native input events that arrived while we were running.
2. Paint.
3. Microtasks.
4. Other timers.

If an input handler calls `scheduleCallback(UserBlocking, cb)`, a new
task is created with a smaller `expirationTime` (≈ 250 ms) than the
existing transition's (≈ 5000 ms). `SchedulerMinHeap.push` at line 19
calls `siftUp`, which bubbles the new task to position 0 because its
`sortIndex` is smaller. When `performWorkUntilDeadline` fires again,
`workLoop` calls `peek(taskQueue)` (line 191) and finds the **new**
task, not the old continuation.

**Crucially, no explicit "preemption" code runs.** Preemption is a
consequence of:
- The heap being a min-heap.
- Continuation mutation not changing the task's `sortIndex`.
- `workLoop` re-`peek`ing on every iteration and on every new slice.

### 12.5 Reconciler-level "restart" — distinct from scheduler-level re-root

When the urgent update modifies a lane that is already part of the
transition's WIP tree, the transition's partial WIP fiber tree must be
thrown away and rebuilt from the committed tree. This happens inside
`renderRootConcurrent` at line 2785:

```js
if (workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes) {
  ...
  prepareFreshStack(root, lanes);
} else {
  // This is a continuation of an existing work-in-progress.
  workInProgressRootIsPrerendering = checkIfRootIsPrerendering(root, lanes);
}
```

`prepareFreshStack(root, lanes)` discards the partial WIP tree and
creates a new one from `root.current`. This works because **render is
side-effect-free**:
- No DOM mutation during render.
- No ref attachment.
- No effects run.

Commit (in `commitRoot`) is synchronous, single-slice, and non-yielding.
The time-slicing and preemption machinery only applies to the render
phase.

### 12.6 Five distinct concepts, often conflated

| Level | Trigger | Mechanism | WIP state preserved? |
|---|---|---|---|
| Scheduler yield | `shouldYield()` true | Return continuation, post new message | Yes — WIP tree + reconciler globals |
| Heap re-root | Higher-prio `push` | `peek` finds different root | Yes — old task still in heap |
| Lazy cancel | `cancelCallback(task)` | `task.callback = null` until popped | N/A (dead) |
| Reconciler restart | `prepareFreshStack(root, lanes)` | New WIP fiber from `root.current` | **No — WIP tree discarded** |
| Starvation escape | `expirationTime <= currentTime` | Scheduler skips yield; reconciler goes sync | Yes — finishes uninterrupted |

What people call "preemption" is assembled from these five pieces.

### 12.7 Lane → Event → Scheduler priority mapping

Three priority systems layered:

```
Lane (bit in bitfield)
  └→ EventPriority (coarser bucket; also a Lane, one of four)
       └→ SchedulerPriority (1..5 from SchedulerPriorities.js)
```

`ReactEventPriorities.js` defines the event priorities as lane
constants:

```js
export const DiscreteEventPriority: EventPriority = SyncLane;
export const ContinuousEventPriority: EventPriority = InputContinuousLane;
export const DefaultEventPriority: EventPriority = DefaultLane;
export const IdleEventPriority: EventPriority = IdleLane;
```

`ReactFiberRootScheduler.js:481–498` maps to scheduler priority:

```js
switch (lanesToEventPriority(nextLanes)) {
  case DiscreteEventPriority:
  case ContinuousEventPriority:
    schedulerPriorityLevel = UserBlockingSchedulerPriority;
    break;
  case DefaultEventPriority:
    schedulerPriorityLevel = NormalSchedulerPriority;
    break;
  case IdleEventPriority:
    schedulerPriorityLevel = IdleSchedulerPriority;
    break;
  default:
    schedulerPriorityLevel = NormalSchedulerPriority;
    break;
}
```

**A click at `DiscreteEventPriority` / `SyncLane` does NOT reach the
scheduler heap.** See §4.5. Sync lane work bypasses the scheduler via
microtask (`processRootScheduleInMicrotask`). The click only ends up in
the scheduler if its lane is continuous input (`UserBlockingPriority`,
timeout 250 ms), which beats any transition at `NormalPriority`
(timeout 5000 ms).

### 12.8 `enableAlwaysYieldScheduler` — experimental opposite

Gated on `__EXPERIMENTAL__` (`SchedulerFeatureFlags.js:18`). Flips
yielding upside down with three changes:

1. **Top-of-loop check skipped** (line 193):
   ```js
   if (!enableAlwaysYieldScheduler) {
     if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
       break;
     }
   }
   ```
2. **Bottom-of-loop check added** (lines 241–246):
   ```js
   if (enableAlwaysYieldScheduler) {
     if (currentTask === null || currentTask.expirationTime > currentTime) {
       break;
     }
   }
   ```
3. **`needsPaint` short-circuit** (line 448):
   ```js
   if (!enableAlwaysYieldScheduler && enableRequestPaint && needsPaint) {
     return true;
   }
   ```

**Semantics:** run exactly one task that is either the first one or a
successor that has already expired, then yield unconditionally. The
`frameInterval` budget check is removed; yielding is **per-task**
instead of per-5-ms.

**Rationale:** on devices with native frame-aligned scheduling (e.g.
`scheduler.postTask`), the heuristic 5 ms budget is redundant; always
yielding gives the host finer-grained paint/input interleaving. Cost is
task-switching overhead.

---

## 13. Starvation prevention

### 13.1 Scheduler-level — expired tasks bypass yield

The yield check in `workLoop` at line 194:

```js
if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
  break;
}
```

**Both conjuncts matter.** Yield only if **both** "task hasn't expired"
AND "host wants yield". If the task has expired (`expirationTime <=
currentTime`), the first conjunct is false, the loop does not break
regardless of `shouldYieldToHost`, and the task runs to completion.

Combined with the priority → timeout table:

| Priority | Becomes non-yieldable after |
|---|---|
| Immediate | Instantly (timeout `-1`; always expired) |
| UserBlocking | 250 ms |
| Normal | 5000 ms |
| Low | 10000 ms |
| Idle | ~12.4259 days (effectively never) |

A `LowPriority` task scheduled 10 seconds ago has `expirationTime <=
currentTime`; once it reaches the heap root, it runs to at least one
completion step even under continuous high-priority pressure.

### 13.2 The `didTimeout` signal

The callback is told whether it has been starved:

```js
// line 207
const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
// line 212
const continuationCallback = callback(didUserCallbackTimeout);
```

For `ImmediatePriority` (timeout `-1`), `didUserCallbackTimeout` is
`true` on the very first call. React's
`performWorkOnRootViaSchedulerTask` uses this boolean to set
`forceSync = true`, which switches the reconciler from time-sliced to
**synchronous** rendering (`renderRootSync`, which uses `workLoopSync`
— no yield check).

### 13.3 Reconciler-level — `markStarvedLanesAsExpired` and `shouldTimeSlice`

`ReactFiberLane.js` defines `markStarvedLanesAsExpired(root,
currentTime)` which walks `root.pendingLanes` and flags lanes whose
expiration timestamp has passed into `root.expiredLanes`. Called at the
top of `scheduleTaskForRootDuringMicrotask`
(`ReactFiberRootScheduler.js:397`).

`ReactFiberWorkLoop.js:1153`:

```js
const shouldTimeSlice =
  (!forceSync &&
    !includesBlockingLane(lanes) &&
    !includesExpiredLane(root, lanes)) ||
  checkIfRootIsPrerendering(root, lanes);

let exitStatus = shouldTimeSlice
  ? renderRootConcurrent(root, lanes)
  : renderRootSync(root, lanes, true);
```

If `forceSync` (from `didTimeout`) OR any expired lane is in play,
`shouldTimeSlice` is `false` and the reconciler calls `renderRootSync`,
which uses `workLoopSync` — no `shouldYield()` polling, runs to
completion in one slice.

### 13.4 The two layers compose

- **Scheduler layer** refuses to yield an expired task via the
  `expirationTime > currentTime` conjunct.
- **Reconciler layer** forces synchronous rendering when an expired
  lane is detected via `forceSync` or `includesExpiredLane`.

Both guards fire on the same signal (`expirationTime <= currentTime`).
The result: once a lane is starved, the scheduler doesn't yield the
task and the reconciler doesn't yield the fiber loop. The work runs
through one way or the other.

---

## 14. Error handling & self-healing

The scheduler never swallows errors. Three layers, none silent.

### 14.1 Layer 1 — `workLoop`

**No try/catch around `callback()` at line 212.** Exception propagates
straight out of the loop. The loop does not return cleanly; the
exception unwinds through `flushWork` and beyond.

### 14.2 Layer 2 — `flushWork`

- **Profiling path** (lines 160–172): inner `try { workLoop } catch {
  markTaskErrored; throw }`. This is an **error tap**, not a handler.
  It runs `markTaskErrored(currentTask, currentTime)` while
  `currentTask` is still set, then **re-throws** so the exception
  continues propagating. It never swallows.
- **Production path** (lines 173–176): bare `return
  workLoop(initialTime);` with no catch. Comment:
  `// No catch in prod code path.`
- **Outer `try/finally`** (lines 159–185): unconditionally restores
  `currentTask = null`, `currentPriorityLevel = previousPriorityLevel`,
  `isPerformingWork = false`. Runs on both normal return and thrown
  exception.

**Two layers of try in profiling mode:** outer `try/finally` for state
restoration; inner `try/catch` for error instrumentation that must run
while `currentTask` is still set. Without the inner catch, the outer
finally would have already cleared `currentTask` to `null` before the
profiler could tag it.

### 14.3 Layer 3 — `performWorkUntilDeadline`

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

**No `catch`.** From the comment at lines 495–500:

> If a scheduler task throws, exit the current browser task so the
> error can be observed.
>
> Intentionally not using a try-catch, since that makes some debugging
> techniques harder. Instead, if `flushWork` errors, then `hasMoreWork`
> will remain true, and we'll continue the work loop.

### 14.4 Self-healing via `hasMoreWork = true` initialization

`let hasMoreWork = true;` is initialized **before** the `try` block. If
`flushWork` throws:
1. The assignment on line 503 never runs.
2. `hasMoreWork` retains its initial `true` value.
3. The `finally` re-schedules the pump via
   `schedulePerformWorkUntilDeadline()`.
4. The thrown error propagates out of the macrotask into the browser's
   top-level error handler (where DevTools and `window.onerror` can
   observe it).
5. On the next slice, the scheduler retries — but thanks to §14.5
   below, the throwing task has already been tombstoned, so it won't
   re-throw forever.

### 14.5 Tombstone prevents re-throw loops

Because `currentTask.callback = null` runs at line 203 **before** line
212 invokes the callback, a throwing task is **already a tombstone by
the time the exception propagates**.

On the next slice:
1. `peek(taskQueue)` returns the same task.
2. `callback === null`.
3. The cancelled branch at lines 237–238 pops it unconditionally.
4. Loop moves on to the next task.

So a throwing task is popped and the scheduler moves on — no infinite
re-invocation. This is the crucial interplay of the pre-invocation
tombstone with the self-healing pump.

### 14.6 Reconciler-level error handling

`renderRootConcurrent` (line 2757 in `ReactFiberWorkLoop.js`) wraps its
work loop in a try/catch:

```js
do {
  try {
    ...
    workLoopConcurrentByScheduler();
    break;
  } catch (thrownValue) {
    handleThrow(root, thrownValue);
  }
} while (true);
```

Ordinary component errors are caught inside `renderRootConcurrent`,
re-thrown into the error-boundary logic (`handleThrow`), and never
escape to `workLoop`. The Layer 1–3 chain above is only reached for
genuinely catastrophic errors (OOM, errors inside `handleThrow` itself,
errors inside scheduler primitives).

---

## 15. Reconciler integration

This section covers the reconciler-scheduler boundary in detail, since
it is the least-covered area in most docs.

### 15.1 The two entry points into the scheduler

1. **`scheduleCallback(priority, callback)`** — the only way the
   reconciler adds work to the scheduler. Called from
   `ReactFiberRootScheduler.js:500–503` as the main production path:

   ```js
   const newCallbackNode = scheduleCallback(
     schedulerPriorityLevel,
     performWorkOnRootViaSchedulerTask.bind(null, root),
   );

   root.callbackPriority = newCallbackPriority;
   root.callbackNode = newCallbackNode;
   ```

2. **`cancelCallback(task)`** — tombstones an existing scheduler Task
   when the reconciler decides it's stale.

### 15.2 `scheduleCallback` call sites

| File | Line | Priority | Trigger |
|---|---|---|---|
| `ReactFiberRootScheduler.js` | 487 | `UserBlockingSchedulerPriority` | Discrete/continuous input events |
| `ReactFiberRootScheduler.js` | 490 | `NormalSchedulerPriority` | `DefaultEventPriority` — standard render |
| `ReactFiberRootScheduler.js` | 493 | `IdleSchedulerPriority` | `IdleEventPriority` — idle-lane work |
| `ReactFiberRootScheduler.js` | 496 | `NormalSchedulerPriority` | Default fallback |
| `ReactFiberRootScheduler.js` | 500–503 | (chosen above) | Main `scheduleCallback(priority, performWorkOnRootViaSchedulerTask.bind(null, root))` |
| `ReactFiberRootScheduler.js` | 680–683 | `ImmediateSchedulerPriority` | Safari workaround (microtask in Render/Commit context) |
| `ReactFiberRootScheduler.js` | 690–693 | `ImmediateSchedulerPriority` | Fallback when `supportsMicrotasks` false |
| `ReactFiberWorkLoop.js` | ~3784 | `NormalSchedulerPriority` | `flushPassiveEffects` (legacy) |
| `ReactFiberWorkLoop.js` | ~4401 | `IdleSchedulerPriority` | `schedulePostPaintCallback` — transition callbacks |
| `ReactFiberWorkLoop.js` | ~4808 | `IdleSchedulerPriority` | Second copy of transition callbacks |
| `ReactFiberCacheComponent.js` | 114 | `NormalPriority` | `cache.controller.abort()` on refCount=0 |

### 15.3 `performWorkOnRootViaSchedulerTask` sequence diagram

The task body from `ReactFiberRootScheduler.js:513–606` in precise
order:

```
Scheduler.workLoop invokes callback(didTimeout)
  ├─ callback = performWorkOnRootViaSchedulerTask.bind(null, root)
  └─ enters:
       1. trackSchedulerEvent() (profiling)
       2. hasPendingCommitEffects()?
            true  → root.callbackNode = null; return null
       3. originalCallbackNode = root.callbackNode
       4. flushPendingEffectsDelayed()
            true  → if root.callbackNode !== originalCallbackNode: return null
       5. lanes = getNextLanes(root, ...)
            NoLanes → return null
       6. forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout
       7. performWorkOnRoot(root, lanes, forceSync)
            ├─ shouldTimeSlice = !forceSync && !includesBlockingLane && !includesExpiredLane || isPrerendering
            ├─ shouldTimeSlice? renderRootConcurrent : renderRootSync
            └─ if RootInProgress: break (yield)
               else: finishConcurrentRender → commitRoot
       8. scheduleTaskForRootDuringMicrotask(root, now())
            ├─ markStarvedLanesAsExpired
            ├─ recomputes nextLanes
            └─ either leaves root.callbackNode in place, or
               cancels it and schedules a new task with a different priority
       9. if root.callbackNode != null && root.callbackNode === originalCallbackNode:
             return performWorkOnRootViaSchedulerTask.bind(null, root)   // continuation
          else:
             return null                                                  // done or priority changed
```

The return value is what Scheduler's `workLoop` line 212 receives as
`continuationCallback`. If function → stored back at line 218. If
null → completion branch at line 225.

### 15.4 The `workInProgressRoot` identity check

Inside `renderRootConcurrent` at line 2785:

```js
if (workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes) {
  ...
  prepareFreshStack(root, lanes);
} else {
  // This is a continuation of an existing work-in-progress.
  workInProgressRootIsPrerendering = checkIfRootIsPrerendering(root, lanes);
}
```

This decides whether to **resume** a previous render or **restart**.
Resume happens when all of (root, lanes) match the stashed
`workInProgressRoot` and `workInProgressRootRenderLanes`. Restart
happens otherwise.

Because `workInProgressRoot` is a reconciler-level module global, not
associated with the scheduler Task, it **survives** through the
scheduler's continuation mechanism and is only reset by
`prepareFreshStack` or by completion.

### 15.5 `workLoopConcurrentByScheduler` — fiber-level yield poll

`ReactFiberWorkLoop.js:3051–3057`:

```js
function workLoopConcurrentByScheduler() {
  // Perform work until Scheduler asks us to yield
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}
```

Each iteration processes one fiber. `shouldYield()` is the re-exported
`shouldYieldToHost` from the scheduler — the same function called from
the scheduler's own `workLoop` (line 194). Both sides check the same
`startTime`/`frameInterval` globals.

This means **the reconciler's fiber loop and the scheduler's task loop
are gated by the same clock and the same budget**. When the 5 ms slice
is up, both loops exit promptly:
- `workLoopConcurrentByScheduler` exits with `workInProgress !== null`.
- `renderRootConcurrent` returns `RootInProgress`.
- `performWorkOnRoot` breaks at line 1193.
- `performWorkOnRootViaSchedulerTask` returns a continuation bind.
- Scheduler stores the bind at line 218 and `return true`s.
- Outer pump re-posts the next macrotask.

### 15.6 `root.callbackNode` as the Scheduler Task handle

`root.callbackNode` is the Scheduler Task opaque handle stored on the
FiberRoot. Because continuations mutate the existing Task in place
rather than pushing a new one, this reference is **stable across all
slices of the same logical render**.

Lifecycle:
- **Schedule time:** `root.callbackNode = newCallbackNode;` (line 506).
- **Inside a slice:** `currentTask === root.callbackNode` is true while
  the render slice is running (both point to the same allocation).
- **End-of-slice identity check:** `root.callbackNode != null &&
  root.callbackNode === originalCallbackNode` tells
  `performWorkOnRootViaSchedulerTask` whether the currently-executing
  task is still "the right task" for this root's current priority.
- **Priority change:** `cancelCallback(existingCallbackNode);` (line
  477) tombstones the old task, then a new `scheduleCallback` produces
  a new `root.callbackNode`.
- **Completion:** `root.callbackNode = null;` (lines 436, 538).

### 15.7 `didTimeout` → `forceSync` bridge

The scheduler's `workLoop` computes `didUserCallbackTimeout` at line
207:

```js
const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
```

It passes this as the first argument to the callback at line 212:

```js
const continuationCallback = callback(didUserCallbackTimeout);
```

The reconciler's `performWorkOnRootViaSchedulerTask` receives it as
`didTimeout` and uses it to compute `forceSync`:

```js
const forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout;
performWorkOnRoot(root, lanes, forceSync);
```

When `forceSync` is true:
- `shouldTimeSlice` becomes false in `performWorkOnRoot`.
- `renderRootSync` is called instead of `renderRootConcurrent`.
- `workLoopSync` is used instead of `workLoopConcurrentByScheduler`.
- No `shouldYield()` polling.
- Render runs to completion in one slice.

This is how starvation bypass works at the reconciler layer, and how
the two-layer expiration system composes (§13.4).

Note the `disableSchedulerTimeoutInWorkLoop` guard. The comment at
`ReactFiberRootScheduler.js:586–590`:

> // TODO: We only check `didTimeout` defensively, to account for a Scheduler
> // bug we're still investigating. Once the bug in Scheduler is fixed,
> // we can remove this, since we track expiration ourselves.

The reconciler has its own expiration tracking
(`includesExpiredLane`), so in theory `didTimeout` is redundant.

### 15.8 Sync work bypasses the scheduler

See §4.5. Sync lane work (`includesSyncLane(nextLanes)`) is flushed
inline via microtask in `processRootScheduleInMicrotask`
(`ReactFiberRootScheduler.js:339–341`):

```js
if (!hasPendingCommitEffects()) {
  flushSyncWorkAcrossRoots_impl(syncTransitionLanes, false);
}
```

This calls `performSyncWorkOnRoot` directly, which calls
`performWorkOnRoot(root, lanes, true /* forceSync */)`. The scheduler
heap is never touched. Only concurrent work enters the scheduler.

### 15.9 Microtask scheduling via `scheduleImmediateRootScheduleTask`

`ReactFiberRootScheduler.js:650–695`:

```js
function scheduleImmediateRootScheduleTask() {
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    ReactSharedInternals.actQueue.push(() => {
      processRootScheduleInMicrotask();
      return null;
    });
  }

  if (supportsMicrotasks) {
    scheduleMicrotask(() => {
      // In Safari, appending an iframe forces microtasks to run.
      // We don't support running callbacks in the middle of render
      // or commit so we need to check against that.
      const executionContext = getExecutionContext();
      if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
        // Intentionally using a macrotask instead of a microtask here.
        Scheduler_scheduleCallback(
          ImmediateSchedulerPriority,
          processRootScheduleInImmediateTask,
        );
        return;
      }
      processRootScheduleInMicrotask();
    });
  } else {
    // If microtasks are not supported, use Scheduler.
    Scheduler_scheduleCallback(
      ImmediateSchedulerPriority,
      processRootScheduleInImmediateTask,
    );
  }
}
```

This is where the **rare** uses of `ImmediateSchedulerPriority` in
modern React come from — both are fallbacks:
- **Safari iframe workaround:** when `supportsMicrotasks` is true but
  we're inside a Render or Commit context (Safari forces microtasks to
  run inside those contexts, which is incorrect). Fall back to
  `ImmediateSchedulerPriority` macrotask.
- **`supportsMicrotasks` false:** e.g. older react-native environments
  without microtask support.

In normal browsers, this path is a microtask, not a scheduler task.

---

## 16. Non-obvious gotchas (exhaustive)

1. **`maxSigned31BitInt = 1073741823 = 2^30 - 1`, not `2^31 - 1`.** The
   "31 bit" name refers to V8's SMI tagging on 32-bit systems. Idle
   timeout is ~12.4259 days, not ~24.86 days.

2. **`{delay: 0}` is not a delay.** Strict `> 0` check at line 337
   falls through to `startTime = currentTime`.

3. **`NoPriority = 0` is a sentinel.** Not a valid argument to
   `scheduleCallback`. Falls through to `NormalPriority` via the
   `default` arm.

4. **`LowPriority` is dead weight in the reconciler.** Defined,
   exported, has its own `case` arm — but zero production call sites.

5. **`sortIndex` is the heap key but means different things per
   queue.** `startTime` in `timerQueue`, `expirationTime` in
   `taskQueue`. The rewrite happens in `advanceTimers` at line 113,
   **after** `pop` removes the task from `timerQueue` and **before**
   the `push` into `taskQueue`.

6. **`currentTask` is module-level.** Written at lines 191 and 240.
   Reset to `null` only in `flushWork`'s `finally` at line 178. The
   profiling error tap at line 164 reads it from a catch block where
   it would not be in scope as a local.

7. **The pre-invocation tombstone at line 203 MUST run before line
   212.** `currentTask.callback = null` **before** `callback(...)`. If
   reversed, a throwing task would be re-invoked infinitely across
   slices. Combined with the self-healing pump, this is why errors
   don't loop.

8. **Continuation yield bypasses `shouldYieldToHost` entirely.**
   Comment at lines 215–216: "regardless of how much time is left in
   the current time slice." The callback is trusted.

9. **`currentTime = getCurrentTime()` at line 213 is crucial.** Without
   this refresh, the `advanceTimers(currentTime)` call at line 223
   would use a stale clock and miss timers that fired during the
   callback.

10. **Continuation stores on the same Task object.** `sortIndex`,
    `expirationTime`, `id`, and physical heap position are unchanged.
    `siftUp`/`siftDown` not triggered. Reference identity of
    `root.callbackNode` is preserved across slices.

11. **`isHostTimeoutScheduled` is NOT set at line 138.** In
    `handleTimeout`'s re-arm path, `requestHostTimeout` is called
    without setting the flag. Its effect: a subsequent
    `scheduleCallback` taking the earlier-timer branch sees
    `isHostTimeoutScheduled === false` at line 391, enters the `else`
    at line 394, sets the flag true, and arms a new timeout —
    orphaning the one from line 138. The orphaned timeout fires
    harmlessly because `handleTimeout` is idempotent (it re-reads the
    heap and re-decides from scratch).

12. **Defensive completion pop guard at line 232.** `if (currentTask
    === peek(taskQueue))` exists because the user callback may have
    scheduled a more urgent task that's now the root. Leaving the old
    task with `callback = null` creates a deferred tombstone.

13. **Cancellation is lazy.** `task.callback = null` is the entire
    operation. The task stays in the heap until it bubbles to the
    root.

14. **`performWorkUntilDeadline` initializes `hasMoreWork = true`
    BEFORE the try.** This is the self-healing trick: a thrown
    `flushWork` leaves `hasMoreWork` at its initial `true`, so the
    `finally` re-schedules the pump even though the assignment never
    ran.

15. **No `try/catch` around `callback()` at line 212.** Errors
    propagate out of `workLoop`, through `flushWork`, out of
    `performWorkUntilDeadline`, into the browser's top-level error
    handler. The scheduler self-restarts via `hasMoreWork`.

16. **`frameInterval` default (5 ms) is tighter than `forceFrameRate`'s
    ceiling (125 fps → 8 ms).** `forceFrameRate` cannot make yielding
    tighter than 8 ms because its input is capped at 125 fps.

17. **`Math.floor(1000 / 125) = 8`.** Frame rates higher than 125 would
    round the interval to zero or smaller, so the API refuses.

18. **`console['error']` bracket notation at line 471** — deliberate
    way to evade Babel / ESLint rewrites that warn on console calls.

19. **Native reference capture uses `typeof X !== 'undefined'`, not
    `globalThis.X`.** Portable across all hosts; doesn't throw
    `ReferenceError` on missing globals; pins references at init time
    before any polyfill can run.

20. **`MessageChannel` is preferred over `setTimeout(fn, 0)`** because
    of the HTML spec 4 ms clamping after 5 levels of nesting. A rapid
    scheduling loop would take a ~4 ms dead tax per tick otherwise.

21. **`setImmediate` is preferred over `MessageChannel` in Node**
    because `MessageChannel` keeps the Node process alive (issue
    facebook/react#20756). It also fires earlier in Node's event loop
    phases. Captured even when MessageChannel is available.

22. **`startTime` (module-level) ≠ `Task.startTime`.** The module
    variable is the per-slice anchor written inside
    `performWorkUntilDeadline` at line 493; the Task field is the
    earliest time a delayed task is allowed to run. They have
    completely different semantics.

23. **`currentPriorityLevel` leaks between tasks within a single
    `workLoop`.** Line 205 sets it per-task, but the change is not
    unwound between tasks. A higher-priority task running before a
    lower-priority one could leak its priority through
    `unstable_getCurrentPriorityLevel` reads *between* iterations.
    `flushWork`'s finally at line 179 only restores at the end of the
    whole slice. In practice this is fine because tasks rarely query
    the priority outside their own callback.

24. **There is no `cancelHostCallback`.** Only `cancelHostTimeout`.
    Once a MessageChannel message is posted, it fires; the effective
    "cancel" is flipping `isMessageLoopRunning = false` so the pump
    bails on entry at line 489.

25. **`unstable_next` never promotes**, only demotes. Low/Idle
    priorities pass through; Immediate/UserBlocking/Normal all shift
    to Normal.

26. **`unstable_wrapCallback` captures priority at wrap time**, not
    invocation time. Useful for "remember my priority for later async
    callbacks".

27. **`enableAlwaysYieldScheduler` has THREE code changes**: skip
    top-of-loop check (line 193), add bottom-of-loop check (line 241),
    short-circuit `needsPaint` (line 448).

28. **`performWorkOnRoot` uses `forceSync = didTimeout`** to switch
    from time-sliced to sync rendering when the scheduler reports the
    task expired. This is the reconciler's side of starvation bypass.

29. **`root.callbackNode` identity depends on the Scheduler's in-place
    mutation invariant.** If the Scheduler ever allocated a new Task
    on continuation instead of mutating, React's identity check at
    `ReactFiberRootScheduler.js:600` would silently break — either
    missing continuations or scheduling duplicates.

30. **The `needsPaint` flag crosses exactly one frame boundary.** Set
    during a callback (line 464), read on the next yield check (line
    448), cleared at the start of the slice *after* yielding (line
    487). This guarantees at least one browser paint opportunity
    between set and clear.

31. **`SyncLane` work never reaches the scheduler heap.** It flushes
    via microtask in `processRootScheduleInMicrotask`
    (`ReactFiberRootScheduler.js:339–341`). Only concurrent work
    enters the scheduler.

32. **Click events ≠ SyncLane ≠ Immediate scheduler priority.** A
    click that runs through the concurrent scheduler path maps to
    `UserBlockingSchedulerPriority` (250 ms timeout), not Immediate.
    If it's a sync-lane click, it bypasses the scheduler entirely.

33. **The `workLoop` entry calls `advanceTimers` at line 190.** This
    ensures that even if a delayed task has been sitting in the
    timerQueue with an already-fired `startTime`, it gets promoted
    before the first `peek(taskQueue)` at line 191.

34. **`flushWork` cancels any armed host timeout at lines 151–155** as
    a pre-flush cleanup. Reason: `workLoop`'s `advanceTimers` will
    handle promotion; the armed timeout is now redundant. Saves a
    spurious `handleTimeout` fire.

35. **`handleTimeout` and `performWorkUntilDeadline` are the two
    "entry points" into a new slice of work.** Both eventually call
    `advanceTimers` and then either run the work loop (pump) or
    re-arm the host timeout (timeout-only). They share the heap state
    but use different host primitives.

36. **Two pumps, not one.** The host callback pump
    (`performWorkUntilDeadline` via MessageChannel/setImmediate/setTimeout)
    is **separate** from the host timeout pump (`handleTimeout` via
    `setTimeout`). Diagrams that draw one "host pump" miss this
    distinction.

37. **`taskIdCounter` starts at 1, not 0.** Line 83. So task IDs begin
    at 1. Not load-bearing for anything — just the convention.

38. **`Callback = boolean => ?Callback` is a recursive type.** Each
    slice returns either the next slice's function or a non-function.
    The scheduler never "knows" the total number of slices.

39. **`workLoop` returns `true` from two physically different
    lines** (224 and 250) but the semantic difference is absorbed by
    `flushWork`'s caller, which only reads the boolean.

40. **`advanceTimers` uses strict `<=` for startTime comparison** at
    line 110. A timer with `startTime === currentTime` fires
    immediately, not next slice. This matches the `peek`-then-promote
    invariant.

---

## 17. Quick-reference tables

### 17.1 Every function in `Scheduler.js`

| Function | Lines | Summary |
|---|---|---|
| `getCurrentTime` (perf.now branch) | 66 | High-res clock |
| `getCurrentTime` (Date.now branch) | 70 | Fallback clock |
| `advanceTimers` | 103–125 | Promote fired timers to taskQueue |
| `handleTimeout` | 127–142 | Host timeout fires → promote + pump |
| `flushWork` | 144–186 | Flush with state save/restore; optional profiling tap |
| `workLoop` | 188–258 | Main drain loop |
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

### 17.2 `SchedulerMinHeap.js`

| Function | Lines | Summary |
|---|---|---|
| `push` | 17–21 | Append + siftUp |
| `peek` | 23–25 | Read root in O(1) |
| `pop` | 27–40 | Extract minimum |
| `siftUp` | 42–57 | Bubble up toward root |
| `siftDown` | 59–89 | Bubble down toward leaves |
| `compare` | 91–95 | `sortIndex` primary, `id` tiebreaker |

### 17.3 `SchedulerPriorities.js`

| Constant | Line | Value |
|---|---|---|
| `NoPriority` | 13 | 0 |
| `ImmediatePriority` | 14 | 1 |
| `UserBlockingPriority` | 15 | 2 |
| `NormalPriority` | 16 | 3 |
| `LowPriority` | 17 | 4 |
| `IdlePriority` | 18 | 5 |

### 17.4 `SchedulerFeatureFlags.js` (production)

| Flag | Line | Default |
|---|---|---|
| `enableProfiling` | 10 | `false` |
| `frameYieldMs` | 11 | `5` |
| `userBlockingPriorityTimeout` | 13 | `250` |
| `normalPriorityTimeout` | 14 | `5000` |
| `lowPriorityTimeout` | 15 | `10000` |
| `enableRequestPaint` | 16 | `true` |
| `enableAlwaysYieldScheduler` | 18 | `__EXPERIMENTAL__` |

### 17.5 Priority table (complete)

| Priority | Const val | Timeout (ms) | `expirationTime @ t=0` | Times out after | Reconciler usage |
|---|---|---|---|---|---|
| `NoPriority` | 0 | N/A (sentinel) | N/A | N/A | Never — coerced to Normal |
| `ImmediatePriority` | 1 | `-1` | `-1` | Instantly | Safari fallback only |
| `UserBlockingPriority` | 2 | `250` | `250` | 250 ms | Discrete/continuous input |
| `NormalPriority` | 3 | `5000` | `5000` | 5 s | Default render, passive effects |
| `LowPriority` | 4 | `10000` | `10000` | 10 s | None in production |
| `IdlePriority` | 5 | `1073741823` | `1073741823` | ~12.43 days | Idle lanes, post-paint transitions |

### 17.6 State-change table

| Event | What changes | Lines |
|---|---|---|
| `scheduleCallback(immediate)` | push(taskQueue), maybe `isHostCallbackScheduled=true` | 402, 410 |
| `scheduleCallback(delayed)` | push(timerQueue), maybe arm host timeout | 388, 391–398 |
| `performWorkUntilDeadline` entry | `needsPaint=false`, `startTime=now` | 487, 493 |
| `flushWork` entry | `isHostCallbackScheduled=false`, cancel host timeout, `isPerformingWork=true` | 150, 153–154, 157 |
| `workLoop` task invocation | `currentTask.callback=null`, `currentPriorityLevel=task.priorityLevel` | 203, 205 |
| `workLoop` continuation | `currentTask.callback=continuation`, `advanceTimers`, return true | 218, 223, 224 |
| `workLoop` completion | conditional `pop(taskQueue)`, `advanceTimers` | 233, 235 |
| `workLoop` cancelled | `pop(taskQueue)` | 238 |
| `flushWork` finally | `currentTask=null`, restore `currentPriorityLevel`, `isPerformingWork=false` | 178–180 |
| `performWorkUntilDeadline` finally | reschedule or `isMessageLoopRunning=false` | 508, 510 |
| `cancelCallback` | `task.callback=null` | 430 |
| `requestPaint` | `needsPaint=true` (if flag) | 464 |
| `forceFrameRate` | `frameInterval = floor(1000/fps)` or reset | 478, 481 |
| `handleTimeout` entry | `isHostTimeoutScheduled=false`, `advanceTimers` | 128–129 |
| `requestHostTimeout` | `taskTimeoutID = setTimeout(...)` | 561 |
| `cancelHostTimeout` | `clearTimeout`, `taskTimeoutID=-1` | 568–569 |

### 17.7 Reconciler entry-point reference

| File | Line | Function / Purpose |
|---|---|---|
| `ReactFiberRootScheduler.js` | 116 | `ensureRootIsScheduled` |
| `ReactFiberRootScheduler.js` | 154 | `ensureScheduleIsScheduled` |
| `ReactFiberRootScheduler.js` | 259 | `processRootScheduleInMicrotask` |
| `ReactFiberRootScheduler.js` | 384 | `scheduleTaskForRootDuringMicrotask` |
| `ReactFiberRootScheduler.js` | 500–503 | Main `scheduleCallback(priority, performWorkOnRootViaSchedulerTask.bind(null, root))` |
| `ReactFiberRootScheduler.js` | 513 | `performWorkOnRootViaSchedulerTask` definition |
| `ReactFiberRootScheduler.js` | 589 | `forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout` |
| `ReactFiberRootScheduler.js` | 599 | `scheduleTaskForRootDuringMicrotask(root, now())` at end of task |
| `ReactFiberRootScheduler.js` | 600 | `root.callbackNode === originalCallbackNode` identity check |
| `ReactFiberRootScheduler.js` | 603 | `return performWorkOnRootViaSchedulerTask.bind(null, root)` |
| `ReactFiberRootScheduler.js` | 608 | `performSyncWorkOnRoot` |
| `ReactFiberRootScheduler.js` | 650 | `scheduleImmediateRootScheduleTask` |
| `ReactFiberWorkLoop.js` | 1122 | `performWorkOnRoot` |
| `ReactFiberWorkLoop.js` | 1153 | `shouldTimeSlice` computation |
| `ReactFiberWorkLoop.js` | 1164–1166 | `renderRootConcurrent` vs `renderRootSync` switch |
| `ReactFiberWorkLoop.js` | 2001 | `prepareFreshStack` |
| `ReactFiberWorkLoop.js` | 2601 | `renderRootSync` |
| `ReactFiberWorkLoop.js` | 2757 | `renderRootConcurrent` |
| `ReactFiberWorkLoop.js` | 2785 | `prepareFreshStack` call for root/lane mismatch |
| `ReactFiberWorkLoop.js` | 2787 | `// This is a continuation of an existing work-in-progress.` |
| `ReactFiberWorkLoop.js` | 2991 | `workLoopSync` (act fallback) |
| `ReactFiberWorkLoop.js` | 2993 | `workLoopConcurrent` (throttled variant) |
| `ReactFiberWorkLoop.js` | 2995 | `workLoopConcurrentByScheduler` (default) |
| `ReactFiberWorkLoop.js` | 2998–3000 | `catch(thrownValue) { handleThrow(root, thrownValue); }` |
| `ReactFiberWorkLoop.js` | 3034 | `workLoopConcurrent` body |
| `ReactFiberWorkLoop.js` | 3051 | `workLoopConcurrentByScheduler` body |
| `ReactFiberWorkLoop.js` | 3059 | `performUnitOfWork` |

---

## Appendix A: Execution trace — transition preempted by click

Scenario: a `startTransition` render has been running for ~3 slices,
then a button click lands.

**State before the click (inside slice 3, t ≈ 10 ms):**
- `taskQueue` = `[T_transition]` with
  `{id:1, sortIndex:5000, expirationTime:5000, callback: performWorkOnRootViaSchedulerTask.bind(null, root)}`.
- `root.callbackNode === T_transition`.
- `workInProgress` cursor inside the reconciler points to some fiber.
- `currentTask = T_transition`.
- `currentPriorityLevel = NormalPriority`.
- `startTime = 10` (module-level).
- `isMessageLoopRunning = true`.
- `isPerformingWork = true`.
- `isHostCallbackScheduled = false` (cleared at flushWork entry).

**Slice 3 yield (t ≈ 15 ms):**
1. Inside `workLoopConcurrentByScheduler`, `shouldYield()` returns true
   (`timeElapsed = 15 - 10 = 5 >= frameInterval`).
2. The inner `while` exits with `workInProgress !== null`.
3. `renderRootConcurrent` returns `RootInProgress`.
4. `performWorkOnRoot` breaks at line 1193.
5. `performWorkOnRootViaSchedulerTask` calls
   `scheduleTaskForRootDuringMicrotask(root, now())`. Priority hasn't
   changed; `root.callbackNode` stays the same.
6. Identity check: `root.callbackNode === originalCallbackNode` → true.
7. Returns `performWorkOnRootViaSchedulerTask.bind(null, root)`.
8. Back in scheduler `workLoop`:
   - Line 218: `T_transition.callback = <new bound continuation>`.
   - Line 223: `advanceTimers(currentTime)`.
   - Line 224: `return true`.
9. `flushWork` finally: `currentTask = null`, restore priority,
   `isPerformingWork = false`.
10. `performWorkUntilDeadline` finally: `hasMoreWork = true` →
    `schedulePerformWorkUntilDeadline()` posts message #4.
11. `isHostCallbackScheduled` is still false (was cleared at flushWork
    entry); `isMessageLoopRunning` is still true.

**Browser processes native events (t ≈ 15 ms, microtask gap):**
1. Click event fires.
2. React's event system synthesizes the event, runs event handlers.
3. Event handler calls `setState`, which schedules an update on
   `root`.
4. `ensureRootIsScheduled(root)` → `ensureScheduleIsScheduled()` → if
   not already, `queueMicrotask(processRootScheduleInMicrotask)`.
5. Microtask runs before the next macrotask: `processRootScheduleInMicrotask`
   → `scheduleTaskForRootDuringMicrotask(root, now())`.
6. `getNextLanes` now returns `InputContinuousLane` (a blocking lane).
7. `lanesToEventPriority` → `ContinuousEventPriority` →
   `UserBlockingSchedulerPriority`.
8. Priority changed from Normal to UserBlocking.
   `existingCallbackNode = T_transition`, `existingCallbackPriority !==
   newCallbackPriority`, so:
   - `cancelCallback(T_transition)` → sets `T_transition.callback = null`.
   - `scheduleCallback(UserBlockingSchedulerPriority, performWorkOnRootViaSchedulerTask.bind(null, root))`.
   - New task `T_click` created with
     `{id:2, sortIndex:~250, expirationTime:~250, callback: <new bound>}`.
   - `push(taskQueue, T_click)`. `siftUp` bubbles it to position 0
     because `sortIndex=250 < 5000`.
   - `root.callbackNode = T_click`; `root.callbackPriority = InputContinuousLane`.

**State between messages (t ≈ 15.5 ms):**
- `taskQueue` root is now `T_click`.
- `T_transition` is still in the heap at position 1 (say), with
  `callback = null`.
- `isHostCallbackScheduled = true` (set during the scheduleCallback
  call? No — the `!isPerformingWork` guard matters here. We were not
  inside performing work at that moment, so the scheduleCallback branch
  at line 409 saw `!isPerformingWork === true` and set the flag.)
  Actually: during the microtask, `isPerformingWork === false` because
  `flushWork`'s finally already cleared it. So the immediate branch
  fires `requestHostCallback()`, which is idempotent (`isMessageLoopRunning`
  already true). No additional message; message #4 is still pending.

**Slice 4 fires (t ≈ 16 ms, message #4):**
1. `performWorkUntilDeadline` fires.
2. `needsPaint = false`; `isMessageLoopRunning === true`.
3. `startTime = 16`.
4. `hasMoreWork = true`; try `flushWork(16)`.
5. `flushWork`: `isHostCallbackScheduled = false`; no host timeout to
   cancel; `isPerformingWork = true`; `previousPriorityLevel = Normal`
   (as set at flushWork entry).
6. `workLoop(16)`:
   - `advanceTimers(16)` — no timers.
   - `currentTask = peek(taskQueue)` → **T_click**, not T_transition.
   - Yield check: `T_click.expirationTime = 250 > 16` and
     `shouldYield()` returns false (just started slice) → don't break.
   - `callback = T_click.callback` → the bound `performWorkOnRootViaSchedulerTask`.
   - `T_click.callback = null` (tombstone).
   - `currentPriorityLevel = UserBlockingPriority`.
   - `didUserCallbackTimeout = 250 <= 16` → false.
   - Invoke `callback(false)`.
7. Inside `performWorkOnRootViaSchedulerTask`:
   - `originalCallbackNode = root.callbackNode = T_click`.
   - `getNextLanes` → includes the click's input-continuous lane.
   - `forceSync = false`.
   - `performWorkOnRoot(root, lanes, false)`.
   - Inside `performWorkOnRoot`:
     - `includesBlockingLane(lanes) === true` (InputContinuousLane is
       blocking). `shouldTimeSlice = false`.
     - `renderRootSync(root, lanes, true)`.
     - Inside `renderRootSync`: check `workInProgressRoot === root &&
       workInProgressRootRenderLanes === lanes` — **NO**, the lanes
       don't match (transition was Normal; click is InputContinuous).
     - `prepareFreshStack(root, lanes)` — **RESTART**. The partial
       transition WIP tree is discarded. A new WIP tree is built from
       `root.current`.
     - `workLoopSync` runs to completion — no yielding.
     - Commit synchronously.
   - Back in `performWorkOnRootViaSchedulerTask`:
     `scheduleTaskForRootDuringMicrotask` — the click is done, but the
     transition still has pending lanes → schedules a new task for the
     transition at `NormalPriority`.
     - This cancels `T_click` (tombstones its callback, but `T_click`'s
       callback is already `null` from the tombstone at step 6).
     - Creates `T_transition_2` with fresh `{id:3, sortIndex:5000+,
       ...}`.
     - `root.callbackNode = T_transition_2`.
   - Identity check: `root.callbackNode (T_transition_2) !==
     originalCallbackNode (T_click)` → **false**.
   - Return `null`.
8. Back in scheduler `workLoop`:
   - `continuationCallback = null`.
   - Completion branch at line 225.
   - `currentTask === peek(taskQueue)?` → `T_click` is still at the
     root (we haven't popped anything yet). So pop it.
   - `advanceTimers(currentTime)`.
9. Next iteration: `currentTask = peek(taskQueue)`. The heap now
   contains `T_transition` (dead, from step 6 of the microtask) and
   `T_transition_2` (fresh). Which is at the root?
   - `T_transition` has `sortIndex=5000, id=1, callback=null`.
   - `T_transition_2` has `sortIndex=5000+, id=3, callback=bound`.
   - Tie on `sortIndex`? Only if the new one happens to have the same
     timeout numbers. Assume slightly different. `T_transition`'s
     `sortIndex` is slightly smaller → it's at the root.
10. Next iteration:
    - Yield check. Assume budget is used up (slice 4 was long) →
      `break`.
    - `return true`.

**Further slices:**
- Slice 5 `peek` → dead `T_transition` (callback=null) → cancelled
  branch pops it.
- Slice 5 `peek` → `T_transition_2`. Resume transition from scratch
  (`prepareFreshStack` already ran when the click clobbered the globals
  via `renderRootSync`; now `workInProgressRoot` is null again, so the
  next `renderRootConcurrent` will call `prepareFreshStack` again).

**Invariants preserved throughout:**
- Heap keys (`sortIndex`) never inconsistent with heap structure.
- Every `callback = null` is eventually swept by either `advanceTimers`
  (timerQueue) or the workLoop cancelled branch (taskQueue).
- `root.callbackNode` is always either `null` or the currently valid
  Scheduler Task for this root.
- `currentTask`/`isPerformingWork`/`currentPriorityLevel` are always
  restored by `flushWork`'s finally, no matter how the inner flow
  unwinds.

---

## Appendix B: Execution trace — throwing task with self-healing

Scenario: a user scheduled a task that throws. Two more tasks behind it.

**Initial state:**
- `taskQueue = [T1 (throws), T2, T3]` with increasing IDs.
- `isMessageLoopRunning = true`; message pending.

**Slice begins (t = 0):**
1. `performWorkUntilDeadline`: `needsPaint = false`, `startTime = 0`,
   `hasMoreWork = true`, `try { flushWork(0) }`.
2. `flushWork(0)`: `isHostCallbackScheduled = false`, no host timeout,
   `isPerformingWork = true`, `previousPriorityLevel = currentPriorityLevel`.
3. `workLoop(0)`: `advanceTimers`, `currentTask = peek(taskQueue) =
   T1`.
4. Yield check: not expired, shouldYield false → proceed.
5. `callback = T1.callback`. **Tombstone:** `T1.callback = null`.
6. `currentPriorityLevel = T1.priorityLevel`.
7. Line 212: `const continuationCallback = callback(false);`
8. **Throw inside callback.** Exception propagates:
   - Line 213 (clock refresh) does NOT run.
   - Continuation check does NOT run.
   - Completion pop does NOT run.
9. Exception propagates out of `workLoop` — no try/catch at line 212.
10. **In `flushWork`:**
    - Production path: no inner try/catch; exception propagates.
    - Profiling path: inner catch runs `markTaskErrored(currentTask,
      getCurrentTime())`, sets `currentTask.isQueued = false`, then
      `throw error;` re-throws.
    - Outer finally runs: `currentTask = null`, restore
      `currentPriorityLevel`, `isPerformingWork = false`.
11. **In `performWorkUntilDeadline`:**
    - Exception escaped the try.
    - `hasMoreWork` never got reassigned — still the initial `true`.
    - `finally` runs: `hasMoreWork === true` →
      `schedulePerformWorkUntilDeadline()` posts next message.
12. Exception propagates out of `performWorkUntilDeadline` → out of
    the macrotask → into `window.onerror` / DevTools.

**Next slice:**
1. Message fires. `performWorkUntilDeadline` runs fresh.
2. `workLoop`: `peek(taskQueue)` → T1 is still at the root.
3. `callback = T1.callback = null` (tombstoned at step 5 of previous slice).
4. `typeof callback === 'function'` → false.
5. Cancelled branch at line 238: `pop(taskQueue)`. T1 is gone.
6. Loop continues with T2 at the root. It runs normally.
7. T3 runs.
8. Heap drains. `workLoop` returns false.
9. `performWorkUntilDeadline` finally: `hasMoreWork === false` →
   `isMessageLoopRunning = false`.

**Result:** T1 threw, its error was observed in `window.onerror`, T2
and T3 still ran normally, the scheduler did not re-invoke T1, and the
pump ended cleanly. The self-healing properties are:
- Tombstone at line 203 runs **before** invocation → throwing task is
  dead on arrival.
- `hasMoreWork = true` initialized **before** try → pump reschedules
  on throw.
- No `try/catch` around `callback()` → error is visible.
- `flushWork` finally → module state restored.

---

## Appendix C: Execution trace — delayed task wake-up via `handleTimeout`

Scenario: user calls `scheduleCallback(NormalPriority, cb, {delay: 100})`
at `t = 0`, with no ready work in the heap.

**Schedule time (t = 0):**
1. `unstable_scheduleCallback(Normal, cb, {delay: 100})`.
2. `currentTime = 0`.
3. `delay = 100 > 0` → `startTime = 100`.
4. `timeout = 5000` (Normal).
5. `expirationTime = 100 + 5000 = 5100`.
6. Task `T = {id:1, sortIndex:-1, startTime:100, expirationTime:5100}`.
7. `startTime (100) > currentTime (0)` → delayed branch.
8. `T.sortIndex = 100`. `push(timerQueue, T)`.
9. `peek(taskQueue) === null` (empty) AND `T === peek(timerQueue)` (T
   is the earliest timer) → arm host timeout.
10. `isHostTimeoutScheduled === false` → set it true.
11. `requestHostTimeout(handleTimeout, 100 - 0 = 100)`.
12. `taskTimeoutID = setTimeout(() => handleTimeout(getCurrentTime()), 100)`.
13. Return T to caller.

**No activity for 100 ms.** Meanwhile no `performWorkUntilDeadline` is
running because `requestHostCallback` was never called (there's no
ready work).

**`handleTimeout` fires (t = 100):**
1. The setTimeout callback runs: `handleTimeout(getCurrentTime())` —
   approx `handleTimeout(100)`.
2. Line 128: `isHostTimeoutScheduled = false`.
3. Line 129: `advanceTimers(100)`:
   - `peek(timerQueue)` → T. `T.callback` is not null.
   - `T.startTime (100) <= currentTime (100)` → fire.
   - `pop(timerQueue)`. `T.sortIndex = T.expirationTime = 5100`.
   - `push(taskQueue, T)`.
   - `peek(timerQueue) === null`.
4. Line 131: `!isHostCallbackScheduled` → enter inner block.
5. Line 132: `peek(taskQueue) !== null` (it's T) → schedule host
   callback.
6. `isHostCallbackScheduled = true`.
7. `requestHostCallback()`:
   - `!isMessageLoopRunning` → `isMessageLoopRunning = true`,
     `schedulePerformWorkUntilDeadline()` posts message.
8. `handleTimeout` returns.

**`performWorkUntilDeadline` fires (t ≈ 100):**
1. `needsPaint = false`, `startTime = 100`, `hasMoreWork = true`.
2. `flushWork(100)`:
   - `isHostCallbackScheduled = false`.
   - No host timeout armed.
   - `isPerformingWork = true`.
3. `workLoop(100)`:
   - `advanceTimers(100)` — no more timers.
   - `currentTask = peek(taskQueue) = T`.
   - Yield check: `T.expirationTime = 5100 > 100` and
     `shouldYield() === false` → proceed.
   - Tombstone, invoke `cb(false)`.
   - `cb` returns null.
   - Completion branch: `currentTask === peek(taskQueue)` → pop T.
   - Next iteration: heap empty → exit while.
   - Line 252: `firstTimer = peek(timerQueue)` → null. No host timeout
     to arm.
   - Return `false`.
4. `flushWork` returns false.
5. `performWorkUntilDeadline` finally: `hasMoreWork = false` →
   `isMessageLoopRunning = false`. Pump dormant.

**Summary:**
- One real `setTimeout` call (at schedule time).
- One `handleTimeout` fire (at wake time).
- One `performWorkUntilDeadline` fire (via `requestHostCallback`).
- Heap holds exactly one task, briefly.
- `taskTimeoutID` returned to `-1` by the implicit completion (the
  setTimeout fired, the ID is stale but no explicit reset happens in
  `handleTimeout` — only in `cancelHostTimeout`).

---

## Appendix D: Subtle ordering constraints (summary)

These are the ordering rules that must hold for the scheduler to be
correct. Each is justified in the body; collected here for reference.

| Rule | Lines | Why |
|---|---|---|
| `currentTask.callback = null` **before** `callback(...)` | 203, 212 | Throwing task tombstoned on arrival; no re-invocation loop. |
| `currentTime = getCurrentTime()` **after** `callback(...)` | 213 | Subsequent `advanceTimers` must use fresh clock. |
| `advanceTimers(currentTime)` **before** `return true` on continuation | 223, 224 | Promote timers that fired during the callback. |
| `currentTask = peek(taskQueue)` **after** completion/cancellation pop | 240 | Refresh pointer for yield check on next iteration. |
| `advanceTimers(currentTime)` at `workLoop` **entry** | 190 | Promote timers before first `peek(taskQueue)`. |
| `sortIndex` rewrite **between** `pop(timerQueue)` and `push(taskQueue)` | 112–114 | No heap ever holds a node with the wrong key. |
| `isHostCallbackScheduled = false` at `flushWork` entry | 150 | We are the host callback; new work needs a new message. |
| `cancelHostTimeout` at `flushWork` entry if armed | 153–154 | `workLoop`'s `advanceTimers` will handle promotion; avoid redundant fire. |
| `isPerformingWork = true` **before** `workLoop` call | 157 | Re-entrance guard in `scheduleCallback` must see it. |
| `isPerformingWork = false` in `flushWork` finally | 180 | Outside of work, new scheduleCallback must start the pump. |
| `let hasMoreWork = true;` **before** the try | 501 | Self-healing on throw: rescheduling happens from the initial value. |
| `needsPaint = false` at **top** of `performWorkUntilDeadline` | 487 | Clears **after** yielding — paint opportunity already had. |
| `startTime = currentTime` at top of `performWorkUntilDeadline` | 493 | Per-slice anchor fresh for every new macrotask. |
| `isHostTimeoutScheduled = false` at `handleTimeout` entry | 128 | Avoid double-clearing if scheduleCallback runs during advanceTimers. |
| `isHostTimeoutScheduled` stays true across cancel+re-arm in `scheduleCallback` delayed branch | 391–398 | The flag is a logical "a timeout exists for us"; cancel+re-arm doesn't change that. |
| Yield check uses `expirationTime > currentTime && shouldYieldToHost()` | 194 | Both conjuncts: expired tasks bypass yield entirely (starvation escape). |

---

## Appendix E: Where each `unstable_*` export is used by the reconciler

Quick cross-reference for which scheduler exports the reconciler
actually consumes.

| Export | Used by reconciler? | Where |
|---|---|---|
| `unstable_ImmediatePriority` | Yes, rarely | `ReactFiberRootScheduler.js:56, 680, 690` (Safari fallbacks) |
| `unstable_UserBlockingPriority` | **Yes, heavily** | `ReactFiberRootScheduler.js:487` (discrete/continuous events) |
| `unstable_NormalPriority` | **Yes, heavily** | `ReactFiberRootScheduler.js:490, 496` (default render); `ReactFiberCacheComponent.js:114` (cache abort) |
| `unstable_IdlePriority` | Yes | `ReactFiberRootScheduler.js:493` (idle lanes); `ReactFiberWorkLoop.js:~4401, ~4808` (post-paint transitions) |
| `unstable_LowPriority` | **No** | Dead weight. |
| `unstable_runWithPriority` | Yes, in tests and some internals | Not in hot path. |
| `unstable_next` | No direct use | — |
| `unstable_scheduleCallback` | **Yes, the main entry** | `ReactFiberRootScheduler.js:500–503`, others |
| `unstable_cancelCallback` | **Yes** | `ReactFiberRootScheduler.js:434, 452, 477` (priority changes) |
| `unstable_wrapCallback` | Yes, occasionally | `ReactFiberAsyncAction` wraps transition callbacks |
| `unstable_getCurrentPriorityLevel` | Yes | Various bookkeeping |
| `unstable_shouldYield` (`shouldYield`) | **Yes, every fiber** | `workLoopConcurrentByScheduler` (`ReactFiberWorkLoop.js:3053`) |
| `unstable_requestPaint` | Yes | After commit to hint a paint is needed |
| `unstable_now` (`now`) | **Yes, constantly** | Timestamps, `scheduleTaskForRootDuringMicrotask`, throttled work loop |
| `unstable_forceFrameRate` | No | User-facing API, not used internally |
| `unstable_Profiling` | No | Only in DevTools path |

---
