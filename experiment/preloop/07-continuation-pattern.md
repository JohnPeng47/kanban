# 07 — The Continuation Pattern: Cooperative Multitasking via Returned Functions

**Scheduler source:** `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`
**Reconciler sources:**
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberRootScheduler.js`
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberWorkLoop.js`

## Thesis

The Scheduler and the reconciler implement cooperative multitasking through a single, strikingly simple protocol:

> A scheduled callback is invoked with a boolean `didTimeout`. If it is not yet done, it returns a **function** (the "continuation"). The Scheduler stores that function back on the same heap entry and yields. The next macrotask slice peeks the same task and runs the continuation. If the callback is done, it returns `null` (or anything non-function) and the task is popped.

There is no generator, no promise, no coroutine, no saved stack — just "the task returns a function meaning 'call me again later' or returns nothing meaning 'I'm done'". All of the per-pause state lives on React's `FiberRoot` / work-in-progress module-level variables, **not** on the Scheduler's `Task` object.

This doc traces both sides of that contract.

---

## 1. Scheduler side: the continuation branch inside `workLoop`

**Scheduler.js:188-258** defines `workLoop(initialTime)`. Every slice of `performWorkUntilDeadline` (the MessageChannel macrotask driver at line 485) eventually ends up here, and this is the single place where continuations are detected and stored.

### Exact source (Scheduler.js lines 188-247)

```js
function workLoop(initialTime: number) {
  let currentTime = initialTime;
  advanceTimers(currentTime);
  currentTask = peek(taskQueue);
  while (currentTask !== null) {
    if (!enableAlwaysYieldScheduler) {
      if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
        // This currentTask hasn't expired, and we've reached the deadline.
        break;                                                          // (A)
      }
    }
    const callback = currentTask.callback;
    if (typeof callback === 'function') {
      currentTask.callback = null;                                      // (B)
      currentPriorityLevel = currentTask.priorityLevel;
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
      if (enableProfiling) {
        markTaskRun(currentTask, currentTime);
      }
      const continuationCallback = callback(didUserCallbackTimeout);    // (C)
      currentTime = getCurrentTime();                                   // (D)
      if (typeof continuationCallback === 'function') {
        // If a continuation is returned, immediately yield to the main thread
        // regardless of how much time is left in the current time slice.
        currentTask.callback = continuationCallback;                    // (E)
        if (enableProfiling) {
          markTaskYield(currentTask, currentTime);
        }
        advanceTimers(currentTime);                                     // (F)
        return true;                                                    // (G)
      } else {
        if (enableProfiling) {
          markTaskCompleted(currentTask, currentTime);
          currentTask.isQueued = false;
        }
        if (currentTask === peek(taskQueue)) {
          pop(taskQueue);                                               // (H)
        }
        advanceTimers(currentTime);
      }
    } else {
      pop(taskQueue);                                                   // (I)
    }
    currentTask = peek(taskQueue);
    if (enableAlwaysYieldScheduler) {
      if (currentTask === null || currentTask.expirationTime > currentTime) {
        break;
      }
    }
  }
  ...
}
```

The labels above mark the six moments that matter for the continuation protocol:

- **(A) Deadline break** — no continuation involved. The current task is still alive (`callback` is still set), and we simply `break` out. The next slice will re-peek this task and either re-run it or, if it expired, skip the yield check and run it immediately.
- **(B) Callback cleared before invocation** — `currentTask.callback = null`. Critical for correctness: if `callback(didUserCallbackTimeout)` throws, the task becomes a tombstone (callback is null) and will be popped on a later peek. See §11 for the consequences.
- **(C) Synchronous invocation** — the user's callback runs inline, on the Scheduler's stack, inside `workLoop`, inside `flushWork`, inside `performWorkUntilDeadline`, inside a MessageChannel onmessage. No microtask trampoline; control returns to `workLoop` the instant the callback returns.
- **(D) Clock re-read after the callback** — `currentTime = getCurrentTime()`. See §8.
- **(E) Continuation stored back on the same heap entry** — `currentTask.callback = continuationCallback`. The `Task` object's `sortIndex`, `expirationTime`, and its physical position in the min-heap are **unchanged**. The only mutation is the `callback` slot.
- **(F) `advanceTimers(currentTime)`** before yielding. See §9.
- **(G) Early return** — unconditionally `return true` (signalling "more work to do"). The task is **not** popped; it stays at the heap root. Because the scheduler forgets nothing about it — same `id`, same `sortIndex`, same `expirationTime` — the next slice will peek it again and run the function stored in `callback`.
- **(H) Completion path** — `pop(taskQueue)` removes the task. Note the defensive `currentTask === peek(taskQueue)` guard: a user callback can schedule or cancel other tasks, so the previously-peeked reference is not guaranteed to still be the root.
- **(I) Tombstone cleanup** — if `callback` is not a function, the task is cancelled; pop it and move on.

