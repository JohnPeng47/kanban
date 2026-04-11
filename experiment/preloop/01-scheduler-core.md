# Scheduler.js Core: Module State, Public API, Task Lifecycle

Source: `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`
(File is 599 lines total.)

This document covers the module-level state, the public `unstable_*` API
surface, and the task lifecycle (scheduling, cancellation, timer promotion,
host callback pumping, frame rate). Line numbers are from the file above and
are exact.

> **IMPORTANT — APIs NOT present in this file**
>
> The prompt asked about several APIs that do **not** exist in this file. These
> used to exist in older Scheduler.js revisions but have been removed:
>
> - `unstable_pauseExecution` — NOT PRESENT
> - `unstable_continueExecution` — NOT PRESENT
> - `isSchedulerPaused` (the flag) — NOT PRESENT
> - `unstable_getFirstCallbackNode` — NOT PRESENT
> - `cancelHostCallback` — NOT PRESENT (only `cancelHostTimeout` exists)
>
> A grep for `pauseExecution|continueExecution|isSchedulerPaused|cancelHostCallback|getFirstCallbackNode`
> across the file returns zero matches. The documentation below therefore
> covers "what is actually in the file" and explicitly notes the absences.
> See also the `SchedulerMock.js` sibling fork in the same directory, which
> still retains some pause-related helpers for tests.
>
> There is also **no `unstable_forceFrameRate` variable named differently** —
> the internal function is `forceFrameRate` (line 468), re-exported as
> `unstable_forceFrameRate` at line 587.

---

## 1. Module-Level State

All module-level state lives in `Scheduler.js`. Every piece is mutated during
the lifetime of the scheduler — none of it is `const` (except the captured
native API references and `maxSigned31BitInt`).

### 1.1 Time source

**`getCurrentTime`** — line 59 (declared), lines 66 / 70 (assigned).

```
59: let getCurrentTime: () => number | DOMHighResTimeStamp;
60: const hasPerformanceNow =
61:   // $FlowFixMe[method-unbinding]
62:   typeof performance === 'object' && typeof performance.now === 'function';
63:
64: if (hasPerformanceNow) {
65:   const localPerformance = performance;
66:   getCurrentTime = () => localPerformance.now();
67: } else {
68:   const localDate = Date;
69:   const initialTime = localDate.now();
70:   getCurrentTime = () => localDate.now() - initialTime;
71: }
```

- Captured once at module init.
- When `performance.now` exists, uses the high-resolution clock directly.
- Otherwise falls back to `Date.now()` normalized so the first reading is `0`
  (the `- initialTime` offset).
- Re-exported at line 586 as `unstable_now`.
- Non-obvious: the reference is captured in a local (`localPerformance` /
  `localDate`) so that later polyfills or shims cannot hijack the time source
  for the scheduler. This same pattern is used again at lines 97–101 for the
  host timer/immediate primitives.

### 1.2 Constants

**`maxSigned31BitInt`** — line 76.

```
73: // Max 31 bit integer. The max integer size in V8 for 32-bit systems.
74: // Math.pow(2, 30) - 1
75: // 0b111111111111111111111111111111
76: var maxSigned31BitInt = 1073741823;
```

- `2^30 - 1`. Used as the "never times out" expiration timeout for
  `IdlePriority` (line 358). Kept at 31 bits specifically so V8 keeps values
  as SMIs on 32-bit systems — avoids boxing.

**Native API captures** — lines 97–101.

```
97: const localSetTimeout = typeof setTimeout === 'function' ? setTimeout : null;
98: const localClearTimeout =
99:   typeof clearTimeout === 'function' ? clearTimeout : null;
100: const localSetImmediate =
101:   typeof setImmediate !== 'undefined' ? setImmediate : null; // IE and Node.js + jsdom
```

- All three may be `null`, which the scheduler then handles with branching at
  lines 517–547 (choosing between `setImmediate`, `MessageChannel`, and
  `setTimeout` fallbacks).

### 1.3 Task heaps

**`taskQueue`** — line 79.

```
78: // Tasks are stored on a min heap
79: var taskQueue: Array<Task> = [];
```

- Min-heap of tasks that are **ready to run**. Min-key is `sortIndex`, which
  for tasks in `taskQueue` is their `expirationTime` (see line 401 and line 113).
- So `peek(taskQueue)` returns the task with the earliest expiration —
  effectively the most urgent.

**`timerQueue`** — line 80.

```
80: var timerQueue: Array<Task> = [];
```

- Min-heap of **delayed tasks**. Min-key is `sortIndex`, which for timerQueue
  entries is their `startTime` (line 387).
- `peek(timerQueue)` returns the next timer to fire.

**Invariant**: any given task is in at most one of the two heaps at a time.
It transitions from `timerQueue` → `taskQueue` inside `advanceTimers`
(lines 112–114).

**Invariant**: `sortIndex` inside `timerQueue` equals `startTime`; inside
`taskQueue` it equals `expirationTime`. This reassignment happens at line 113
(`timer.sortIndex = timer.expirationTime`) at the moment of promotion.

### 1.4 ID counter

**`taskIdCounter`** — line 83.

```
82: // Incrementing id counter. Used to maintain insertion order.
83: var taskIdCounter = 1;
```

- Monotonically increasing. Stamped on each task at line 374 (`id: taskIdCounter++`).
- Used by `SchedulerMinHeap` as a tiebreaker when two tasks have equal
  `sortIndex`: insertion order wins. (Not shown in Scheduler.js itself —
  enforced by the heap comparator.)

### 1.5 Current execution state

**`currentTask`** — line 85.

```
85: var currentTask = null;
```

- Points to the task being executed by `workLoop` at any moment.
- Written at lines 191 (`currentTask = peek(taskQueue)`) and 240
  (re-peek after popping).
- Reset to `null` in `flushWork`'s finally at line 178.
- Also read by the profiling error path at lines 164–169 so the error can be
  attributed to the current task.

**`currentPriorityLevel`** — line 86.

