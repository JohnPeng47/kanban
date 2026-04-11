# 08 — Preemption: How a High-Priority Task Interrupts a Low-Priority One

**Primary files**
- `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js` (598 lines)
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberWorkLoop.js` (5621 lines)
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberRootScheduler.js` (737 lines)
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactEventPriorities.js`
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerFeatureFlags.js`
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberLane.js`

---

## 0. The thesis

React's scheduler does **not** preempt. It cannot reach into a running JavaScript
callback and rip control away from it. JavaScript is single-threaded, and once
a callback is executing on the main thread it runs uninterrupted until it
returns. What React calls "preemption" is actually a tight **cooperative yield
loop + heap re-root**:

1. A long-running render periodically asks the scheduler "should I yield?".
2. When it yields, it returns a continuation function and hands control back to
   the event loop.
3. While React was running, a higher-priority task may have been pushed onto
   the scheduler's heap. Because the heap is a min-heap keyed on
   `sortIndex = expirationTime`, the new higher-priority task becomes the new
   root.
4. When the scheduler's next macrotask fires (`performWorkUntilDeadline`), it
   calls `peek(taskQueue)` and picks up the NEW task — not the continuation.
5. The old transition task still sits in the heap with its stashed
   continuation. It runs later, after the urgent task drains.

So at the scheduler level "preemption" is a lie you tell yourself. At the
reconciler level there is a second, distinct concept — "restart" — which is
`prepareFreshStack` throwing away the work-in-progress fiber tree and starting
the transition over from scratch when urgent state has changed underneath it.

These two concepts (scheduler-level cooperative interruption, reconciler-level
restart) are easy to conflate. This document keeps them strictly separate.

---

## 1. Why true preemption is impossible on the main thread

Every task in the scheduler ultimately runs as the callback of a single
MessageChannel message (`performWorkUntilDeadline` at Scheduler.js:485). While
that message's JavaScript is executing:

- The event loop cannot dispatch any other task.
- No other `postMessage` handler, `setTimeout`, click handler, or microtask
  can run on this thread.
- The scheduler itself cannot "notice" that a higher-priority task has
  appeared, because the code doing the noticing is not running.

The only way another task can start running is for the current JS stack to
fully unwind back to the event loop. React's trick is that during long work,
it unwinds *voluntarily* at safe checkpoints, re-reads the heap, and lets the
event loop decide what runs next.

---

## 2. The cooperative yield mechanism (Scheduler side)

### 2.1 `shouldYieldToHost` — Scheduler.js:447

```js
function shouldYieldToHost(): boolean {
  if (!enableAlwaysYieldScheduler && enableRequestPaint && needsPaint) {
    return true;
  }
  const timeElapsed = getCurrentTime() - startTime;
  if (timeElapsed < frameInterval) {
    return false;
  }
  return true;
}
```

`startTime` is re-initialized at the top of `performWorkUntilDeadline`
(Scheduler.js:493) each time a new message is processed. `frameInterval`
defaults to `frameYieldMs = 5` (SchedulerFeatureFlags.js:11). So the rule is
roughly "if you've been running user code for ≥ 5ms in this macrotask, yield".

Two important notes:

- `shouldYieldToHost` is re-exported from Scheduler.js as `unstable_shouldYield`,
  which the reconciler imports as `shouldYield()` and calls from its
  concurrent work loop. The scheduler and the reconciler **share one clock**.
- `requestPaint` (`needsPaint = true`) forces an unconditional yield on the
  next check. React doesn't widely use this by default, but the hook exists so
  browser hints about a pending frame paint can short-circuit time slicing.

### 2.2 The scheduler `workLoop` — Scheduler.js:188

Key lines (annotated):

```js
function workLoop(initialTime: number) {
  let currentTime = initialTime;
  advanceTimers(currentTime);
  currentTask = peek(taskQueue);                          // (A) heap root
  while (currentTask !== null) {
    if (!enableAlwaysYieldScheduler) {
      if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
        break;                                            // (B) yield
      }
    }
    const callback = currentTask.callback;
    if (typeof callback === 'function') {
      currentTask.callback = null;                        // (C) mark live
      currentPriorityLevel = currentTask.priorityLevel;
      const didUserCallbackTimeout =
        currentTask.expirationTime <= currentTime;
      const continuationCallback = callback(didUserCallbackTimeout);
      currentTime = getCurrentTime();
      if (typeof continuationCallback === 'function') {
        currentTask.callback = continuationCallback;      // (D) stash
        advanceTimers(currentTime);
        return true;                                      // (E) yield now
      } else {
        if (currentTask === peek(taskQueue)) {
          pop(taskQueue);                                 // (F) completed
        }
        advanceTimers(currentTime);
      }
    } else {
      pop(taskQueue);                                     // (G) cancelled
    }
    currentTask = peek(taskQueue);                        // (H) re-peek
    if (enableAlwaysYieldScheduler) {
      if (currentTask === null || currentTask.expirationTime > currentTime) {
        break;
      }
    }
  }
  if (currentTask !== null) {
    return true;
  } else {
    ...
    return false;
  }
}
```

The two load-bearing facts for preemption:

**Fact 1 (yield via continuation is total).** At (D) and (E), when a callback
returns another function, the scheduler treats that as "the task is not done;
yield immediately to the host regardless of how much frame budget is left".
This is the reconciler's only signal that it wants to come back later without
losing its place.

**Fact 2 (heap is re-peeked after each task).** At (H) the scheduler re-reads
`peek(taskQueue)`. If during (callback) a new task was pushed (e.g. from a
click handler that ran synchronously inside the React work, or more realistically,
from an earlier macrotask while we were between slices), the next iteration
will see the new root. But this only helps within a single `workLoop` call —
and during a continuation-yield at (E), we bail out entirely anyway.

### 2.3 Where the re-root actually happens — between macrotasks

The interesting re-root is not inside a single `workLoop` call. It's the
transition between macrotasks in `performWorkUntilDeadline`
(Scheduler.js:485):

```js
const performWorkUntilDeadline = () => {
  if (enableRequestPaint) { needsPaint = false; }
  if (isMessageLoopRunning) {
    const currentTime = getCurrentTime();
    startTime = currentTime;                   // reset yield clock
    let hasMoreWork = true;
    try {
      hasMoreWork = flushWork(currentTime);    // runs workLoop
    } finally {
      if (hasMoreWork) {
        schedulePerformWorkUntilDeadline();    // post next message
      } else {
        isMessageLoopRunning = false;
      }
    }
  }
};
```

When `flushWork` returns `true` (because `workLoop` either broke on
`shouldYieldToHost` at (B) or returned `true` at (E)), the scheduler posts a
fresh message via `schedulePerformWorkUntilDeadline`. That message goes to the
back of the browser's task queue. The browser is then free to process:

1. Any native input events that arrived while we were running React.
2. Paint.
3. Microtasks.
4. Other timers.

If any of those steps call `scheduleCallback(UserBlocking, …)` — which
handling a click does — a new task gets pushed into `taskQueue` **before** the
scheduler's next macrotask runs. When `performWorkUntilDeadline` finally fires
again, `workLoop` calls `peek(taskQueue)` at (A) and picks the new root. The
old transition task, whose continuation is still stored on its `callback`
field, is now sitting somewhere deeper in the heap.

That is the entire "preemption" mechanism. No preemption API, no interrupts,
no `cancel current task and resume later` — just a heap whose root changed
between two message events.

---

## 3. `scheduleCallback` — how a new task gets pushed and becomes the root

```js
function unstable_scheduleCallback(priorityLevel, callback, options?) {
  var currentTime = getCurrentTime();
  ...
  var timeout;
  switch (priorityLevel) {
    case ImmediatePriority:     timeout = -1; break;
    case UserBlockingPriority:  timeout = userBlockingPriorityTimeout; break;  // 250
    case IdlePriority:          timeout = maxSigned31BitInt; break;
    case LowPriority:           timeout = lowPriorityTimeout; break;           // 10000
    case NormalPriority:
    default:                    timeout = normalPriorityTimeout; break;        // 5000
  }
  var expirationTime = startTime + timeout;
  var newTask = {
    id: taskIdCounter++, callback, priorityLevel,
    startTime, expirationTime, sortIndex: -1,
  };
  ...
  newTask.sortIndex = expirationTime;
  push(taskQueue, newTask);
  if (!isHostCallbackScheduled && !isPerformingWork) {
    isHostCallbackScheduled = true;
    requestHostCallback();
  }
  return newTask;
}
```

Defaults (SchedulerFeatureFlags.js):

```
userBlockingPriorityTimeout = 250
normalPriorityTimeout       = 5000
lowPriorityTimeout          = 10000
```

For our scenario, the transition render was scheduled with
`NormalSchedulerPriority`, so its task carries
`expirationTime ≈ startTime + 5000` and therefore `sortIndex ≈ 5000+startTime`.
The click, scheduled with `UserBlockingSchedulerPriority` a few hundred ms
later, gets `expirationTime ≈ newStartTime + 250`. Because that absolute value
is much smaller than the transition's, `siftUp` inside `SchedulerMinHeap.push`
lifts the new node to become the new heap root.

**Critically**: the new task is pushed whether or not React is currently
running. The comment at line 407 reads: "Schedule a host callback, if needed.
If we're already performing work, wait until the next time we yield." The
`!isPerformingWork` guard means if React is mid-slice, we do not post another
`MessageChannel` message — we rely on the fact that React will yield shortly
anyway and the already-scheduled next message will re-pick the heap root.

---

## 4. The reconciler side of the yield loop

### 4.1 `workLoopConcurrentByScheduler` — ReactFiberWorkLoop.js:3051

```js
function workLoopConcurrentByScheduler() {
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}
```

This is the closest thing the reconciler has to the scheduler's `workLoop`.
Each iteration is one fiber. `shouldYield()` is imported from the Scheduler
package and is the same `shouldYieldToHost` shown above.

The alternative `workLoopConcurrent(nonIdle)` (ReactFiberWorkLoop.js:3034)
exists when `enableThrottledScheduling` is on; it uses a fixed 25ms slice for
non-idle transition work and 5ms for idle. Purpose: intentionally cap
transition work to ~30fps so that animations at 60fps on the main thread are
not starved by big transitions.

### 4.2 Returning a continuation from the reconciler

When `renderRootConcurrent` returns with `workInProgress !== null`, the exit
status is `RootInProgress` (ReactFiberWorkLoop.js:3014) and `performWorkOnRoot`
falls through to the end where it calls `ensureRootIsScheduled(root)`. The
scheduler task itself is `performWorkOnRootViaSchedulerTask`
(ReactFiberRootScheduler.js:513). At the bottom of that function:

```js
scheduleTaskForRootDuringMicrotask(root, now());
if (root.callbackNode != null && root.callbackNode === originalCallbackNode) {
  // The task node scheduled for this root is the same one that's
  // currently executed. Need to return a continuation.
  return performWorkOnRootViaSchedulerTask.bind(null, root);
}
return null;
```

So the reconciler's way of saying "please come back" to the scheduler is
literally to return its own function. That flows back into
`Scheduler.workLoop` at the continuation-detect branch:

```js
if (typeof continuationCallback === 'function') {
  currentTask.callback = continuationCallback;
  ...
  return true;
}
```

The task's `callback` is replaced with the new bound function, and `workLoop`
returns `true` immediately — triggering another `MessageChannel` round trip
before any more React work happens. **This is the gap during which a new
higher-priority task can be pushed.**

### 4.3 The test at line 600: did somebody change my task while I was running?

```js
if (root.callbackNode != null && root.callbackNode === originalCallbackNode) {
  // return a continuation
  return performWorkOnRootViaSchedulerTask.bind(null, root);
}
return null;
```

If while we were rendering, something called `ensureRootIsScheduled`, which
called `scheduleTaskForRootDuringMicrotask`, which saw that the priority had
changed and called `cancelCallback(existingCallbackNode)` + `scheduleCallback`
with a new priority, then `root.callbackNode` points at a **different** task
object now. Returning a continuation is then pointless — we'd be continuing
the wrong task. Instead we return `null`, which lets the scheduler pop and
discard the current task, and the new task (pointed to by `root.callbackNode`)
will be picked up on the next slice.

This is another form of "preemption at the reconciler level": the reconciler
gave up its own continuation because the root already had a higher-priority
task scheduled.

---

## 5. `unstable_cancelCallback` and the lazy tombstone pattern

### 5.1 The API — Scheduler.js:418

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

Two facts to internalize:

1. **Cancellation is lazy.** `task.callback = null` is the entire cancel
   operation. The task object stays in the heap. It will be stepped over later
   when it happens to float to the root.
2. **This is necessary because the heap only supports removing the root.**
   `SchedulerMinHeap.pop` only returns the smallest element; there is no
   `remove(node)`. Re-heapifying arbitrary removal would be O(n) per cancel,
   which is intolerable when the reconciler cancels and re-schedules on every
   click.

### 5.2 Where the corpse is actually swept — Scheduler.js:237-238

```js
} else {
  pop(taskQueue);
}
currentTask = peek(taskQueue);
```

When `workLoop` peeks at a task and finds `callback === null`, it enters the
`else` branch and `pop`s the task, which also re-heapifies (siftDown in
`SchedulerMinHeap.pop`). Then it peeks again and continues. Canceled tasks
cost nothing until the scheduler walks past them.

### 5.3 Why the reconciler holds the task handle — `root.callbackNode`

The reconciler stores `root.callbackNode = newCallbackNode` at
ReactFiberRootScheduler.js:506 immediately after scheduling. This is the
scheduler's opaque `Task` object handle. It is kept on the fiber root so that
later — when priorities change or the root becomes idle — the reconciler can
call `cancelCallback(root.callbackNode)` and null out *that specific* task's
callback.

Without this handle, there'd be no way to find the old task to cancel. The
heap is keyed by `sortIndex`, not by identity, and the reconciler doesn't know
where in the heap its old task sits. Stashing the handle on the root gives
O(1) cancellation of the stale render task.

### 5.4 Call sites — `cancelCallback(existingCallbackNode)` in ReactFiberRootScheduler.js

```
line 434: root has no more work at all → cancel existing task
line 452: sync work path (sync work flushes inline, no scheduler task needed)
line 477: priority changed, cancel old task so we can schedule a new one
```

The line 477 case is the interesting one for preemption. Inside
`scheduleTaskForRootDuringMicrotask`:

```js
const existingCallbackPriority = root.callbackPriority;
const newCallbackPriority = getHighestPriorityLane(nextLanes);
if (newCallbackPriority === existingCallbackPriority && …) {
  return newCallbackPriority;               // reuse existing
} else {
  cancelCallback(existingCallbackNode);     // downgrade or upgrade
}
...
const newCallbackNode = scheduleCallback(schedulerPriorityLevel, …);
root.callbackPriority = newCallbackPriority;
root.callbackNode = newCallbackNode;
```

**Key property**: the reconciler does not re-use the old scheduler task when
priority changes. It nulls out the old one (tombstone) and schedules a fresh
task with the correct priority. The old task stays in the heap until it
floats to the root, at which point `workLoop`'s `else` branch pops it
harmlessly.

---

## 6. Lane priorities → Event priorities → Scheduler priorities

Three separate priority systems, layered:

```
Lane (bit in bitfield)
  → EventPriority (coarser bucket; also a Lane, but one of four)
    → SchedulerPriority (integer 1..5 from SchedulerPriorities.js)
