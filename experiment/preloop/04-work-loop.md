# 04 — Work Loop: The Execution Engine

**File:** `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js` (598 lines)
**Companion:** `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/SchedulerMock.js`

## 1. `workLoop(initialTime)` — lines 188-258

### Full source

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

### Control flow walk-through

1. **Line 189** — `currentTime` initialized from caller (`flushWork`).
2. **Line 190** — `advanceTimers(currentTime)`: drain `timerQueue`, promote any ready timers to `taskQueue`.
3. **Line 191** — `currentTask = peek(taskQueue)`. Note: `currentTask` is a **module-level** variable (line 85), not local.
4. **Line 192** — Main loop: while `currentTask !== null`.
5. **Lines 193-198 — Yield check:**
   - Guarded by `!enableAlwaysYieldScheduler`.
   - Condition: `currentTask.expirationTime > currentTime && shouldYieldToHost()`.
     - Not expired (has slack) AND host wants the main thread.
   - Expired tasks are **never yielded for** — they preempt browser work.
6. **Line 200** — Snapshot `callback = currentTask.callback` into local.
7. **Line 201 — Live task branch:**
   - **Line 203** — `currentTask.callback = null`. In-flight marker. If re-entered, the task looks cancelled.
   - **Line 205** — `currentPriorityLevel = currentTask.priorityLevel`. So `unstable_getCurrentPriorityLevel()` inside the callback sees the task's priority.
   - **Line 207** — `didUserCallbackTimeout = currentTask.expirationTime <= currentTime`.
   - **Line 212** — `const continuationCallback = callback(didUserCallbackTimeout)`. User callback runs synchronously. **No try/catch around this line.**
   - **Line 213** — Refresh `currentTime` after the callback.
   - **Line 214 — Continuation branch:**
     - **Line 218** — `currentTask.callback = continuationCallback`. Re-arms the same task.
     - **Line 223** — `advanceTimers(currentTime)`.
     - **Line 224** — `return true`. The **only "yield with more work"** early-exit.
   - **Line 225 — Completion branch:**
     - **Lines 232-234** — `if (currentTask === peek(taskQueue)) pop(taskQueue)`. Defensive pop: user callback could have scheduled a more urgent task making `currentTask` no longer the root. If so, leave it — its `callback` is `null` and it'll be pruned lazily when it reaches the root.
     - **Line 235** — `advanceTimers(currentTime)`.
8. **Line 237 — Cancelled branch:** `callback === null` (cancelled). `pop(taskQueue)` unconditionally — task is the heap root.
9. **Line 240** — `currentTask = peek(taskQueue)`.
10. **Lines 241-246 — Always-yield post-loop check:** Under `enableAlwaysYieldScheduler`, break if no more tasks OR next task hasn't expired. At most one expired task per slice.
11. **Lines 248-257 — Termination tail:**
    - If `currentTask !== null`: return `true` (exited via break).
    - Else: heap empty. If there's a future timer, `requestHostTimeout` to wake up when it's ready. Return `false`.

### Return values

| Return | Meaning | Line |
|---|---|---|
| `true` | Yielded via continuation | 224 |
| `true` | Yielded for deadline, more tasks | 250 |
| `false` | Heap drained | 256 |

---

## 2. `flushWork(initialTime)` — lines 144-186

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

### Structure

- **Lines 149-155 — Pre-flush cleanup:**
  - `isHostCallbackScheduled = false` because we ARE the host callback now. Prevents re-entry.
  - Cancel any pending `handleTimeout`.
- **Line 157** — `isPerformingWork = true`. Combined with line 409 in `unstable_scheduleCallback`, this is the re-entrance guard.
- **Line 158** — Snapshot `previousPriorityLevel`.
- **Profiling path (160-172)** — Inner `try/catch` wraps `workLoop` for `markTaskErrored`, then re-throws. **Catch does NOT swallow errors.**
- **Production path (173-176)** — `return workLoop(initialTime)` with no inner try/catch.
- **Finally (177-185):**
  - `currentTask = null` always.
  - `currentPriorityLevel = previousPriorityLevel` restores caller's priority.
  - `isPerformingWork = false` re-allows `requestHostCallback`.