```
86: var currentPriorityLevel: PriorityLevel = NormalPriority;
```

- The "ambient" priority seen by `unstable_getCurrentPriorityLevel`.
- Mutated by five things:
  - `unstable_runWithPriority` (lines 275–281 saved/restored)
  - `unstable_next` (lines 300–306 saved/restored)
  - `unstable_wrapCallback` (lines 316–322 saved/restored on each wrapped call)
  - `workLoop` (line 205 sets it to `currentTask.priorityLevel` before running
    the task's callback)
  - `flushWork` (line 158 snapshots previous, line 179 restores in finally)
- Default is `NormalPriority`.

### 1.6 Re-entrance and host-loop flags

**`isPerformingWork`** — line 89.

```
88: // This is set while performing work, to prevent re-entrance.
89: var isPerformingWork = false;
```

- Set to `true` at line 157 inside `flushWork` before the try block.
- Cleared to `false` at line 180 in the finally.
- Consumed by `unstable_scheduleCallback` at line 409: if we're inside a
  flush, we do NOT call `requestHostCallback` for a newly enqueued task —
  the running workLoop will see the new task on its next iteration anyway.

**`isHostCallbackScheduled`** — line 91.

```
91: var isHostCallbackScheduled = false;
```

- Set `true` when we have asked the host to run `performWorkUntilDeadline`
  for us (lines 133, 410).
- Cleared to `false` at line 150 in `flushWork`, immediately on entry:
  "we'll need a host callback the next time work is scheduled".
- Invariant: while `isHostCallbackScheduled === true`, additional
  `requestHostCallback` calls are suppressed (line 409 guard).

**`isHostTimeoutScheduled`** — line 92.

```
92: var isHostTimeoutScheduled = false;
```

- Set `true` when we've armed `handleTimeout` via `requestHostTimeout`
  to promote a delayed task later (line 395).
- Cleared in `handleTimeout`'s first line (128) and in `flushWork`'s
  entry (line 153). In `flushWork` we also call `cancelHostTimeout()`
  because we're already doing work and any pending promotion is going to
  be handled by `advanceTimers` inside `workLoop` instead.

**`isMessageLoopRunning`** — line 437 (declared late, after `unstable_getCurrentPriorityLevel`).

```
437: let isMessageLoopRunning = false;
```

- Guards the MessageChannel/setImmediate pump so we don't double-schedule.
- Set to `true` inside `requestHostCallback` (line 551) right before the
  first `schedulePerformWorkUntilDeadline()`.
- Cleared back to `false` when `performWorkUntilDeadline` finishes a flush
  and `hasMoreWork === false` (line 510).
- The initial check at line 489 (`if (isMessageLoopRunning)`) lets
  `performWorkUntilDeadline` bail out cleanly if it's invoked after being
  logically stopped.
- Note: this is declared mid-file, not next to `isPerformingWork` etc.

**`taskTimeoutID`** — line 438.

```
438: let taskTimeoutID: TimeoutID = (-1: any);
```

- The handle returned by `localSetTimeout` when we arm a delayed-task timeout
  inside `requestHostTimeout` (line 561).
- Used by `cancelHostTimeout` to `localClearTimeout(taskTimeoutID)` (line 568).
- After cancel, reset to `-1` cast to `TimeoutID` (line 569).
- Sentinel `-1` means "no timeout currently armed".

### 1.7 Frame yielding state

**`needsPaint`** — line 94.

```
94: var needsPaint = false;
```

- Set `true` by `requestPaint()` (line 464), which is itself only effective
  when `enableRequestPaint` is `true`.
- Cleared at the very top of `performWorkUntilDeadline` (line 487) each time
  a new browser task starts pumping work.
- Consumed at line 448 inside `shouldYieldToHost`: if `enableRequestPaint`
  and `needsPaint`, we yield immediately regardless of time slice elapsed —
  unless `enableAlwaysYieldScheduler` is on, in which case the normal
  alwaysYield path at line 241–246 handles yielding.

**`frameInterval`** — line 444.

```
440: // Scheduler periodically yields in case there is other work on the main
441: // thread, like user events. By default, it yields multiple times per frame.
442: // It does not attempt to align with frame boundaries, since most tasks don't
443: // need to be frame aligned; for those that do, use requestAnimationFrame.
444: let frameInterval: number = frameYieldMs;
```

- Initialized from `frameYieldMs` (imported from `SchedulerFeatureFlags`,
  currently `5` — see `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerFeatureFlags.js` line 11).
- Adjusted only by `forceFrameRate` (lines 468–483). See section 8 below.
- Read inside `shouldYieldToHost` (line 453): if the current browser task
  has been running less than `frameInterval` ms, we do not yield.

**`startTime`** — line 445.

```
445: let startTime = -1;
```

- **Do not confuse this with `Task.startTime`** — this is the module-level
  wall clock of "when did the current browser task begin pumping work".
- Written once per message loop turn at line 493:

  ```
  489: if (isMessageLoopRunning) {
  490:   const currentTime = getCurrentTime();
  491:   // Keep track of the start time so we can measure how long the main thread
  492:   // has been blocked.
  493:   startTime = currentTime;
  ```
- Read by `shouldYieldToHost` at line 452
  (`const timeElapsed = getCurrentTime() - startTime;`).
- Initial sentinel `-1` means "no browser task in flight yet"; before the
  first `performWorkUntilDeadline` runs, `shouldYieldToHost` would return an
  artificially huge `timeElapsed` — but the function is only called from
  inside `workLoop`, which is only reachable via `performWorkUntilDeadline`,
  so `startTime` is always a real value by the time it matters.

### 1.8 `Task` shape

Defined at lines 49–57:

```
49: export opaque type Task = {
50:   id: number,
51:   callback: Callback | null,
52:   priorityLevel: PriorityLevel,
53:   startTime: number,
54:   expirationTime: number,
55:   sortIndex: number,
56:   isQueued?: boolean,
57: };
```

- `callback` is nulled on cancellation (see `unstable_cancelCallback`) and also
  nulled transiently in `workLoop` before invocation (line 203) so a
  continuation returned from the callback can be reassigned (line 218).
- `startTime` is the "earliest time this task is allowed to run" (i.e. for
  delayed tasks, `currentTime + options.delay`).
- `expirationTime = startTime + timeout` where `timeout` depends on the
  `priorityLevel` (see the switch at lines 347–369).
- `sortIndex` is the heap key. It equals `startTime` while in `timerQueue`,
  and equals `expirationTime` while in `taskQueue`.
- `isQueued` is only touched when `enableProfiling` is on; it's a
  "is this task currently live in a heap" bookkeeping flag for profiling
  events.

---

## 2. Public API Reference

The `export { ... }` block is at lines 572–588. The exports:

```
572: export {
573:   ImmediatePriority as unstable_ImmediatePriority,
574:   UserBlockingPriority as unstable_UserBlockingPriority,
575:   NormalPriority as unstable_NormalPriority,
576:   IdlePriority as unstable_IdlePriority,
577:   LowPriority as unstable_LowPriority,
578:   unstable_runWithPriority,
579:   unstable_next,
580:   unstable_scheduleCallback,
581:   unstable_cancelCallback,
582:   unstable_wrapCallback,
583:   unstable_getCurrentPriorityLevel,
584:   shouldYieldToHost as unstable_shouldYield,
585:   requestPaint as unstable_requestPaint,
586:   getCurrentTime as unstable_now,
587:   forceFrameRate as unstable_forceFrameRate,
588: };
```

There is also an additional `unstable_Profiling` export at lines 590–598,
which is `null` unless `enableProfiling` is true.

### 2.1 `unstable_scheduleCallback`

Lines 327–416. Signature:

```
327: function unstable_scheduleCallback(
328:   priorityLevel: PriorityLevel,
329:   callback: Callback,
330:   options?: {delay: number},
331: ): Task {
```

Returns the created `Task` object. Body details are in section 3.

### 2.2 `unstable_cancelCallback`

Lines 418–431.

```
418: function unstable_cancelCallback(task: Task) {
419:   if (enableProfiling) {
420:     if (task.isQueued) {
421:       const currentTime = getCurrentTime();
422:       markTaskCanceled(task, currentTime);
423:       task.isQueued = false;
424:     }
425:   }
426:
427:   // Null out the callback to indicate the task has been canceled. (Can't
428:   // remove from the queue because you can't remove arbitrary nodes from an
429:   // array based heap, only the first one.)
430:   task.callback = null;
431: }
```

- See section 4. The task is **not** removed from the heap; it simply sits
  there with `callback === null` until `advanceTimers` or `workLoop` notices.

### 2.3 `unstable_getCurrentPriorityLevel`

Lines 433–435.

```
433: function unstable_getCurrentPriorityLevel(): PriorityLevel {
434:   return currentPriorityLevel;
435: }
```

- Trivially returns the module-level `currentPriorityLevel`. The value reflects
  either whatever `runWithPriority`/`next`/`wrapCallback` set, or (when called
  from inside a task's callback) that task's own `priorityLevel` as set at
  line 205.

### 2.4 `unstable_runWithPriority`

Lines 260–283.

```
260: function unstable_runWithPriority<T>(
261:   priorityLevel: PriorityLevel,
262:   eventHandler: () => T,
263: ): T {
264:   switch (priorityLevel) {
265:     case ImmediatePriority:
266:     case UserBlockingPriority:
267:     case NormalPriority:
268:     case LowPriority:
269:     case IdlePriority:
270:       break;
271:     default:
272:       priorityLevel = NormalPriority;
273:   }
274:
275:   var previousPriorityLevel = currentPriorityLevel;
276:   currentPriorityLevel = priorityLevel;
277:
278:   try {
279:     return eventHandler();
280:   } finally {
281:     currentPriorityLevel = previousPriorityLevel;
282:   }
283: }
```

- Validates `priorityLevel` against the known enum values and coerces anything
  unknown to `NormalPriority` — defensive against callers passing garbage.
- Saves the previous priority, sets the new one, runs `eventHandler`, and
  restores in `finally` (so exceptions don't leak priority state).
- Non-obvious: the priority change is purely ambient; it does **not** schedule
  anything. If `eventHandler` calls `unstable_scheduleCallback`, those
  callbacks are scheduled with whatever priority the caller passes to
  `scheduleCallback`, not `priorityLevel` here.

### 2.5 `unstable_next`

Lines 285–308.

```
285: function unstable_next<T>(eventHandler: () => T): T {
286:   var priorityLevel: PriorityLevel;
287:   switch (currentPriorityLevel) {
288:     case ImmediatePriority:
289:     case UserBlockingPriority:
290:     case NormalPriority:
291:       // Shift down to normal priority
292:       priorityLevel = NormalPriority;
293:       break;
294:     default:
295:       // Anything lower than normal priority should remain at the current level.
296:       priorityLevel = currentPriorityLevel;
297:       break;
298:   }
```

- "Run this handler at the priority we'd use for the next piece of work" —
  if the current ambient priority is Immediate/UserBlocking/Normal, downshift
  to Normal. LowPriority and IdlePriority stay where they are.
- Then the same save/restore dance as `runWithPriority` (lines 300–307).
- Non-obvious: this is specifically so tasks scheduled *right after* an
  urgent event don't ride that event's high priority unless the caller
  explicitly asks for it.

### 2.6 `unstable_wrapCallback`

Lines 310–325.

```
310: function unstable_wrapCallback<T: (...Array<mixed>) => mixed>(callback: T): T {
311:   var parentPriorityLevel = currentPriorityLevel;
312:   // $FlowFixMe[incompatible-return]
313:   // $FlowFixMe[missing-this-annot]
314:   return function () {
315:     // This is a fork of runWithPriority, inlined for performance.
316:     var previousPriorityLevel = currentPriorityLevel;
317:     currentPriorityLevel = parentPriorityLevel;
318:
319:     try {
320:       return callback.apply(this, arguments);
321:     } finally {
322:       currentPriorityLevel = previousPriorityLevel;
323:     }
324:   };
325: }
```

- Captures the *current* ambient priority at wrap time (line 311) and returns
  a function that restores that priority each time it's invoked — regardless
  of the priority context in which the wrapped function is later called.
- Useful for "remember my priority for later async callbacks".
- The comment on line 315 ("a fork of runWithPriority, inlined for
  performance") is the only indication that it's literally the same
  save/run/restore pattern but specialized so there's no closure over the
  priority level parameter.
- Preserves `this` via `callback.apply(this, arguments)` at line 320.

### 2.7 `shouldYieldToHost` (exported as `unstable_shouldYield`)

Lines 447–460.

```
447: function shouldYieldToHost(): boolean {
448:   if (!enableAlwaysYieldScheduler && enableRequestPaint && needsPaint) {
449:     // Yield now.
450:     return true;
451:   }
452:   const timeElapsed = getCurrentTime() - startTime;
453:   if (timeElapsed < frameInterval) {
454:     // The main thread has only been blocked for a really short amount of time;
455:     // smaller than a single frame. Don't yield yet.
456:     return false;
457:   }
458:   // Yield now.
459:   return true;
460:   }
```

- Fast-path for paint: if a paint is requested and the always-yield
  experimental flag is off, yield immediately. Note the paint short-circuit
  is gated on `!enableAlwaysYieldScheduler` — because when the always-yield
  scheduler is active, the yield decision is made at lines 241–246 inside
  `workLoop` itself.
- Otherwise, check whether we've consumed our frame slice (`frameInterval` ms
  since `startTime` was set at line 493).
- Exported at line 584 as `unstable_shouldYield`. React fiber calls this on
  every commit check.

### 2.8 `requestPaint` (exported as `unstable_requestPaint`)

Lines 462–466.

```
462: function requestPaint() {
463:   if (enableRequestPaint) {
464:     needsPaint = true;
465:   }
466: }
```

- Sets the module-level `needsPaint` flag. Only effective when
  `enableRequestPaint` feature flag is on (it currently is, see
  `SchedulerFeatureFlags.js` line 16).
- When off, this is a no-op; `needsPaint` remains `false` forever.

### 2.9 `getCurrentTime` (exported as `unstable_now`)

Defined at lines 59–71, exported at line 586. Returns high-resolution
monotonic milliseconds from `performance.now()` if available, else
normalized `Date.now()`.

### 2.10 `forceFrameRate` (exported as `unstable_forceFrameRate`)

Lines 468–483.

```
468: function forceFrameRate(fps: number) {
469:   if (fps < 0 || fps > 125) {
470:     // Using console['error'] to evade Babel and ESLint
471:     console['error'](
472:       'forceFrameRate takes a positive int between 0 and 125, ' +
473:         'forcing frame rates higher than 125 fps is not supported',
474:     );
475:     return;
476:   }
477:   if (fps > 0) {
478:     frameInterval = Math.floor(1000 / fps);
479:   } else {
480:     // reset the framerate
481:     frameInterval = frameYieldMs;
482:   }
483: }
```

See section 8.

### 2.11 Removed / absent APIs

These are **not** present in this file:

- `unstable_pauseExecution` — removed
- `unstable_continueExecution` — removed
- `unstable_getFirstCallbackNode` — removed
- `cancelHostCallback` — removed (only `cancelHostTimeout` exists at 566–570)

Their semantic concerns — "is scheduler paused", "peek at the next scheduled
task" — do not exist in this fork. If you need pause semantics, they still
live in `SchedulerMock.js` in the same directory, which is used by React's
test infrastructure.

---

## 3. `unstable_scheduleCallback` — Start/Expiration/Sort/Queue Logic

Full body, lines 327–416.

### 3.1 Computing `startTime`

Lines 332–344:

```
332:   var currentTime = getCurrentTime();
333:
334:   var startTime;
335:   if (typeof options === 'object' && options !== null) {
336:     var delay = options.delay;
337:     if (typeof delay === 'number' && delay > 0) {
338:       startTime = currentTime + delay;
339:     } else {
340:       startTime = currentTime;
341:     }
342:   } else {
343:     startTime = currentTime;
344:   }
```

Rules:
- Read the clock exactly once (`currentTime`).
- If `options` is a non-null object AND `options.delay` is a number > 0:
  `startTime = currentTime + delay`. This is the only code path that makes
  the task delayed.
- Otherwise (no options, `null` options, non-number delay, zero delay,
  negative delay): `startTime = currentTime`. No delay, immediate.
- Non-obvious: a `delay` of `0` does NOT make the task delayed — the strict
  `> 0` check on line 337 falls through to the else branch. So
  `{delay: 0}` is equivalent to no delay.

### 3.2 Computing `timeout` and `expirationTime`

Lines 346–371:

```
346:   var timeout;
347:   switch (priorityLevel) {
348:     case ImmediatePriority:
349:       // Times out immediately
350:       timeout = -1;
351:       break;
352:     case UserBlockingPriority:
353:       // Eventually times out
354:       timeout = userBlockingPriorityTimeout;
355:       break;
356:     case IdlePriority:
357:       // Never times out
358:       timeout = maxSigned31BitInt;
359:       break;
360:     case LowPriority:
361:       // Eventually times out
362:       timeout = lowPriorityTimeout;
363:       break;
364:     case NormalPriority:
365:     default:
366:       // Eventually times out
367:       timeout = normalPriorityTimeout;
368:       break;
369:   }
370:
371:   var expirationTime = startTime + timeout;
```

- `ImmediatePriority`: `timeout = -1`, so `expirationTime = startTime - 1`.
  That means on the next `workLoop` iteration the task is already expired
  (line 207, `didUserCallbackTimeout = expirationTime <= currentTime`),
  so `shouldYieldToHost` is bypassed at line 194 and the task runs to
  completion regardless of frame pressure.
- `UserBlockingPriority`: `userBlockingPriorityTimeout = 250` (from feature
  flags line 13 — `250`).
- `NormalPriority` (and default / unknown): `normalPriorityTimeout = 5000`
  (feature flags line 14).
- `LowPriority`: `lowPriorityTimeout = 10000` (feature flags line 15).
- `IdlePriority`: `maxSigned31BitInt = 1073741823` — effectively never
  expires within the lifetime of the page.

### 3.3 Task construction

Lines 373–383:

```
373:   var newTask: Task = {
374:     id: taskIdCounter++,
375:     callback,
376:     priorityLevel,
377:     startTime,
378:     expirationTime,
379:     sortIndex: -1,
380:   };
381:   if (enableProfiling) {
382:     newTask.isQueued = false;
383:   }
```

- `id` is stamped via post-increment; the first task is `1`.
- `sortIndex` is initialized to `-1`; it is rewritten to either `startTime`
  or `expirationTime` immediately below, before the task actually enters a
  heap.
- `isQueued` only exists when `enableProfiling` is on.

### 3.4 Queue selection and scheduling

Lines 385–413:

```
385:   if (startTime > currentTime) {
386:     // This is a delayed task.
387:     newTask.sortIndex = startTime;
388:     push(timerQueue, newTask);
389:     if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
390:       // All tasks are delayed, and this is the task with the earliest delay.
391:       if (isHostTimeoutScheduled) {
392:         // Cancel an existing timeout.
393:         cancelHostTimeout();
394:       } else {
395:         isHostTimeoutScheduled = true;
396:       }
397:       // Schedule a timeout.
398:       requestHostTimeout(handleTimeout, startTime - currentTime);
399:     }
400:   } else {
401:     newTask.sortIndex = expirationTime;
402:     push(taskQueue, newTask);
403:     if (enableProfiling) {
404:       markTaskStart(newTask, currentTime);
405:       newTask.isQueued = true;
406:     }
407:     // Schedule a host callback, if needed. If we're already performing work,
408:     // wait until the next time we yield.
409:     if (!isHostCallbackScheduled && !isPerformingWork) {
410:       isHostCallbackScheduled = true;
411:       requestHostCallback();
412:     }
413:   }
414:
415:   return newTask;
416: }
```

Two branches:

**Delayed branch** (`startTime > currentTime`, lines 385–399):
1. `sortIndex = startTime` — so timerQueue is ordered by earliest fire time.
2. Push onto `timerQueue`.
3. If both of these are true:
   - `taskQueue` is empty (no ready work), AND
   - this new task is now the root of `timerQueue` (so it's the *earliest*
     delayed task, meaning it's the next thing that needs to fire),
   then we need to (re-)arm a host timeout:
   - If one was already armed (for some later timer), cancel it, because
     this new task fires sooner. Note: `isHostTimeoutScheduled` was `true`
     so we do not reassign it after cancel — we simply fall through to
     `requestHostTimeout`, which overwrites `taskTimeoutID` with the new
     handle. The flag stays `true`.
   - Otherwise, mark it scheduled.
   - Call `requestHostTimeout(handleTimeout, startTime - currentTime)`.
4. Non-obvious: if `taskQueue` is non-empty, we don't arm a new timeout at
   all — we rely on the normal host callback pump, which will call
   `advanceTimers` during its next `workLoop` anyway.
5. Non-obvious: we also don't arm a timeout if the new task is not the
   earliest in `timerQueue` — because the existing armed timeout (if any)
   will fire sooner, and when it runs `handleTimeout` will re-examine the
   heap.

**Immediate branch** (`startTime <= currentTime`, lines 400–413):
1. `sortIndex = expirationTime` — taskQueue is ordered by earliest deadline.
2. Push onto `taskQueue`.
3. Profiling: mark task start, `isQueued = true`.
4. If no host callback is currently scheduled AND we are NOT inside a
   running `flushWork` (`!isPerformingWork`), call `requestHostCallback`.
   The `!isPerformingWork` guard is important: scheduling from inside a
   workLoop callback should not cause redundant host pumps because the
   existing workLoop will pick the new task up on its next iteration.
5. If `isHostCallbackScheduled` was already true, we do nothing — the
   existing pump will handle it.

`return newTask;` at line 415 gives the caller a handle so they can later
`unstable_cancelCallback(task)`.

---

## 4. `unstable_cancelCallback` — and the Heap Non-Removal

Lines 418–431:

```
418: function unstable_cancelCallback(task: Task) {
419:   if (enableProfiling) {
420:     if (task.isQueued) {
421:       const currentTime = getCurrentTime();
422:       markTaskCanceled(task, currentTime);
423:       task.isQueued = false;
424:     }
425:   }
426:
427:   // Null out the callback to indicate the task has been canceled. (Can't
428:   // remove from the queue because you can't remove arbitrary nodes from an
429:   // array based heap, only the first one.)
430:   task.callback = null;
431: }
```

Key fact — the comment at lines 427–429 says it outright: **the task is not
removed from the heap**. The `SchedulerMinHeap` implementation only supports
`push` / `pop` / `peek`; there's no O(log n) arbitrary-node removal. So
cancellation is "tombstone" style:

- `task.callback = null` marks the task as dead.
- Later, whoever pops this task from the heap checks for null:
  - `advanceTimers` (line 107): if a timer's callback is null, it just
    `pop(timerQueue)` and moves on — it does NOT promote the task to
    `taskQueue`.
  - `workLoop` (lines 201 and 237–239): if `typeof callback !== 'function'`,
    i.e. a canceled task, we simply `pop(taskQueue)` and continue.
- Profiling side: if the task is still `isQueued` when canceled, we emit
  `markTaskCanceled` and flip `isQueued = false`. If it wasn't queued (e.g.
  double-cancel, or already popped by workLoop), we skip the mark.

Non-obvious consequences:
- Memory: a canceled delayed task stays in `timerQueue` (occupying memory
  and heap-comparison work) until either the heap pops it during the normal
  course of draining earlier timers, or it becomes ready and is immediately
  discarded by `advanceTimers`.
- A canceled task still has its `startTime` / `expirationTime` relevant for
  heap ordering until it's popped.
- You cannot "un-cancel" a task because the callback reference is already
  gone. Caller must schedule a new one.

---

## 5. `handleTimeout` — Promotion via Host Timeout

Lines 127–142:

```
127: function handleTimeout(currentTime: number) {
128:   isHostTimeoutScheduled = false;
129:   advanceTimers(currentTime);
130:
131:   if (!isHostCallbackScheduled) {
132:     if (peek(taskQueue) !== null) {
133:       isHostCallbackScheduled = true;
134:       requestHostCallback();
135:     } else {
136:       const firstTimer = peek(timerQueue);
137:       if (firstTimer !== null) {
138:         requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
139:       }
140:     }
141:   }
142: }
```

Invoked by `requestHostTimeout`, which wraps the callback in a setTimeout
closure (line 561–563). Sequence:

1. `isHostTimeoutScheduled = false` — the timer has fired, so its flag
   must be dropped before we potentially re-arm below.
2. `advanceTimers(currentTime)` — move any newly-ready delayed tasks from
   `timerQueue` into `taskQueue`.
3. If a host callback is NOT already scheduled (e.g. because we were
   previously "all delayed" with no live work), decide what to do next:
   - If `taskQueue` now has something, set `isHostCallbackScheduled = true`
     and call `requestHostCallback()` to begin the message-loop pump.
   - Else if there's still a timer pending (but none was due), arm another
     host timeout for the earliest one, but **don't set
     `isHostTimeoutScheduled`** back to true. This is a subtle behavior:
     re-arming here without flipping the flag — let's look again at the
     surrounding code to decide if that's a bug or intentional.

Looking at it carefully: line 138 calls `requestHostTimeout` without
setting `isHostTimeoutScheduled = true`. That does appear to be a gap vs.
the invariant implied by the name of the flag — but note that the only
other check of `isHostTimeoutScheduled` is in:
- `flushWork` line 151 — to decide whether to cancel an armed timeout
  before draining work, and
- `unstable_scheduleCallback` line 391 — to decide whether to cancel the
  existing armed timeout when a new earlier timer arrives.

So the consequences of the flag being "incorrectly" false after line 138:
- If `flushWork` runs later, it won't try to cancel the armed timeout. But
  by the time `flushWork` runs, `handleTimeout` has already fired, so the
  setTimeout handle is stale anyway. OK.
- If `scheduleCallback` adds an earlier timer, it will take the
  `else` branch at line 394 (`isHostTimeoutScheduled = true`) and call
  `requestHostTimeout` — overwriting `taskTimeoutID` with a new, later
  handle. The previously-armed one from line 138 is orphaned but will
  eventually fire harmlessly (it will call `handleTimeout` again, which
  will re-check the heap).

So the implementation allows orphaned timeout fires to happen; they're
idempotent because `handleTimeout` always re-reads the heap and re-decides
from scratch. This is acceptable for a work queue where spurious wakeups
are cheap.

4. If `isHostCallbackScheduled` was already true on entry, `handleTimeout`
   does nothing after advancing timers — the already-scheduled callback
   will pick up the promoted tasks during its `workLoop`.

---

## 6. `advanceTimers` — Exact Logic

Lines 103–125:

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
115:       if (enableProfiling) {
116:         markTaskStart(timer, currentTime);
117:         timer.isQueued = true;
118:       }
119:     } else {
120:       // Remaining timers are pending.
121:       return;
122:     }
123:     timer = peek(timerQueue);
124:   }
125: }
```

The loop walks the top of `timerQueue` from smallest `startTime` upward.
For each peek:

1. **Canceled entry** (`callback === null`): pop and discard — the
   cancellation tombstone is finally cleaned up here. The loop continues
   because there might be another fireable or cancelled timer behind it.
2. **Fireable entry** (`startTime <= currentTime`):
   - Pop from `timerQueue`.
   - **Rewrite `sortIndex` from `startTime` to `expirationTime`** — this is
     what flips the heap ordering key from "fire time" to "deadline".
   - Push onto `taskQueue`.
   - Profiling: mark start and set `isQueued = true`. Note the
     `markTaskStart` here at line 116 is the one called for delayed tasks;
     the immediate-branch equivalent is at line 404.
3. **Not-yet-fireable entry** (`startTime > currentTime`): return
   immediately. This relies on the min-heap invariant: if the root is not
   ready, neither is anything else.

Note: `advanceTimers` is called from three sites:
- `workLoop` entry at line 190, and again after each task at lines 223, 235.
- `handleTimeout` at line 129.

---

## 7. Host Pump Entry Points: `requestHostCallback` / `cancelHostCallback`

There is **no** `cancelHostCallback` function. Only these host-facing
functions exist:

- `requestHostCallback` (lines 549–554)
- `requestHostTimeout` (lines 556–564)
- `cancelHostTimeout` (lines 566–570)
- `schedulePerformWorkUntilDeadline` (assigned at lines 529, 538, or 543
  depending on environment — see below)
- `performWorkUntilDeadline` (lines 485–514)

### 7.1 `requestHostCallback`

```
549: function requestHostCallback() {
550:   if (!isMessageLoopRunning) {
551:     isMessageLoopRunning = true;
552:     schedulePerformWorkUntilDeadline();
553:   }
554: }
```

- Only entry point for kicking the host pump. Idempotent — if the message
  loop is already running, this is a no-op.
- When it's not running, flip the flag and ask the host to run
  `performWorkUntilDeadline` asynchronously.

Callers:
- `unstable_scheduleCallback` line 411 (immediate branch, after pushing to
  `taskQueue`).
- `handleTimeout` line 134 (after timer promotion if work is ready).

### 7.2 `schedulePerformWorkUntilDeadline` — environment selection

Lines 516–547:

```
516: let schedulePerformWorkUntilDeadline;
517: if (typeof localSetImmediate === 'function') {
518:   // Node.js and old IE.
519:   // There's a few reasons for why we prefer setImmediate.
520:   //
521:   // Unlike MessageChannel, it doesn't prevent a Node.js process from exiting.
522:   // (Even though this is a DOM fork of the Scheduler, you could get here
523:   // with a mix of Node.js 15+, which has a MessageChannel, and jsdom.)
524:   // https://github.com/facebook/react/issues/20756
525:   //
526:   // But also, it runs earlier which is the semantic we want.
527:   // If other browsers ever implement it, it's better to use it.
528:   // Although both of these would be inferior to native scheduling.
529:   schedulePerformWorkUntilDeadline = () => {
530:     localSetImmediate(performWorkUntilDeadline);
531:   };
532: } else if (typeof MessageChannel !== 'undefined') {
533:   // DOM and Worker environments.
534:   // We prefer MessageChannel because of the 4ms setTimeout clamping.
535:   const channel = new MessageChannel();
536:   const port = channel.port2;
537:   channel.port1.onmessage = performWorkUntilDeadline;
538:   schedulePerformWorkUntilDeadline = () => {
539:     port.postMessage(null);
540:   };
541: } else {
542:   // We should only fallback here in non-browser environments.
543:   schedulePerformWorkUntilDeadline = () => {
544:     // $FlowFixMe[not-a-function] nullable value
545:     localSetTimeout(performWorkUntilDeadline, 0);
546:   };
547: }
```

Three tiers, picked once at module init:

1. **`setImmediate`** (Node.js / jsdom): preferred because
   (a) it doesn't block Node process exit the way MessageChannel does
   (GitHub issue 20756 cited in the comment), and (b) it "runs earlier
   which is the semantic we want".
2. **`MessageChannel`** (browsers + workers): preferred over `setTimeout`
   because `setTimeout` has a 4ms clamp in browsers, which would make
   chained work callbacks needlessly slow. The channel is created once at
   module init and `channel.port1.onmessage` is wired directly to
   `performWorkUntilDeadline`.
3. **`setTimeout(fn, 0)`**: last-resort fallback for oddball non-browser
   environments without `setImmediate` or `MessageChannel`.

### 7.3 `performWorkUntilDeadline`

Lines 485–514:

```
485: const performWorkUntilDeadline = () => {
486:   if (enableRequestPaint) {
487:     needsPaint = false;
488:   }
489:   if (isMessageLoopRunning) {
490:     const currentTime = getCurrentTime();
491:     // Keep track of the start time so we can measure how long the main thread
492:     // has been blocked.
493:     startTime = currentTime;
494:
495:     // If a scheduler task throws, exit the current browser task so the
496:     // error can be observed.
497:     //
498:     // Intentionally not using a try-catch, since that makes some debugging
499:     // techniques harder. Instead, if `flushWork` errors, then `hasMoreWork` will
500:     // remain true, and we'll continue the work loop.
501:     let hasMoreWork = true;
502:     try {
503:       hasMoreWork = flushWork(currentTime);
504:     } finally {
505:       if (hasMoreWork) {
506:         // If there's more work, schedule the next message event at the end
507:         // of the preceding one.
508:         schedulePerformWorkUntilDeadline();
509:       } else {
510:         isMessageLoopRunning = false;
511:       }
512:     }
513:   }
514: };
```

- Entry point for the host pump. Runs each message tick.
- Line 486–488: Clear `needsPaint` at the start of each browser task.
- Line 489: Re-check `isMessageLoopRunning` — if it was flipped off (e.g. by
  a previous turn that finished all work), just return.
- Line 493: Snapshot `startTime` (module-level, = "time the current browser
  task began") so `shouldYieldToHost` can measure elapsed time.
- Line 502–503: Run `flushWork` which runs the real `workLoop`.
- Line 504–512: `finally` so even if `flushWork` throws, we still decide
  whether to re-post the message.
  - If `hasMoreWork`, call `schedulePerformWorkUntilDeadline()` again to
    yield to the host but queue another turn.
  - Else, set `isMessageLoopRunning = false`, letting a future
    `requestHostCallback` restart the pump.
- The comment at lines 495–500 explains why there's no try/catch: they
  deliberately let errors propagate out so debugger "break on exceptions"
  works; on throw, `hasMoreWork` stays `true` (initialized at line 501), so
  the pump keeps running even through errors.

### 7.4 `requestHostTimeout` / `cancelHostTimeout`

Lines 556–570:

```
556: function requestHostTimeout(
557:   callback: (currentTime: number) => void,
558:   ms: number,
559: ) {
560:   // $FlowFixMe[not-a-function] nullable value
561:   taskTimeoutID = localSetTimeout(() => {
562:     callback(getCurrentTime());
563:   }, ms);
564: }
565:
566: function cancelHostTimeout() {
567:   // $FlowFixMe[not-a-function] nullable value
568:   localClearTimeout(taskTimeoutID);
569:   taskTimeoutID = ((-1: any): TimeoutID);
570: }
```

- `requestHostTimeout` wraps `callback` in a closure that reads the clock at
  fire time (not schedule time) so `handleTimeout` gets accurate `currentTime`.
- Overwrites `taskTimeoutID` each call, which is OK because the caller is
  responsible for canceling any previously armed timeout before re-arming.
  (The only callers are line 398 in `scheduleCallback` — which cancels just
  above at line 393 — and line 138 / 254 from `handleTimeout` / `workLoop`,
  where the prior one has already fired.)
- `cancelHostTimeout` clears the handle and resets to `-1`.

### 7.5 Where "cancelHostCallback" would go

There is simply no "cancel the pending message pump" operation. Once
`requestHostCallback` has posted to the port / immediate, there's no way
to un-post it. The design instead:
- Lets the message arrive even if work was transiently unneeded.
- `performWorkUntilDeadline` re-reads `isMessageLoopRunning` on entry
  (line 489) and can bail.
- `flushWork` re-reads the heaps and can return immediately with `false`
  (no more work) if there's nothing to do.

So the effective "cancel" is: flip `isMessageLoopRunning = false`, and the
queued message will be ignored on dispatch. That flag is managed by
`performWorkUntilDeadline` itself (line 510), not by any public API.

---

## 8. `unstable_forceFrameRate` — Adjusting `frameInterval`

Lines 468–483 (see the excerpt in section 2.10).

Behavior:
- Input validation: `fps` must be in `[0, 125]` inclusive; anything else
  logs a `console['error']` and returns without changing state. The
  `console['error']` bracket notation is deliberate — the comment at line
  470 explains it's to "evade Babel and ESLint", which presumably would
  otherwise rewrite/flag `console.error`.
- If `fps > 0`: `frameInterval = Math.floor(1000 / fps)`. So
  `forceFrameRate(60)` ⇒ `frameInterval = 16` ms,
  `forceFrameRate(120)` ⇒ `8`,
  `forceFrameRate(125)` ⇒ `8` (still; `1000/125 = 8` exactly),
  `forceFrameRate(30)` ⇒ `33`.
- If `fps === 0`: reset to the default `frameYieldMs` (`5` ms per current
  feature flag). The comment at line 480 labels this explicitly:
  "reset the framerate".
- If `fps < 0` or `fps > 125`: error log, no state change.

The `frameInterval` is then used by `shouldYieldToHost` to decide whether
the current browser task has consumed enough time to warrant yielding.
Lower frame rates (longer intervals) mean the scheduler holds the main
thread longer per turn; higher rates yield more often.

Non-obvious: "frame rate" here is not actually frame-aligned in any real
sense. See the header comment at lines 440–443:

```
440: // Scheduler periodically yields in case there is other work on the main
441: // thread, like user events. By default, it yields multiple times per frame.
442: // It does not attempt to align with frame boundaries, since most tasks don't
443: // need to be frame aligned; for those that do, use requestAnimationFrame.
```

So `forceFrameRate` is really "force how many ms of wall clock the scheduler
burns before yielding" — `frameInterval` is a slice length, not a cadence.
The `fps` framing is a convenience abstraction.

---

## 9. `unstable_pauseExecution` / `unstable_continueExecution` — NOT PRESENT

**These do not exist in this file.** There is no `isSchedulerPaused` flag,
no pause export, no pause check anywhere in `workLoop` or `flushWork`.

Grep confirmation (from file):

```
pattern: pauseExecution|continueExecution|isSchedulerPaused|cancelHostCallback|getFirstCallbackNode
result: No matches found
```

If a previous generation of React's Scheduler had these, they've been
removed here. The related semantics — "make the scheduler go idle without
losing pending work" — are not available via the public API in this file.

Note that `SchedulerMock.js` (the sibling fork at
`/home/john/kanban/data/repos/react/packages/scheduler/src/forks/SchedulerMock.js`)
is a different file used for testing and may implement pause-style helpers
for tests that want deterministic control over the scheduler. This
findings doc is specifically about `Scheduler.js`.

---

## 10. Cross-References: Related Files

- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerFeatureFlags.js`
  — default values of `frameYieldMs = 5`, `userBlockingPriorityTimeout = 250`,
  `normalPriorityTimeout = 5000`, `lowPriorityTimeout = 10000`,
  `enableProfiling = false`, `enableRequestPaint = true`,
  `enableAlwaysYieldScheduler = __EXPERIMENTAL__`.
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerMinHeap.js`
  — `push` / `pop` / `peek` with ordering by `sortIndex` (ties broken by
  `id`). Does NOT support arbitrary-node removal, which is why
  `unstable_cancelCallback` tombstones with `callback = null` instead.
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerPriorities.js`
  — the 5 `PriorityLevel` constants.
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerProfiling.js`
  — `markTask*` / `markScheduler*` / `start/stopLoggingProfilingEvents`.
- `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/SchedulerMock.js`
  — the test-only fork of the scheduler.

---

## 11. Quick Reference: Line Number Index

| Item | Line(s) |
| --- | --- |
| `getCurrentTime` declaration & assignment | 59, 66, 70 |
| `maxSigned31BitInt` | 76 |
| `taskQueue` | 79 |
| `timerQueue` | 80 |
| `taskIdCounter` | 83 |
| `currentTask` | 85 |
| `currentPriorityLevel` | 86 |
| `isPerformingWork` | 89 |
| `isHostCallbackScheduled` | 91 |
| `isHostTimeoutScheduled` | 92 |
| `needsPaint` | 94 |
| `localSetTimeout` / `localClearTimeout` / `localSetImmediate` | 97–101 |
| `advanceTimers` | 103–125 |
| `handleTimeout` | 127–142 |
| `flushWork` | 144–186 |
| `workLoop` | 188–258 |
| `unstable_runWithPriority` | 260–283 |
| `unstable_next` | 285–308 |
| `unstable_wrapCallback` | 310–325 |
| `unstable_scheduleCallback` | 327–416 |
| startTime computation | 332–344 |
| timeout/expirationTime switch | 346–371 |
| newTask construction | 373–383 |
| delayed-branch heap push | 385–399 |
| immediate-branch heap push | 400–413 |
| `unstable_cancelCallback` | 418–431 |
| `unstable_getCurrentPriorityLevel` | 433–435 |
| `isMessageLoopRunning` | 437 |
| `taskTimeoutID` | 438 |
| `frameInterval` | 444 |
| `startTime` (module-level) | 445 |
| `shouldYieldToHost` | 447–460 |
| `requestPaint` | 462–466 |
| `forceFrameRate` | 468–483 |
| `performWorkUntilDeadline` | 485–514 |
| `schedulePerformWorkUntilDeadline` environment selection | 516–547 |
| `requestHostCallback` | 549–554 |
| `requestHostTimeout` | 556–564 |
| `cancelHostTimeout` | 566–570 |
| Public export block | 572–588 |
| `unstable_Profiling` export | 590–598 |