```

### 6.1 `lanesToEventPriority` — ReactEventPriorities.js:55

```js
export const DiscreteEventPriority: EventPriority = SyncLane;
export const ContinuousEventPriority: EventPriority = InputContinuousLane;
export const DefaultEventPriority: EventPriority = DefaultLane;
export const IdleEventPriority: EventPriority = IdleLane;

export function lanesToEventPriority(lanes: Lanes): EventPriority {
  const lane = getHighestPriorityLane(lanes);
  if (!isHigherEventPriority(DiscreteEventPriority, lane)) {
    return DiscreteEventPriority;
  }
  if (!isHigherEventPriority(ContinuousEventPriority, lane)) {
    return ContinuousEventPriority;
  }
  if (includesNonIdleWork(lane)) {
    return DefaultEventPriority;
  }
  return IdleEventPriority;
}
```

### 6.2 EventPriority → SchedulerPriority — ReactFiberRootScheduler.js:481

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

So a click event (which dispatches at `DiscreteEventPriority` = `SyncLane`) ends
up as `UserBlockingSchedulerPriority` in the scheduler, whose timeout is 250ms
and whose expirationTime will therefore be drastically smaller than a
`NormalSchedulerPriority` transition's 5000ms expirationTime. That's how the
heap comparison actually works out "click beats transition".

Note: this is also where the scheduler's `ImmediatePriority` (timeout = -1)
becomes unreachable via the Lane → Event → Scheduler pipeline in concurrent
mode — the highest priority the reconciler ever requests from the scheduler
is `UserBlocking`. `SyncLane` work is flushed inline via microtask
(ReactFiberRootScheduler.js:442-456) without ever going through the scheduler
heap.

---

## 7. Scheduler-level interruption vs. reconciler-level restart

These are two different things that both get called "preemption". Pulling them
apart:

### 7.1 Scheduler-level interruption (cooperative)

- **Trigger**: `shouldYield()` returns true during
  `workLoopConcurrentByScheduler`, or the throttling timer in
  `workLoopConcurrent` elapses.
- **Effect**: `renderRootConcurrent` returns `RootInProgress`. The reconciler's
  scheduler task returns a continuation. The scheduler's `workLoop` posts the
  next `MessageChannel` message and unwinds. Event loop processes pending
  input. If that input schedules a higher-priority task, the NEXT scheduler
  tick peeks that task as the heap root.
- **State preserved**: the entire work-in-progress fiber tree, the
  `workInProgress` pointer, and all module-level variables in
  ReactFiberWorkLoop.js (render lanes, skipped lanes, suspended reason,
  etc.). The transition is paused exactly where it was.
- **What the reconciler calls it**: a *yield*.

### 7.2 Reconciler-level restart (destructive)

- **Trigger**: inside `scheduleUpdateOnFiber`
  (ReactFiberWorkLoop.js:972) or `performWorkOnRoot` / `renderRootConcurrent`
  when `workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes`.
- **Effect**: `prepareFreshStack(root, lanes)` is called
  (ReactFiberWorkLoop.js:2001). The work-in-progress fiber tree is thrown
  away: `resetWorkInProgressStack()` is called, a fresh
  `createWorkInProgress(root.current, null)` builds a new root WIP fiber, all
  workInProgressRoot* module variables are reset to their initial values
  (NoLanes, NotSuspended, null, etc).
- **State preserved**: the `root.current` fiber tree (the committed tree) is
  untouched. Nothing user-visible is affected. The in-flight render is fully
  discarded.
- **What the reconciler calls it**: a *restart* / *interrupt*.

The sentence "transitions are interruptible" is really saying: when an urgent
update lands on a root that's mid-transition, that transition's WIP tree is
thrown out and rebuilt from the committed `current` tree. Because render is
side-effect-free, throwing out the WIP tree is free — no DOM has been touched,
no refs attached, no effects fired.

### 7.3 Where restart gets triggered from `scheduleUpdateOnFiber`

```js
if (
  (root === workInProgressRoot &&
    (workInProgressSuspendedReason === SuspendedOnData ||
     workInProgressSuspendedReason === SuspendedOnAction)) ||
  root.cancelPendingCommit !== null
) {
  // The incoming update might unblock the current render. Interrupt the
  // current attempt and restart from the top.
  prepareFreshStack(root, NoLanes);
  ...
}
```

This specific code path calls `prepareFreshStack(root, NoLanes)` explicitly
when a new update arrives while the current render is suspended on I/O. The
more common path is implicit: `performWorkOnRoot` is called next with a
different lane set, `renderRootConcurrent` notices
`workInProgressRootRenderLanes !== lanes`, and calls `prepareFreshStack`
itself at line 2785. The practical effect is identical.

---

## 8. Starvation prevention: expired tasks cannot yield

Two defenses live side-by-side, one at each level.

### 8.1 Scheduler level — Scheduler.js:193

```js
if (!enableAlwaysYieldScheduler) {
  if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
    break;
  }
}
```

The `expirationTime > currentTime` guard means: "only consider yielding if the
task hasn't expired yet". Once the clock passes the task's expirationTime,
this `if` is false and the scheduler refuses to yield — `shouldYieldToHost` is
never even consulted. The task now runs to completion in one burst. Combined
with the timeout table:

```
Immediate:    -1       → expires instantly, runs now
UserBlocking: 250ms    → after quarter second starved, becomes non-yielding
Normal:       5000ms   → after 5 seconds starved, becomes non-yielding
Low:          10000ms  → after 10 seconds starved, becomes non-yielding
Idle:         2^30-1   → effectively never expires
```

### 8.2 Reconciler level — `markStarvedLanesAsExpired` + `includesExpiredLane`

`markStarvedLanesAsExpired` (ReactFiberLane.js:541) walks `root.pendingLanes`
and for any lane whose stored expiration timestamp has passed, sets it into
`root.expiredLanes`. That call happens at the top of
`scheduleTaskForRootDuringMicrotask` (ReactFiberRootScheduler.js:397):

```js
markStarvedLanesAsExpired(root, currentTime);
```

Later, in `performWorkOnRoot` (ReactFiberWorkLoop.js:1153):

```js
const shouldTimeSlice =
  (!forceSync &&
    !includesBlockingLane(lanes) &&
    !includesExpiredLane(root, lanes)) ||
  checkIfRootIsPrerendering(root, lanes);