### Why two layers of try?

Outer `try/finally` handles **state restoration** unconditionally. Inner `try/catch` is a **profiling-only** error tap that needs `currentTask` to still be live when it fires (so must run before the outer `finally` clears it).

---

## 3. `performWorkUntilDeadline` — lines 485-514

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

1. **Lines 486-488** — Reset `needsPaint = false`. The browser is about to get a chance to paint.
2. **Line 493** — `startTime = currentTime`. **Critical:** anchors `shouldYieldToHost`'s elapsed-time calculation (line 452: `getCurrentTime() - startTime`).
3. **Lines 501-512 — `hasMoreWork` pattern:**
   - Initialized to `true` BEFORE the try.
   - If `flushWork` throws, the assignment on line 503 never happens → `hasMoreWork` stays `true` → `finally` re-schedules. Work loop self-heals after errors without catch. Error escapes to browser onerror.
   - Otherwise uses `flushWork`'s return.

### `schedulePerformWorkUntilDeadline` setup — lines 516-547

```js
let schedulePerformWorkUntilDeadline;
if (typeof localSetImmediate === 'function') {
  // Node.js and old IE.
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

Chosen implementation runs `performWorkUntilDeadline` as a fresh macrotask — `startTime` measures only this one slice.

---

## 4. `hasTimeRemaining` — mock vs browser

**Browser fork:** `workLoop` and `flushWork` have **no `hasTimeRemaining` parameter**. Yield is decided purely by `shouldYieldToHost()`.

**Mock fork:** `workLoop(hasTimeRemaining, initialTime)`:

```js
if (
  currentTask.expirationTime > currentTime &&
  (!hasTimeRemaining || shouldYieldToHost())
) {
  break;
}
```

- `hasTimeRemaining === true`: degrades into normal behavior.
- `hasTimeRemaining === false`: **forced yield mode.** Only expired tasks execute. Test harness says "host has zero time."

Mock fork additionally has a `shouldYieldForPaint` knob inside continuation handling — returning a continuation does *not* unconditionally yield under the mock. Browser fork **always** yields on continuation.

---

## 5. Cancelled tasks (`callback === null`) — lazy cleanup

`unstable_cancelCallback` (lines 418-431) just sets `task.callback = null`. The heap is array-backed; you cannot delete arbitrary interior nodes in O(log n) without re-keying.

Lazy reap in workLoop:
- Line 200: snapshot `callback = currentTask.callback`.
- Line 201: `if (typeof callback === 'function')` is false when null.
- Line 237-238: `else { pop(taskQueue); }` — lazy cleanup.

This costs O(log n) per cancelled task, paid when it reaches the root.

`advanceTimers` has an analogous lazy reap for cancelled timers (lines 107-109).

---

## 6. The continuation pattern — exact lines

```js
200      const callback = currentTask.callback;
201      if (typeof callback === 'function') {
203        currentTask.callback = null;        // cleared so re-entry won't double-run
205        currentPriorityLevel = currentTask.priorityLevel;
207        const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
212        const continuationCallback = callback(didUserCallbackTimeout);
213        currentTime = getCurrentTime();
214        if (typeof continuationCallback === 'function') {
218          currentTask.callback = continuationCallback;  // re-arm same task (no pop!)
223          advanceTimers(currentTime);
224          return true;                                    // exit; task stays at root
225        } else {
```

### Step-by-step

1. **Line 203** — `currentTask.callback = null` BEFORE invoking.
2. **Line 212** — Run user callback. Contract: return function = "more work"; anything else = "done."
3. **Line 213** — Refresh time.
4. **Line 218** — Same `currentTask` object re-armed. **Not popped from heap.** `expirationTime` and `sortIndex` unchanged.
5. **Line 223** — `advanceTimers` runs before early return so timers that became due during the long callback are promoted now.
6. **Line 224** — `return true`.

**Crucial**: yielding does NOT require popping + re-pushing. O(1) on the heap. Priority preserved exactly.

---

## 7. "Has more work" propagation

Three return paths set `true`:
- Line 224 — continuation yield
- Line 250 — break with `currentTask !== null`

`flushWork` returns the value unchanged. `performWorkUntilDeadline` uses it to `schedulePerformWorkUntilDeadline()` (line 508).

A single `return true` anywhere reschedules the next macrotask. Fully restartable across slices because all state lives in module globals.

---

## 8. `didTimeout` parameter

```js
const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
const continuationCallback = callback(didUserCallbackTimeout);
```

- **Computed from**: `currentTask.expirationTime` vs loop's `currentTime`.
- **Meaning**: `true` iff task has hit its deadline. Passed to user callback (signature `Callback = (didTimeout: boolean) => ?Callback`).
- **React's use**: `performConcurrentWorkOnRoot` uses it to decide whether to switch from time-sliced to **synchronous** mode — when expired, work must finish in this slice.
- **Relationship to yield check**:
  - Line 194: "if NOT expired AND should yield, break" — expired tasks bypass yield.
  - Line 207: "tell the callback whether it's expired" — callback can adjust.

For `ImmediatePriority` with `timeout = -1`, `didUserCallbackTimeout` is essentially always `true`.

---

## 9. Does Scheduler swallow errors? NO.

Three layers, none silent:

1. **Inside `workLoop`** — No try/catch around `callback()` at line 212. Exception propagates straight out.
2. **Inside `flushWork`:**
   - Profiling path: inner `try/catch` is instrumentation-only; re-throws.
   - Prod path: no catch at all. Comment: `// No catch in prod code path.`
3. **Inside `performWorkUntilDeadline`** — `try { ... } finally { ... }`, no catch. Comment lines 495-500:
   > "If a scheduler task throws, exit the current browser task so the error can be observed. Intentionally not using a try-catch, since that makes some debugging techniques harder. Instead, if flushWork errors, then hasMoreWork will remain true, and we'll continue the work loop."

**Contract**: thrown errors are **observable** (reach browser onerror) and the scheduler **automatically retries** via re-scheduling. The throwing task has `callback = null` (set line 203 before throw), so next slice falls into the cancelled branch and is popped.

---

## 10. `currentTask` / `currentPriorityLevel` restoration in `finally`

```js
const previousPriorityLevel = currentPriorityLevel;
try {
  // workLoop runs, mutates module globals
} finally {
  currentTask = null;
  currentPriorityLevel = previousPriorityLevel;
  isPerformingWork = false;
}
```

- `previousPriorityLevel` captured BEFORE entering `workLoop`.
- `currentTask = null` always.
- `currentPriorityLevel = previousPriorityLevel`. Inside workLoop, line 205 sets this per-task; that mutation is NOT unwound between tasks within the same loop (so a higher-priority task running before a lower-priority one could leak its priority through `unstable_getCurrentPriorityLevel` reads between iterations), but the `finally` cleanly restores the outer priority for the next slice.
- `isPerformingWork = false` re-allows `requestHostCallback`.

---

## Engine glue summary

```
unstable_scheduleCallback (327)
  └─ requestHostCallback (549)
       └─ schedulePerformWorkUntilDeadline (538, MessageChannel post)
            └─ MessageChannel onmessage → performWorkUntilDeadline (485)
                 ├─ startTime = getCurrentTime()                  [493]
                 ├─ hasMoreWork = flushWork(currentTime)           [503]
                 │    └─ workLoop(initialTime)                     [162/175]
                 │         ├─ advanceTimers                        [190]
                 │         ├─ shouldYieldToHost (uses startTime)   [194]
                 │         ├─ callback(didUserCallbackTimeout)     [212]
                 │         └─ return true | false                  [224/250/256]
                 └─ if (hasMoreWork) schedulePerformWorkUntilDeadline()  [508]
```

The whole scheduler in summary:
1. Min-heap of tasks ordered by `expirationTime`.
2. Pump (`performWorkUntilDeadline`) draining one slice at a time.
3. Yield budget anchored to `startTime` per slice.
4. Continuation protocol (return a function) for cooperative mid-task yields.
5. Lazy cancellation via `callback = null`.
6. Module-global state with `try/finally` so any throw self-heals.