### Key invariant: the heap entry is not re-inserted

When the scheduler stores a continuation at (E), it mutates the existing `Task` object in place. This matters because:

1. The heap's ordering key is `sortIndex`, which equals `startTime` for delayed tasks or `expirationTime` for ready tasks. It is **not** mutated when a continuation is stored, so the heap invariant is automatically preserved: the task is at the root, and it still sorts as whatever-it-did-before. No `siftDown` / `siftUp` is needed.
2. Any other code holding a reference to this `Task` object (for instance, React's `root.callbackNode`) continues to point at the same allocation. This is load-bearing — see §2 and `performWorkOnRootViaSchedulerTask` at ReactFiberRootScheduler.js line 600, which compares `root.callbackNode === originalCallbackNode` to know "is my task still the one that's executing".

## 2. Why the task is *not* popped on continuation

There are three yield behaviours a user callback can produce:

| What the callback returns / does               | What happens to the heap entry           | Line(s)       |
| ----------------------------------------------- | ----------------------------------------- | ------------- |
| Returns a function (a continuation)             | Stays at heap root. `callback` overwritten. `workLoop` returns `true`. | (E), (G)      |
| Returns `null` / `undefined` / non-function     | `pop(taskQueue)` removes it. Loop continues to next task. | (H)           |
| Never yields — deadline expires mid-loop before next task starts | The already-running task has already completed and popped. The *next* task is still in the heap; `workLoop` breaks at the yield check. | (A)           |
| Was cancelled via `unstable_cancelCallback` (sets `callback = null`) before we got to it | Popped and ignored the next time it reaches the top. | (I)           |

The continuation branch is the *only* mechanism by which a single logical task can span multiple browser macrotasks. Without it, every slice of `workLoop` that picked up task X would have to run X to completion — which is exactly what React wants to avoid for large renders.

The reason a continuation keeps the task in the heap rather than re-calling `push(taskQueue, newTask)` is that "push with new task" is:
- slower (a full `siftUp`),
- more memory (new allocation + old task becomes garbage),
- and semantically wrong — React's `root.callbackNode` identity would become stale, breaking the `callbackNode === originalCallbackNode` check in `performWorkOnRootViaSchedulerTask` at line 600.

In-place mutation + `return true` is the minimum viable implementation.

---

## 3. Reconciler side: `performWorkOnRootViaSchedulerTask` is the callback

**ReactFiberRootScheduler.js:500-606.** When React needs to render a root, it calls `scheduleCallback` with:

```js
// ReactFiberRootScheduler.js:500-503
const newCallbackNode = scheduleCallback(
  schedulerPriorityLevel,
  performWorkOnRootViaSchedulerTask.bind(null, root),
);
```

The bound function is the `callback` that Scheduler will invoke at (C) above. Its signature matches `Callback = boolean => ?Callback` from `Scheduler.js:47`:

```js
// ReactFiberRootScheduler.js:511-516
type RenderTaskFn = (didTimeout: boolean) => RenderTaskFn | null;

function performWorkOnRootViaSchedulerTask(
  root: FiberRoot,
  didTimeout: boolean,
): RenderTaskFn | null {
```

Note the type: **it takes `didTimeout: boolean` and returns `RenderTaskFn | null`**. That is precisely the shape the Scheduler expects at line 212 (`callback(didUserCallbackTimeout)`) and line 214 (`typeof continuationCallback === 'function'`).

### The body — the decision to continue

Pulling out the parts directly relevant to continuation (ReactFiberRootScheduler.js:513-606):

```js
function performWorkOnRootViaSchedulerTask(
  root: FiberRoot,
  didTimeout: boolean,
): RenderTaskFn | null {
  ...
  if (hasPendingCommitEffects()) {
    root.callbackNode = null;
    root.callbackPriority = NoLane;
    return null;                                                         // (a)
  }

  const originalCallbackNode = root.callbackNode;                        // (b)
  const didFlushPassiveEffects = flushPendingEffectsDelayed();
  if (didFlushPassiveEffects) {
    if (root.callbackNode !== originalCallbackNode) {
      return null;                                                       // (c)
    }
  }

  ...
  const lanes = getNextLanes(
    root,
    root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes,
    rootHasPendingCommit,
  );
  if (lanes === NoLanes) {
    return null;                                                         // (d)
  }

  const forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout;    // (e)
  performWorkOnRoot(root, lanes, forceSync);                             // (f)

  // The work loop yielded, but there may or may not be work left at the current
  // priority. Need to determine whether we need to schedule a continuation.
  scheduleTaskForRootDuringMicrotask(root, now());                       // (g)
  if (root.callbackNode != null && root.callbackNode === originalCallbackNode) {
    // The task node scheduled for this root is the same one that's
    // currently executed. Need to return a continuation.
    return performWorkOnRootViaSchedulerTask.bind(null, root);           // (h)
  }
  return null;                                                           // (i)
}
```

Step by step:

- **(a)** Fast exit: if there are pending commit effects (e.g. a view transition is committing), bail — return `null`, the Scheduler pops the task. `root.callbackNode` is explicitly nulled so a future update will create a *new* task rather than trying to reuse the current one.
- **(b)** Capture `originalCallbackNode` — this is the Scheduler `Task` object that is currently executing (the one at the heap root that matched this very callback). The comparison at (h) is the whole point of stashing it.
- **(c)** Passive effects flushed inside this invocation may have scheduled a different task on the root. If so, this callback's task is stale — we return `null` so Scheduler pops it, and the other, newer task carries the work forward.
- **(d)** No lanes left to work on: return `null`, task is popped.
- **(e)** **Scheduler timeout fallback.** If Scheduler told us `didTimeout = true`, it means our `expirationTime` was reached; we set `forceSync` to disable time-slicing for the rest of the render (we've already been starved). This is the moment when a task that was supposed to yield cooperatively becomes a "render to completion, no yielding" job.
- **(f)** Runs the actual render — `performWorkOnRoot(root, lanes, forceSync)` at `ReactFiberWorkLoop.js:1122`. That function internally calls `renderRootConcurrent` at line 1165 when `shouldTimeSlice` is true, which in turn runs `workLoopConcurrent` / `workLoopConcurrentByScheduler` at lines 3034/3051. The latter's body is:

  ```js
  // ReactFiberWorkLoop.js:3051-3057
  function workLoopConcurrentByScheduler() {
    // Perform work until Scheduler asks us to yield
    while (workInProgress !== null && !shouldYield()) {
      performUnitOfWork(workInProgress);
    }
  }
  ```

  That's the `shouldYield()` check — it polls the Scheduler (which polls the clock / `needsPaint`) once per fiber. The moment it returns true, the `while` exits with `workInProgress !== null`, meaning "more fibers to process".

  Back in `renderRootConcurrent` at lines 3009-3014:

  ```js
  if (workInProgress !== null) {
    // Still work remaining.
    if (enableSchedulingProfiler) {
      markRenderYielded();
    }
    return RootInProgress;
  }
  ```

  And then `performWorkOnRoot` at line 1171 short-circuits:

  ```js
  if (exitStatus === RootInProgress) {
    // Render phase is still in progress.
    ...
    break;
  }
  ```

  So when the work loop yields, `performWorkOnRoot` returns early, leaving `workInProgress`, `workInProgressRoot`, and `workInProgressRootRenderLanes` all set as module-level state.

- **(g)** Before deciding to continue, React calls `scheduleTaskForRootDuringMicrotask(root, now())` at ReactFiberRootScheduler.js:384. This function re-derives the next lanes, the next priority, and reconciles the root's scheduled task with reality. The key outcome: it either leaves `root.callbackNode` pointing at the same object (meaning "the same task should continue") or it cancels and reassigns (meaning "a different task is now the right one, this one is obsolete"). See §4 for why this is how React makes the decision.
- **(h)** If `root.callbackNode` is still `originalCallbackNode`, **the currently-executing task IS still the right task for the next slice**. Return a fresh bound `performWorkOnRootViaSchedulerTask.bind(null, root)`. Scheduler stores that function at line 218 (`currentTask.callback = continuationCallback`) and yields.
- **(i)** If `root.callbackNode` changed (became `null` or a different task), return `null`. Scheduler pops the old task at line 233; the new task (if any) was already pushed onto the heap by `scheduleTaskForRootDuringMicrotask` and will run on its own schedule.

### What `root.callbackNode` really is

`root.callbackNode` is the Scheduler `Task` opaque handle — the exact same object that Scheduler puts in its `taskQueue` heap and the same object that `workLoop` is currently working on (`currentTask === root.callbackNode` while this invocation is live). That's why the identity check at line 600 works: you're comparing "the task the scheduler is currently running" against "the task the root believes should currently be scheduled". If they're still equal after a render slice, the continuation is trivially correct.

---

## 4. Continuations are *stateless* from the Scheduler's point of view

The Scheduler's entire memory of an in-progress render, from its own perspective, is exactly this:

```
task.callback = performWorkOnRootViaSchedulerTask.bind(null, root)
```

That's it. There is no `partialTree`, no `fiberCursor`, no `workInProgressIndex`. The continuation is a zero-argument-from-the-scheduler function that, when called with `didTimeout`, magically "knows where it left off".

Where is the "where it left off" actually stored?

- **`workInProgress`** (module-level variable in `ReactFiberWorkLoop.js`) — the next fiber to process.
- **`workInProgressRoot`** — the root currently being rendered.
- **`workInProgressRootRenderLanes`** — which lanes are being worked on.
- **`workInProgressSuspendedReason`**, **`workInProgressThrownValue`**, and friends — the suspended state.
- The fiber tree itself — partially-constructed subtree hanging off `root.current.alternate`.

These live entirely inside the reconciler module. The Scheduler has no visibility into any of them and does not care. When the continuation is invoked on the next slice, `renderRootConcurrent` sees:

```js
// ReactFiberWorkLoop.js:2765-2792
if (workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes) {
  ...
  prepareFreshStack(root, lanes);
} else {
  // This is a continuation of an existing work-in-progress.
  workInProgressRootIsPrerendering = checkIfRootIsPrerendering(root, lanes);
}
```

Note the literal comment at line 2787: **"This is a continuation of an existing work-in-progress."** The check `workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes` is the "resume vs restart" branch. If the module-level state still matches what we're being asked to render, skip `prepareFreshStack` and just pick up `workInProgress` where we dropped it.

This is the entire continuation protocol from the reconciler's side: "if the globals still match, resume. Otherwise restart."

## 5. "Yield with continuation" vs "yield without continuation"

Two physically different yielding paths exist in `workLoop`, and they have different semantics:

### Path I — Yield *with* continuation (the thing this doc is about)

1. Task is at heap root with callback `F`.
2. `F` runs. Inside it, React's work loop hits `shouldYield() === true`, bails out of `workLoopConcurrentByScheduler`, `renderRootConcurrent` returns `RootInProgress`, `performWorkOnRoot` returns early.
3. `F` returns `performWorkOnRootViaSchedulerTask.bind(null, root)` (a function).
4. `workLoop` stores it at `currentTask.callback` (line 218) and `return true` (line 224).
5. The heap is unchanged: same task at the root, same `sortIndex`, same `expirationTime`, same `id`, just a freshly-bound function in the `callback` slot.
6. `flushWork` returns `true` to `performWorkUntilDeadline` → `hasMoreWork = true` → `schedulePerformWorkUntilDeadline()` posts another MessageChannel message.
7. The macrotask boundary is crossed. Browser paints, handles input, fires requestAnimationFrame, etc.
8. Next MessageChannel message delivered → `performWorkUntilDeadline` → `flushWork` → `workLoop` → `peek(taskQueue)` returns the same task → runs the continuation at (C).

### Path II — Yield *without* continuation (the "deadline break" at line 196)

1. Task A at heap root, task B with later expirationTime also in heap. A completes (returns null), pops.
2. `currentTask = peek(taskQueue)` → B.
3. Loop iteration checks `B.expirationTime > currentTime && shouldYieldToHost()` → true.
4. `break` out of the loop at line 196.
5. `workLoop` returns `true` (because `currentTask !== null` — B is still there).
6. Same MessageChannel rearm-and-return-later dance.
7. Next slice peeks B and runs it from scratch.

The difference: Path II's task B is not in any partial state because it hasn't started. Path I's task is partially executed, and its per-pause state is stored in the reconciler's module-level variables. Both paths preserve the task in the heap; only Path I overwrites the `callback` slot.

### Single-task comparison

| Aspect                              | Path I (continuation)                 | Path II (deadline break)                         |
| ----------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Same task instance resumed?         | Yes                                   | Yes                                              |
| `callback` slot mutated?            | Yes — overwritten with continuation   | No                                               |
| Was the callback ever invoked?      | Yes (partially)                       | No (it was about to be invoked this slice)       |
| Who pays the "yield" cost?          | The currently-running callback        | The scheduler, before calling anything           |
| How does next slice resume?         | Calls `callback` again — which is the continuation function; reconciler sees globals match and picks up where it stopped | Calls `callback` from scratch |
| Where is partial state stored?      | Reconciler module-level globals       | Nowhere — nothing is partial                     |

---

## 6. Why `currentTime = getCurrentTime()` is re-read at line 213

The callback at line 212 (`callback(didUserCallbackTimeout)`) runs for an unknown and unbounded amount of wall-clock time. Inside it:

- A React render slice could take 5ms.
- It could take 50ms if the host environment's `shouldYield` lies.
- It could take 500ms if the application ignored `shouldYield` (or used `workLoopSync`).
- It could take seconds on a slow device.

If `workLoop` reused the pre-callback value of `currentTime`, any subsequent check — `didUserCallbackTimeout` on the next iteration, the deadline check at line 194, the `advanceTimers(currentTime)` call at line 223 — would operate on a stale clock. In the worst case, `advanceTimers` could fail to promote a timer that fired while the callback was running, leaving a ready task stuck in the `timerQueue` for another entire slice.

Re-reading `currentTime = getCurrentTime()` at line 213 is the minimum work to keep subsequent decisions accurate. Note that this is the only place in `workLoop` where `currentTime` is refreshed — the rest of the loop trusts that `currentTime` is "the time when we finished the last callback" or "the initial time". As long as fibers are fast (<1ms each) this is accurate enough for the deadline check at line 194.

## 7. Why `advanceTimers(currentTime)` is called before the continuation yield at line 223

`advanceTimers` (Scheduler.js:103-125) walks the `timerQueue` min-heap and promotes any delayed task whose `startTime <= currentTime` over to `taskQueue`. It's how the "delay a task by N ms" API is implemented.

When a user callback runs for 20ms (for example, a big React slice), 20ms worth of delayed tasks may have become due during that time. The line-223 `advanceTimers(currentTime)` call promotes them before the continuation yield, so that:

- **When the next slice starts**, the Scheduler will `peek(taskQueue)` and see those just-promoted tasks alongside our continued task. They'll be ordered by `sortIndex` (`expirationTime`), which is the correct "who deserves to run first" ordering.
- **If a newly-promoted task has higher priority** (earlier `expirationTime`) than our continued task, then on the next slice the continued task will *not* be at the heap root any more. The new task runs first. Our continuation will be picked up later, exactly as designed — and critically, because all of its state lives in the reconciler's globals, the delay is transparent.

Without this promotion step, a delayed task that became due during a long render slice would be stuck in the `timerQueue` for an entire extra MessageChannel hop. That would be a measurable latency bug for high-priority delayed work.

Note that line 235 (in the completion branch) also calls `advanceTimers(currentTime)` for the exact same reason. Completing a task and yielding for continuation are symmetric with respect to timer promotion.

---

## 8. Concrete execution trace: a big React render

Assume a React app does `root.render(<BigTree/>)` where `BigTree` has ~500 fibers, each taking ~0.2ms, at default transition priority. Frame budget is 5ms (`frameYieldMs`). Let us trace through exactly what happens.

### Setup (before the first slice)

1. `root.render` ⇒ `scheduleUpdateOnFiber` ⇒ `ensureRootIsScheduled` ⇒ `processRootScheduleInMicrotask` ⇒ `scheduleTaskForRootDuringMicrotask`.
2. That function decides the render needs NormalPriority, calls `scheduleCallback(NormalSchedulerPriority, performWorkOnRootViaSchedulerTask.bind(null, root))` at ReactFiberRootScheduler.js:500.
3. Scheduler's `unstable_scheduleCallback` creates a `Task`:
   ```
   task = {
     id: 1,
     callback: boundReact,
     priorityLevel: NormalPriority,
     startTime: 0,
     expirationTime: 5000,      // 5s timeout for normal priority
     sortIndex: 5000,
     isQueued: true,
   }
   ```
   `push(taskQueue, task)` places it in the min-heap, `isHostCallbackScheduled = true`, `requestHostCallback()` posts a MessageChannel message.
4. `root.callbackNode = task` (the returned `Task` handle). `root.callbackPriority = DefaultLane`.

### Slice 1 — t = 0ms

1. MessageChannel delivers → `performWorkUntilDeadline` fires at line 485. `startTime = 0`.
2. `flushWork(0)` → `workLoop(0)`.
3. `currentTime = 0`, `advanceTimers(0)` — no timers. `currentTask = peek(taskQueue) = task`.
4. Loop iteration:
   - `task.expirationTime (5000) > currentTime (0)` **and** `shouldYieldToHost()` returns false (timeElapsed < 5ms). No yield.
   - `callback = task.callback = boundReact`. Is function → yes.
   - `task.callback = null` (line 203, the tombstone).
   - `didUserCallbackTimeout = task.expirationTime (5000) <= currentTime (0)` → false.
   - **Line 212**: `continuationCallback = boundReact(false)`.
5. Inside `boundReact(false)` = `performWorkOnRootViaSchedulerTask(root, false)`:
   - `originalCallbackNode = root.callbackNode` (this is still `task`).
   - `lanes = getNextLanes(...)` → some DefaultLane bitmask.
   - `forceSync = !disableSchedulerTimeoutInWorkLoop && false` → false.
   - `performWorkOnRoot(root, lanes, false)` at `ReactFiberWorkLoop.js:1122`.
     - `shouldTimeSlice = true`.
     - `renderRootConcurrent(root, lanes)` at line 2757.
       - `workInProgressRoot === root`? No (it's null on first entry). → `prepareFreshStack(root, lanes)` creates the WIP fiber tree. `workInProgress = rootFiber`.
       - `workLoopConcurrentByScheduler()` at line 3051.
         - While `workInProgress !== null && !shouldYield()`: `performUnitOfWork(workInProgress)`.
         - Processes ~25 fibers over ~5ms. Each `performUnitOfWork` assigns `workInProgress = next` (sibling or return).
         - At t ≈ 5ms, `shouldYield()` returns true (timeElapsed ≥ frameInterval).
         - Loop exits. `workInProgress` is still not null (475 fibers remaining).
       - `renderRootConcurrent` reaches line 3009: `workInProgress !== null` → returns `RootInProgress`.
     - `performWorkOnRoot` at line 1171: `exitStatus === RootInProgress` → break out of the do-while.
     - Returns.
   - Back in `performWorkOnRootViaSchedulerTask`:
     - `scheduleTaskForRootDuringMicrotask(root, now())` at ReactFiberRootScheduler.js:599.
       - Re-derives `nextLanes`. Still has the same DefaultLane. The priority hasn't changed.
       - At line 462-474: `newCallbackPriority === existingCallbackPriority` → returns without canceling the callback. `root.callbackNode` is still `task` (unchanged).
     - Line 600: `root.callbackNode != null && root.callbackNode === originalCallbackNode` → true.
     - **Return `performWorkOnRootViaSchedulerTask.bind(null, root)`**.
6. Back in `workLoop` at line 212, `continuationCallback` is the freshly-bound function.
7. `currentTime = getCurrentTime()` → t ≈ 5ms.
8. Line 214: `typeof continuationCallback === 'function'` → true.
9. Line 218: `task.callback = continuationCallback` — the Task object is mutated in place; the heap position is unchanged.
10. Line 223: `advanceTimers(5)` — still no timers due.
11. Line 224: `return true`.
12. `flushWork` returns true → `performWorkUntilDeadline` sees `hasMoreWork = true` → `schedulePerformWorkUntilDeadline()` posts another MessageChannel message.
13. The macrotask returns. The browser is free to paint, run `requestAnimationFrame` callbacks, handle input events, etc.

### Between slices

- The browser paints a frame.
- A rAF callback could run.
- User input could fire and schedule a *higher-priority* task (let's assume not for this trace).
- `task` is still sitting in the Scheduler's `taskQueue` heap, at the root, with the continuation function in its `callback` slot.

### Slice 2 — t = 20ms (after paint)

1. Second MessageChannel message delivered → `performWorkUntilDeadline` → `flushWork(20)` → `workLoop(20)`.
2. `currentTime = 20`, `advanceTimers(20)` — no timers. `currentTask = peek(taskQueue) = task` (same object as slice 1).
3. Loop iteration:
   - `task.expirationTime (5000) > 20` and `shouldYieldToHost()` false (just started). No yield.
   - `callback = task.callback = continuationCallbackFromSlice1`. Is function → yes.
   - `task.callback = null`.
   - `didUserCallbackTimeout = false`.
   - **Line 212**: `continuationCallbackFromSlice1(false)` → `performWorkOnRootViaSchedulerTask(root, false)`.
4. Inside `performWorkOnRootViaSchedulerTask` again:
   - `originalCallbackNode = root.callbackNode` = `task` (still the same).
   - `performWorkOnRoot(root, lanes, false)`.
     - `renderRootConcurrent(root, lanes)`.
       - `workInProgressRoot === root && workInProgressRootRenderLanes === lanes` → true.
       - Line 2787 branch: **"This is a continuation of an existing work-in-progress."** No `prepareFreshStack`. `workInProgress` is still the fiber we stopped at in slice 1.
       - `workLoopConcurrentByScheduler()` picks up from fiber #26, continues through fiber #50, yields.
     - Returns `RootInProgress`.
   - `scheduleTaskForRootDuringMicrotask` → `root.callbackNode` unchanged.
   - Returns `performWorkOnRootViaSchedulerTask.bind(null, root)` again. This is a *new* bound function each time — identity-wise, but semantically identical.
5. `workLoop` stores it on `task.callback`, `return true`, macrotask ends.

### Slices 3 through N

Same pattern. Each slice processes ~25 fibers and yields. At slice 20, `workLoopConcurrentByScheduler` finishes the last fiber and leaves `workInProgress = null`.

### Slice 20 — the completion slice

1. `renderRootConcurrent`: `workInProgress` is null at the top-of-loop → exits the do-while → reaches line 3015, returns `workInProgressRootExitStatus` (e.g. `RootCompleted`).
2. `performWorkOnRoot` at line 1194: `exitStatus !== RootInProgress` → the big else branch. Walks through error recovery, then calls `finishConcurrentRender(root, ...)` at line 1298.
3. `finishConcurrentRender` commits (synchronously) the finished tree. Mutation phase, layout phase, passive effects scheduled.
4. `ensureRootIsScheduled(root)` at line 1309 — usually no more work, so `root.callbackNode = null`.
5. Returns from `performWorkOnRoot`.
6. Back in `performWorkOnRootViaSchedulerTask`:
   - `scheduleTaskForRootDuringMicrotask` at line 599 runs. `getNextLanes` returns `NoLanes`. The function cancels any existing callback (none to cancel — it was just us), sets `root.callbackNode = null`.
   - Line 600: `root.callbackNode != null` → false. Skip the continuation branch.
   - Line 605: `return null`.
7. Back in `workLoop`, `continuationCallback = null`. Line 214: `typeof null === 'function'` → false. Fall into the else at line 225.
   - `markTaskCompleted(task, currentTime)`; `task.isQueued = false`.
   - `if (task === peek(taskQueue)) pop(taskQueue)` — the task is finally removed from the heap.
8. `currentTask = peek(taskQueue)` → null.
9. Loop exits. `workLoop` returns false (no more work).
10. `performWorkUntilDeadline` sees `hasMoreWork = false` → `isMessageLoopRunning = false`. Done.

### Trace summary

- Slices 1-20 each run as a separate macrotask.
- The Scheduler's heap only ever held *one* task for the whole render.
- The task's `callback` slot was mutated 20 times (19 continuation writes + 1 initial). Its `id`, `sortIndex`, `expirationTime` never changed.
- The reconciler's `workInProgress` fiber cursor is what *actually* remembered where to resume — the Scheduler had no idea.

## 9. What if the continuation throws?

This is a subtle one, and the question in the brief deserves careful tracing.

Line-by-line:

```js
203:  currentTask.callback = null;                          // tombstone set
...
212:  const continuationCallback = callback(didUserCallbackTimeout);
213:  currentTime = getCurrentTime();
214:  if (typeof continuationCallback === 'function') {
...
218:    currentTask.callback = continuationCallback;        // unset tombstone
```

Case A: callback throws on the *first* invocation (no continuation has been stored yet on this task).

1. Line 203 has already run — `callback` is null.
2. Line 212 invokes `callback(...)` which throws.
3. Line 213 never runs. Line 218 never runs.
4. The exception propagates out of `workLoop`, into `flushWork` at line 162/175. In the `enableProfiling` branch, there's a `try/catch` at line 161-172 that runs `markTaskErrored(currentTask, currentTime)` and rethrows. In the non-profiling branch (production), there's no try/catch — the exception propagates straight out of `flushWork`.
5. `performWorkUntilDeadline` at Scheduler.js:485 has the comment at line 495: *"If a scheduler task throws, exit the current browser task so the error can be observed. Intentionally not using a try-catch, since that makes some debugging techniques harder. Instead, if `flushWork` errors, then `hasMoreWork` will remain true, and we'll continue the work loop."*
6. Its `finally` at line 504 sees `hasMoreWork = true` (the initial value) and schedules another slice.
7. Next slice: `peek(taskQueue)` still returns the task, but now `task.callback === null`. Line 201 (`typeof callback === 'function'`) is false → line 237-238 `else { pop(taskQueue); }`. The task is popped, silently.

**So: a throwing callback leaves the task as a tombstone that gets popped on the next slice. The error propagates to the host; the rest of the queue continues after one wasted macrotask.**

Case B: a continuation throws on slice 2 (or later).

1. Slice 1 ran, stored a continuation at line 218. `task.callback = continuationFromSlice1`.
2. Slice 2: line 203 sets `task.callback = null` again. Line 212 invokes `continuationFromSlice1(...)` which throws.
3. Identical to Case A from here. Line 218 doesn't run. `task.callback` stays null → popped on the next slice.

**The key invariant: `task.callback = null` at line 203 always runs before `callback(...)` at line 212. If the invocation throws, the tombstone is never cleared. This means a throwing task can never accidentally be re-invoked** — even once. On the very next peek, the null-callback branch at line 237 pops it.

This is exactly why line 203 exists *before* line 212 rather than after. If the order were reversed, a throwing callback would still be sitting in the heap with a callable `callback` slot, and the next slice would call it again — and probably throw again — ad infinitum.

### Reconciler-level error handling

Note that React itself wraps most errors via `handleThrow` inside `renderRootConcurrent`'s try/catch at line 2998. So in normal operation, the exception path described above is only reached for genuinely catastrophic errors (out-of-memory, infinite loops that the Scheduler's host-task timeout triggers, or errors thrown from `handleThrow` itself). Ordinary component errors are caught inside `renderRootConcurrent`, re-thrown into the reconciler's error-boundary logic, and never escape to `workLoop`.

---

## 10. Grep confirmations

```
$ rg -n 'continuation' packages/react-reconciler/src/
```

Three matches, all consistent with §3:

- `ReactFiberWorkLoop.js:2787` — `// This is a continuation of an existing work-in-progress.`
- `ReactFiberRootScheduler.js:593` — `// priority. Need to determine whether we need to schedule a continuation.`
- `ReactFiberRootScheduler.js:595` — `// however, since most of the logic for determining if we need a continuation`
- `ReactFiberRootScheduler.js:602` — `// currently executed. Need to return a continuation.`

```
$ rg -n 'performWorkOnRootViaSchedulerTask' packages/react-reconciler/src/
```

- `ReactFiberRootScheduler.js:502` — passed to `scheduleCallback` as the task callback.
- `ReactFiberRootScheduler.js:513` — the function definition.
- `ReactFiberRootScheduler.js:603` — returned as the continuation.

And `performConcurrentWorkOnRoot` does *not* exist in this version of the source — it was renamed to `performWorkOnRootViaSchedulerTask` (the name reflects its role as "entry point for concurrent tasks scheduled via Scheduler"). The actual work is now in `performWorkOnRoot` at `ReactFiberWorkLoop.js:1122`, which is called both from the scheduler path (with `forceSync=false` or `forceSync=didTimeout`) and from the sync path (`performSyncWorkOnRoot` at ReactFiberRootScheduler.js:608, which calls it with `forceSync=true`).

## 11. The protocol, distilled

```
╔══════════════════════════════════════════════════════════════════╗
║  THE CONTINUATION PROTOCOL                                        ║
║                                                                   ║
║  Scheduler side:                                                  ║
║    1. Clear task.callback = null      (line 203; tombstone)       ║
║    2. result = callback(didTimeout)   (line 212)                  ║
║    3. Re-read currentTime             (line 213)                  ║
║    4. if (typeof result === 'function'):                          ║
║         task.callback = result        (line 218; un-tombstone)    ║
║         advanceTimers(currentTime)    (line 223)                  ║
║         return true                   (line 224; yield, heap kept)║
║       else:                                                        ║
║         pop(taskQueue)                (line 233; task done)       ║
║                                                                   ║
║  React side (performWorkOnRootViaSchedulerTask):                  ║
║    1. Capture root.callbackNode (the Task handle)                 ║
║    2. performWorkOnRoot(root, lanes, forceSync = didTimeout)      ║
║       - renderRootConcurrent → workLoopConcurrentByScheduler      ║
║       - loops `while (workInProgress !== null && !shouldYield())` ║
║       - on yield, leaves module-level workInProgress set          ║
║    3. scheduleTaskForRootDuringMicrotask(root, now())             ║
║       - reconciles root.callbackNode with latest priority         ║
║    4. if (root.callbackNode === originalCallbackNode):            ║
║         return performWorkOnRootViaSchedulerTask.bind(null, root) ║
║       else:                                                        ║
║         return null                                               ║
║                                                                   ║
║  Per-pause state lives in:                                        ║
║    - workInProgress (module-level, ReactFiberWorkLoop.js)         ║
║    - workInProgressRoot, workInProgressRootRenderLanes            ║
║    - workInProgressSuspendedReason, workInProgressThrownValue     ║
║    - the fiber tree itself (root.current.alternate subtree)       ║
║                                                                   ║
║  Per-pause state does NOT live in:                                ║
║    - the Scheduler's Task object (only callback is mutated)       ║
║    - the Scheduler's heap (position unchanged)                    ║
║    - any closure captured inside the continuation function        ║
║      (the bound function only closes over `root`)                 ║
╚══════════════════════════════════════════════════════════════════╝
```

## 12. Why this design is good

- **Zero serialization.** Compare with generators (`function*`): they require a full suspendable stack frame, yield point tracking, `.next(value)` plumbing, and are significantly slower in V8. The continuation pattern uses just one in-place function replacement.
- **Zero coupling.** The Scheduler has no idea what a fiber is, what a lane is, or what "where React left off" means. It only knows "if callback returns a function, call it again next slice". This is why the same Scheduler module is shared between React DOM, React Native, React Test Renderer, etc., without any reconciler-specific code.
- **Cancellation is trivial.** `unstable_cancelCallback(task)` just sets `task.callback = null`. Next peek, the null-callback branch at line 237 pops it. No cleanup of partial render state is needed because the Scheduler doesn't hold any.
- **Identity is preserved.** `root.callbackNode === originalCallbackNode` is a sufficient check for "am I still the scheduled task for this root?" precisely because in-place mutation means the `Task` object reference is stable across all slices of the same logical render.
- **Priority changes are a free restart.** If `scheduleTaskForRootDuringMicrotask` notices the priority changed (e.g. a discrete input event just scheduled sync work), it cancels the old task, schedules a new one, `root.callbackNode` points to the new handle, and `performWorkOnRootViaSchedulerTask` returns `null` instead of a continuation. The old task is popped. The new task runs next. No partial state migration needed — `prepareFreshStack` will be called in `renderRootConcurrent` because `workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes` will now be true for the new task's lanes.

The whole dance reduces to: **a function that returns itself means "call me again"**. That is the *entire* concurrent render's cooperative-multitasking primitive.