```

If the lanes being worked on contain any expired lane, `shouldTimeSlice` is
false, and instead of `renderRootConcurrent` the reconciler calls
`renderRootSync` (line 1166). Sync rendering does not consult `shouldYield` —
it runs through `workLoopSync` at line 2750 and renders to completion in one
slice.

The two guards compose correctly: the reconciler bypasses its own yield loop
**and** the scheduler is doubly guaranteed not to yield because the task's
expirationTime has already passed.

---

## 9. `enableAlwaysYieldScheduler` — the experimental opposite

Guarded by `__EXPERIMENTAL__` in SchedulerFeatureFlags.js:18. It flips the
yielding strategy upside down. Two code changes, both in Scheduler.js:

**Top of loop (Scheduler.js:193)** — skipped:

```js
if (!enableAlwaysYieldScheduler) {
  if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
    break;
  }
}
```

**Bottom of loop (Scheduler.js:241)** — added:

```js
if (enableAlwaysYieldScheduler) {
  if (currentTask === null || currentTask.expirationTime > currentTime) {
    break;
  }
}
```

Semantically: "run exactly one task that is either the first one or a
successor that has already expired, then yield unconditionally". The frame
budget check is removed; yielding is now decided per-task instead of per-5ms.

Rationale (see tests in `scheduler/src/__tests__/Scheduler-test.js`): on
devices with native frame-aligned scheduling (e.g. `postTask` or a native
fork), the `frameYieldMs` heuristic is redundant and suboptimal — yielding
after every task gives the host a chance to interleave paints and input more
finely. The cost is throughput: more task-switching overhead. It's gated on
experimental because the tradeoff depends on the host.

`shouldYieldToHost` is also short-circuited in this mode: the `needsPaint`
check at Scheduler.js:448 is gated on `!enableAlwaysYieldScheduler`, because
always-yielding already covers that case.

---

## 10. Execution trace: user clicks in the middle of a transition render

Setup:
- App is idle. User types into a search box wrapped in `startTransition`.
- React schedules a transition render at `NormalSchedulerPriority`. Let's say
  the render will walk 40,000 fibers and take ~40ms of CPU.
- Before it finishes, the user clicks a "Cancel" button unrelated to the
  search.

### Timeline

```
t = 0      keystroke handler runs synchronously
           startTransition(() => setQuery("abc"))
             → scheduleUpdateOnFiber(root, fiber, TransitionLane)
             → markRootUpdated(root, TransitionLane)
             → ensureRootIsScheduled(root)
             → (microtask) scheduleTaskForRootDuringMicrotask
             → scheduleCallback(NormalSchedulerPriority, perfWorkOnRoot)
             → push(taskQueue, T_transition)
                 T_transition = {
                   id: 1,
                   callback: performWorkOnRootViaSchedulerTask,
                   priorityLevel: NormalSchedulerPriority,
                   startTime: 0,
                   expirationTime: 5000,
                   sortIndex: 5000,
                 }
             → root.callbackNode = T_transition
             → root.callbackPriority = TransitionLane
             → requestHostCallback() posts MessageChannel message #1

HEAP STATE:
    taskQueue = [ T_transition(sortIndex=5000) ]
    (T_transition is the root.)

t = 1ms    MessageChannel message #1 fires
           performWorkUntilDeadline()
             startTime = 1
             flushWork(1) → workLoop(1)
               peek → T_transition
               T_transition.expirationTime(5000) > 1, shouldYieldToHost()=false
               callback = T_transition.callback
               T_transition.callback = null                   <-- (C)
               continuationCallback = callback(false)
                 = performWorkOnRootViaSchedulerTask(root, false)
                 → renderRootConcurrent(root, TransitionLane)
                 → prepareFreshStack(root, TransitionLane)
                     creates WIP tree from root.current
                 → workLoopConcurrentByScheduler()
                     while workInProgress && !shouldYield()
                       performUnitOfWork(...)
                     ~ walks ~5000 fibers in 5ms
                 → now = 6, shouldYieldToHost() = true
                 → returns, exitStatus = RootInProgress
                 → scheduleTaskForRootDuringMicrotask(root, 6)
                     nothing changed; root.callbackNode unchanged
                 → root.callbackNode === originalCallbackNode (T_transition)
                 → return performWorkOnRootViaSchedulerTask.bind(null, root)
               continuationCallback is a function
               T_transition.callback = continuationCallback   <-- (D)
               return true                                    <-- (E)
             flushWork returns true
             hasMoreWork = true
             schedulePerformWorkUntilDeadline() posts message #2

HEAP STATE:
    taskQueue = [ T_transition(sortIndex=5000, callback=continuation) ]
    workInProgress tree: partially built, ~5000 fibers done out of 40000
    workInProgressRootRenderLanes = TransitionLane

t = 7ms    Browser processes pending input before message #2
           The user clicks "Cancel".
           React event listener (attached at root) fires synchronously.
             dispatchDiscreteEvent → setState(cancel state)
             → scheduleUpdateOnFiber(root, cancelFiber, SyncLane)
             → markRootUpdated(root, SyncLane)
             → ensureRootIsScheduled(root)
             → (microtask) processRootScheduleInMicrotask
             → scheduleTaskForRootDuringMicrotask(root, 7)
                 nextLanes = SyncLane | TransitionLane
                 lanesToEventPriority(nextLanes) = DiscreteEventPriority
                 nextLanes contains SyncLane, but there's no sync flushing here
                 because we're NOT inside a user event handler (we are, via
                 dispatchDiscreteEvent, so actually SyncLane is flushed
                 inline via flushSyncWorkOnAllRoots later in microtask).

           For clarity let's assume instead an onClick that calls setState
           at default priority (Continuous): nextLanes = TransitionLane | ContinuousLane
           lanesToEventPriority → ContinuousEventPriority → UserBlockingSchedulerPriority
           newCallbackPriority = InputContinuousLane
           existingCallbackPriority = TransitionLane
           They differ → cancelCallback(T_transition)
                 T_transition.callback = null    (tombstone)
           → scheduleCallback(UserBlockingSchedulerPriority, performWorkOnRootViaSchedulerTask)
                 T_click = {
                   id: 2,
                   callback: perfWork,
                   priorityLevel: UserBlockingSchedulerPriority,
                   startTime: 7,
                   expirationTime: 7 + 250 = 257,
                   sortIndex: 257,
                 }
                 push(taskQueue, T_click)
                   siftUp: 257 < 5000 → T_click becomes heap root
           → root.callbackNode = T_click
           → root.callbackPriority = InputContinuousLane

HEAP STATE:
    taskQueue = [
      T_click(sortIndex=257, callback=perfWork),
      T_transition(sortIndex=5000, callback=null, TOMBSTONED)
    ]

t = 8ms    MessageChannel message #2 fires
           performWorkUntilDeadline()
             startTime = 8
             flushWork(8) → workLoop(8)
               peek → T_click                <-- HEAP RE-ROOT OBSERVED HERE
               T_click.expirationTime(257) > 8, shouldYieldToHost()=false
               callback = T_click.callback
               T_click.callback = null
               continuationCallback = callback(false)
                 = performWorkOnRootViaSchedulerTask(root, false)
                 → originalCallbackNode = T_click
                 → lanes = getNextLanes(root, ...) includes InputContinuousLane
                 → performWorkOnRoot(root, lanes, forceSync=false)
                   shouldTimeSlice = true
                   renderRootConcurrent(root, InputContinuousLane | TransitionLane)
                     workInProgressRoot === root BUT
                     workInProgressRootRenderLanes(Transition) !== lanes
                     → prepareFreshStack(root, lanes)
                       workInProgress tree THROWN AWAY
                       new WIP built from root.current
                     → workLoopConcurrentByScheduler()
                     → cancel-state render completes in 2ms
                     → commit phase runs
                     → workInProgressRoot = null
                 → lanes drained for UserBlocking priority
                 → scheduleTaskForRootDuringMicrotask(root, 10)
                     remaining pending lane = TransitionLane
                     newCallbackPriority = TransitionLane
                     existingCallbackPriority = InputContinuousLane
                     different → cancelCallback(T_click)      (T_click.callback = null)
                     → scheduleCallback(NormalSchedulerPriority, ...)
                       T_transition2 = new task, sortIndex ≈ 5010
                       push(taskQueue, T_transition2)
                     → root.callbackNode = T_transition2
                 → root.callbackNode !== originalCallbackNode (T_click)
                 → return null     (do not return a continuation)
               continuationCallback is null
               T_click === peek(taskQueue)?
                 peek is now T_transition2 (sortIndex 5010) or T_click itself;
                 depends on which came out lower. T_click is still 257 unless
                 we're past its expirationTime. peek == T_click → pop(T_click)
               advanceTimers, peek again
                 peek → T_transition (sortIndex 5000, tombstoned)
                 T_transition.callback === null → pop (the other else branch)
                 peek → T_transition2 (sortIndex 5010)
                 T_transition2.expirationTime(5010) > 10, shouldYieldToHost() depends
                 if <5ms since startTime(8) → run T_transition2 immediately
                 else → break, schedule another message

HEAP STATE (eventually):
    taskQueue = [ T_transition2(sortIndex=5010) ]
    root.current = tree with Cancel state committed
    workInProgress tree: being built fresh for the transition
```

The tombstoned `T_transition` sits in the heap across two workLoop invocations
and gets cleaned up the first time `workLoop` peeks it and finds
`callback === null`.

### What "preemption" looked like in this trace

Two distinct things happened:

1. **Scheduler heap re-root at t = 8ms.** The old transition's continuation
   was still live on `T_transition.callback` at t = 6ms. Between t = 6ms and
   t = 8ms, the click ran and called `cancelCallback(T_transition)`, nulling
   out that continuation, and pushed `T_click` with a smaller sortIndex. When
   `workLoop` re-entered at t = 8ms, `peek` returned `T_click`, not
   `T_transition`. The transition was "preempted" without the scheduler ever
   knowing that's what happened.
2. **Reconciler WIP restart during `renderRootConcurrent`.** When the click
   task finally asked the reconciler to render, the reconciler compared
   `workInProgressRootRenderLanes` to the new lanes and called
   `prepareFreshStack`. Thousands of fibers of transition work were discarded.
   That's fine because render is side-effect-free: the committed `root.current`
   tree was untouched, and no user-visible state was corrupted.

---

## 11. Why render must be side-effect-free — the load-bearing invariant

Everything above only works because of one fact: when the transition's WIP
fiber tree is thrown away at step (2) of the trace, nothing external to that
tree has changed.

If during `performUnitOfWork` React had:

- Mutated the DOM
- Called a ref callback
- Run a layout or passive effect
- Modified external app state

...then throwing away the WIP tree would be *visible* — the app would have
half-applied side effects with no corresponding committed state. The user
would see a half-updated screen, or a ref would point at a DOM node that no
longer gets cleaned up.

React enforces this by splitting work into two phases, with strict rules:

- **Render phase** (begin/complete work, i.e., everything
  `workLoopConcurrentByScheduler` does): must be pure. No DOM mutations, no
  effects, no ref attachment, no subscription side effects. Hook bodies must
  not mutate their inputs. Strict Mode double-invokes render to catch
  violations.
- **Commit phase** (`commitRoot`): synchronous, single-slice, no yielding, no
  interruption. DOM mutations, refs, layout effects, and flushing passive
  effect queues happen here.

Time slicing and cooperative preemption are *only* available for the render
phase. This is why the reconciler never tries to pause mid-commit — commit is
atomic from the scheduler's perspective. `hasPendingCommitEffects()` checks
(ReactFiberRootScheduler.js:339 and 530) exist to ensure the scheduler doesn't
try to schedule new work on top of a partial commit.

`prepareFreshStack` is the payoff for render purity: because render touched
nothing outside the WIP tree, we can throw the WIP tree away and re-run
render from scratch at any time, as many times as we want, with no
observable difference.

---

## 12. Summary: the two levels of interruption, one more time

| Level            | Trigger                          | Mechanism                                  | State survives?                        |
|------------------|----------------------------------|--------------------------------------------|----------------------------------------|
| Scheduler yield  | `shouldYield()` true             | Return continuation, post new message      | Yes, WIP tree + module vars            |
| Heap re-root     | New higher-prio task pushed      | `peek(taskQueue)` finds different root     | Yes, old task still in heap            |
| Lazy cancel      | `cancelCallback(task)`           | `task.callback = null`; live until popped  | N/A (old task is dead)                 |
| Reconciler restart | `prepareFreshStack(root, lanes)` | New WIP fiber from `root.current`         | No, WIP tree discarded; `current` kept |
| Starvation escape | Expiration time reached         | Scheduler won't yield; reconciler goes sync| Yes, finishes uninterrupted            |

Everything people call "React preemption" is assembled from these five pieces.
None of them involves actually interrupting a running callback mid-execution,
and the pieces work together specifically because the render phase is pure.
