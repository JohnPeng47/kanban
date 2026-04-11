# Critique of `base.html` React Scheduler Diagram

Source doc: `/home/john/kanban/experiment/iter-1/source-doc.md`
Diagram: `/home/john/kanban/data/repos/react/diagrams/layout3/scheduler-detail/base.html`
Sub-pages reviewed: `message-channel.html`, `continuation.html`, `preemption.html`.

---

## Summary — the five biggest gaps

1. **The entire host-pump fallback chain is missing.** The diagram (and the
   `message-channel.html` expansion) present MessageChannel as THE choice.
   In reality there is a 3-tier cascade picked once at module init:
   `setImmediate` (Node / IE, preferred even over MessageChannel) →
   `MessageChannel` (browser / Worker) → `setTimeout(fn, 0)` (exotic hosts).
   The reasoning (Node process-alive issue #20756, 4 ms clamp after 5
   levels of nesting) is what makes the code interesting and is entirely
   absent.

2. **Module-level state is under-represented.** The diagram names
   `taskQueue` and `timerQueue` but the source doc lists ~15 module-level
   variables that drive the entire state machine: `currentTask`,
   `currentPriorityLevel`, `isPerformingWork` (re-entrance guard),
   `isHostCallbackScheduled`, `isHostTimeoutScheduled`,
   `isMessageLoopRunning`, `needsPaint`, `frameInterval`, `startTime`
   (slice anchor, NOT Task.startTime), `taskTimeoutID`, `taskIdCounter`,
   and the captured `localSetTimeout`/`localClearTimeout`/`localSetImmediate`.
   These are load-bearing for understanding flow control, error recovery,
   and the continuation mechanic.

3. **The `handleTimeout` host-timeout path is completely absent.** The
   diagram shows `advanceTimers()` as an arrow from timerQueue → taskQueue
   but never explains what WAKES the scheduler for a delayed task that
   arrives before any ready work. That mechanism is
   `requestHostTimeout(handleTimeout, startTime - now)` using a real
   `setTimeout`, and it is an entirely separate pump from MessageChannel.
   `taskTimeoutID`, `cancelHostTimeout`, `handleTimeout` — all missing.

4. **Several facts on the diagram are flatly incorrect.** The most serious
   are in `preemption.html`, which the doc contradicts:
   - "User clicks a button (SyncLane → ImmediatePriority)" — wrong twice.
     SyncLane **bypasses the scheduler entirely** via microtask; it never
     reaches the heap. Clicks go through the scheduler as
     `UserBlockingPriority` (250 ms timeout), not Immediate. Source doc
     §4.5, §12.7, §15.6.
   - "click(100)" sortIndex — wrong. UserBlocking gives
     `startTime + 250`, not `100`. Source doc §4.3.
   - `message-channel.html` says "setTimeout: 4ms minimum delay" — this is
     only true after 5 levels of nesting per HTML spec; the label
     oversimplifies and loses the "why" (source doc §9.2).
   - `base.html` lists "Idle: ~12 days" — should be `~12.43 days` /
     `1073741823 ms` / `2^30 - 1`. The "31-bit" naming + V8 SMI reason
     is the whole point and is missing.

5. **The continuation mechanic is described but the invariant that makes
   it work is absent.** The doc emphasises: `task.callback` is mutated
   in place, `sortIndex` / `expirationTime` / `id` NEVER change, heap
   position is NOT touched, and the `Task` reference is stable across
   slices (load-bearing for `root.callbackNode === originalCallbackNode`
   in the reconciler). The diagram merely says "task stays in heap". The
   pre-invocation tombstone (`callback = null` BEFORE invocation) and
   the reason (prevents infinite re-throw of thrown tasks) are also
   missing.

---

## 1. Missing concepts (explained in doc, not depicted)

- **`isPerformingWork` re-entrance guard** (doc §2.6, §6.1, §7.3).
  Line 89 of Scheduler.js. Used at line 409 in `scheduleCallback` so that
  scheduling a new task from *inside* a running callback does NOT spawn
  another MessageChannel pump — the already-running loop will pick it up
  on its next iteration. This is one of the scheduler's cleverer pieces of
  state and the diagram's "more work → post message" flow ignores the case
  entirely.

- **`isMessageLoopRunning` / `requestHostCallback` idempotence**
  (doc §2.9, §9.4). `requestHostCallback` is a no-op if the pump is
  already running. There is NO `cancelHostCallback`. The "effective
  cancel" is flipping `isMessageLoopRunning = false` so the pump bails
  at line 489.

- **`hasMoreWork = true` self-healing trick** (doc §7.4, §14.2,
  gotcha #14). `let hasMoreWork = true;` is declared BEFORE the try so
  that when `flushWork` throws, the assignment never runs, the finally
  sees `hasMoreWork === true`, and the pump reschedules automatically
  while the error propagates to `window.onerror`. The diagram does not
  show error handling at all.

- **`needsPaint` flag and its one-frame-crossing invariant** (doc §2.7,
  §8.4, gotcha #30). Set by `requestPaint()`; read by `shouldYieldToHost`;
  cleared at the START of the slice AFTER yielding. This guarantees at
  least one browser frame boundary between "paint requested" and "paint
  cleared." The diagram mentions "needsPaint? → yield" but never shows
  where it's set, cleared, or why the ordering matters.

- **`startTime` module variable vs `Task.startTime` naming collision**
  (doc §2.10, §8.3, gotcha #22). The module-level `startTime` is the
  per-slice anchor written at line 493 inside `performWorkUntilDeadline`.
  Completely different from `Task.startTime` (earliest wall time a task
  may run). The diagram never mentions the module variable and never
  shows where the frame budget is sampled.

- **`currentTask` as a module-level pointer** (doc §2.5, gotcha #6).
  Written at line 191 and 240, cleared in `flushWork`'s finally at line
  178. The diagram writes `currentTask` inside the while loop but treats
  it like a local; the fact that it lives at module scope is what lets
  the profiling error-tap at line 164 access "the currently executing
  task" from outside the loop.

- **`currentPriorityLevel` as an AMBIENT state** (doc §2.5, §4.4,
  gotcha #23). The ambient priority is set per-task at line 205, but is
  NOT unwound between tasks inside a single `workLoop` — only in
  `flushWork`'s finally. `unstable_runWithPriority`, `unstable_next`,
  `unstable_wrapCallback` all manipulate it. None of this is in the
  diagram.

- **Pre-invocation tombstone** (doc §7.1, §10.2 (B), §14.3, gotcha #7).
  Line 203: `currentTask.callback = null;` runs **before** line 212
  invokes the callback. If this order were reversed a throwing task
  would be re-invoked infinitely. This is also what makes cancellation
  and throw-survival composable: a throwing task is already a tombstone
  by the time the exception propagates.

- **Defensive completion pop guard** (doc §7.1 step 7, §10.2 (H),
  gotcha #11). Line 232: `if (currentTask === peek(taskQueue)) pop(taskQueue);`.
  The user callback can schedule a more urgent task; if so the current
  task is no longer the root, and leaving it (with `callback = null`)
  creates a tombstone for later. The diagram shows pop unconditionally.

- **Post-callback clock refresh** (doc §7.1 step 7, §10.2 (D),
  gotcha #9). Line 213: `currentTime = getCurrentTime();` immediately
  after the callback returns. Without it, the subsequent
  `advanceTimers(currentTime)` would use a stale clock and miss timers
  that fired during the long callback.

- **The three-call pattern of `advanceTimers`** (doc §6.3). Called at
  workLoop entry (190), before continuation yield (223), after task
  completion (235), and by `handleTimeout` (129). The diagram shows ONE
  arrow labelled "advanceTimers()" on the timerQueue ↔ taskQueue edge.

- **`hasMoreWork` vs the two-branch return of `workLoop`** (doc §7.2).
  `workLoop` returns `true` from TWO different places (line 224 for
  continuation, line 250 for deadline break) and `false` from line 256
  (heap drained — this is also where the host timeout is armed for the
  next timer). Diagram shows a single undifferentiated "more work / no
  more work" split without the third "arm host timeout for next delayed
  task" case.

- **The `enableAlwaysYieldScheduler` experimental mode** (doc §12.8,
  gotcha #27). Flips yielding upside-down: skip top-of-loop check, add
  bottom-of-loop check, short-circuit `needsPaint`. Run exactly one
  expired task then yield. Gated on `__EXPERIMENTAL__`. The diagram
  doesn't mention it.

- **`enableThrottledScheduling` and the 25 ms slice** (doc §15.4). An
  alternative `workLoopConcurrent` with a 25 ms slice for non-idle
  transitions and 5 ms for idle lanes. Not in the diagram.

---

## 2. Missing data (tables, constants, thresholds, line numbers)

- **Precise idle timeout**: the diagram writes "Idle: ~12 days." Correct
  value is `1073741823 ms ≈ 12.4259 days` = `2^30 - 1` = `maxSigned31BitInt`
  at line 76. Doc §2.2, §4.2, §13.1, gotcha #1.

- **The 31-bit SMI rationale**: `2^30 - 1`, not `2^31 - 1`, so V8 SMI-tags
  it on 32-bit systems. Source doc §2.2.

- **Feature-flag defaults with line numbers**: `frameYieldMs = 5` in
  prod and native-fb, `10` in www build. `userBlockingPriorityTimeout = 250`,
  `normalPriorityTimeout = 5000`, `lowPriorityTimeout = 10000`,
  `enableRequestPaint = true`. All in `SchedulerFeatureFlags.js` lines
  10–18. The diagram has the timeout numbers in passing but not the
  fork variation.

- **`forceFrameRate` validation**: `[0, 125]` inclusive, `fps > 0 →
  frameInterval = Math.floor(1000 / fps)`, `fps = 0` resets to
  `frameYieldMs`. The 125 fps cap corresponds to `frameInterval = 8 ms`,
  which is *looser* than the 5 ms default. See doc §5.10, gotcha #16, #17.

- **Line numbers for every function** (doc §17): `advanceTimers` 103–125,
  `handleTimeout` 127–142, `flushWork` 144–186, `workLoop` 188–258,
  `unstable_scheduleCallback` 327–416, `unstable_cancelCallback` 418–431,
  `shouldYieldToHost` 447–460, `performWorkUntilDeadline` 485–514,
  `requestHostCallback` 549–554, `requestHostTimeout` 556–564,
  `cancelHostTimeout` 566–570, etc. The diagram's line refs are often
  wrong or stale (e.g. `scheduleCallback` ref at line 300, actual 327;
  `workLoop` ref at line 400, actual 188; `shouldYieldToHost` ref at
  480, actual 447).

- **Heap API cost table** (doc §3.2): `peek` O(1), `push` O(log n),
  `pop` O(log n), `cancelCallback` O(1), `advanceTimers` draining k
  timers O(k log n). The "only the root can be popped" constraint is
  WHY cancellation is lazy.

- **Heap comparator** (doc §3.2): primary `sortIndex`, secondary `id`
  (FIFO tiebreaker). Expressed as `const diff = a.sortIndex - b.sortIndex;
  return diff !== 0 ? diff : a.id - b.id;`. The diagram never shows the
  comparator and so can't explain why FIFO holds at equal priority.

- **Priority → scheduler timeout → expirationTime math** (doc §4.3).
  `expirationTime = startTime + timeout`. Immediate = `startTime - 1`
  (always expired); UserBlocking = `+ 250`; Normal = `+ 5000`;
  Low = `+ 10000`; Idle = `+ 1073741823`. Diagram has the timeouts
  inline in one long text line but never shows the addition.

- **Reconciler-side call sites** (doc §15.2): the main production path
  is `ReactFiberRootScheduler.js:500–503`, and there are ~10 other call
  sites (cache abort, passive-effect flush, post-paint transition
  callbacks, Safari microtask fallbacks).

---

## 3. Missing edge cases

- **What happens when a task throws** (doc §14, gotchas #14, #15).
  No try/catch in production path. Exception propagates
  `callback()` → `workLoop` → `flushWork` (outer finally restores state)
  → `performWorkUntilDeadline` (finally uses `hasMoreWork = true` initial
  value to reschedule pump) → browser's top-level handler. Self-healing.

- **Lazy cancellation cleanup flow** (doc §11). `unstable_cancelCallback`
  → `task.callback = null` → the task sits in the heap until it floats
  to the root → `advanceTimers` drops it (for timerQueue) or workLoop's
  else-branch pops it (for taskQueue). The diagram shows "pop on null
  return" but never shows that EXTERNAL cancellation is also a path to
  that else-branch.

- **Why the task is NOT popped before continuation** (doc §10.3,
  gotcha #10). The continuation mutates `callback` in place; sortIndex,
  expirationTime, id, and physical position in the heap are all
  unchanged. The Task REFERENCE is stable, which is the invariant
  `root.callbackNode === originalCallbackNode` depends on.

- **Cancelled branch of workLoop** (doc §7.1 step 8, §10.2 (I),
  lines 237–238). `else { pop(taskQueue); }` — when `callback === null`
  on entry, the task is known to be the root and is popped
  unconditionally.

- **`delay: 0` is NOT a delay** (doc §6.1, gotcha #2). Strict `> 0`
  check; `{delay: 0}` falls through to immediate branch.

- **`NoPriority` sentinel falls through to NormalPriority** (doc §4.1,
  gotcha #3). Not a valid `scheduleCallback` argument.

- **`unstable_next` never promotes** (doc §5.5, gotcha #25). Immediate /
  UserBlocking / Normal → Normal; Low / Idle pass through.

- **Two-level error handling in profiling mode** (doc §7.3, §14.1
  layer 2). Inner try/catch to tap `markTaskErrored` while `currentTask`
  is still live, outer try/finally for state restoration. Re-throw, never
  swallow. The only `catch` in the scheduler is this error tap.

- **Orphaned host-timeout in `handleTimeout`** (doc §6.6 note, gotcha #12).
  Line 138 calls `requestHostTimeout` without setting
  `isHostTimeoutScheduled = true`. Orphaned timeouts fire harmlessly
  because `handleTimeout` is idempotent.

- **Sort-index rewrite mid-promotion** (doc §3.4, §6.3). In
  `advanceTimers`, `timer.sortIndex = timer.expirationTime;` is
  performed AFTER `pop(timerQueue)` and BEFORE `push(taskQueue)` —
  so at no point is a node present in a heap with the wrong sortIndex.

---

## 4. Incorrect information in the diagram

**`base.html`:**
- **"Idle: ~12 days"** is wrong by half a day. Should be `~12.43 days`
  (`1073741823 ms`). Doc §2.2.
- **`data-ref` line numbers are stale**. E.g.
  `scheduleCallback` is at line 327, not 300;
  `workLoop` is at 188, not 400;
  `shouldYieldToHost` is at 447, not 480;
  `performWorkUntilDeadline` is at 485, not 530;
  `unstable_cancelCallback` is at 418, not 455;
  `taskQueue`/`timerQueue` are declared at lines 79–80, not 53–54.
  All `data-ref` attributes should be audited against doc §17.
- The arrow labelled "React reconciler calls scheduleCallback(priority,
  callback)" oversimplifies: the real call is
  `scheduleCallback(schedulerPriorityLevel,
  performWorkOnRootViaSchedulerTask.bind(null, root))` with the handle
  stored on `root.callbackNode`. Doc §15.2.

**`message-channel.html`:**
- **"setTimeout: 4ms minimum delay (wastes time)"** — the 4 ms clamp
  only kicks in after 5 nested levels per HTML spec. Below that,
  `setTimeout(fn, 0)` is not clamped. Doc §9.2 tier 3.
- **"requestAnimationFrame: frame-aligned ~16ms (too slow)"** — this is
  misleading. rAF isn't wrong because of latency; it's wrong because
  it's paused in background tabs and cannot express "yield multiple
  times per frame" (doc §8.5).
- **Entire document pretends MessageChannel is the only option** — no
  mention of setImmediate or the setTimeout fallback (doc §9.1).
- **"BROWSER NOTIFICATION — MessageChannel"** as the header is a fine
  label, but the sub-page never says WHY Node/IE prefer `setImmediate`
  (issue #20756: MessageChannel keeps Node process alive).

**`preemption.html`:**
- **"User clicks a button (SyncLane → ImmediatePriority)"** — double
  error.
  1. SyncLane work bypasses the Scheduler entirely via microtask in
     `processRootScheduleInMicrotask` (doc §4.5, §15.6). It never
     touches the scheduler heap.
  2. When a click DOES go through the scheduler (discrete event priority),
     it maps to `UserBlockingPriority`, not `ImmediatePriority`
     (doc §12.7).
- **"click(100)"** sortIndex — wrong. `UserBlockingPriority` timeout is
  `250 ms`, so `expirationTime = startTime + 250 ≈ 250` (close to the
  moment of click), not `100`. Doc §4.3.
- **"SyncLane: no yielding, runs in one shot"** — the green box next to
  the "click render executes" step. Internally consistent with their
  wrong claim above, but compounds the error.
- The preemption narrative ends at "Reconciler restarts →
  `prepareFreshStack()` → new WIP tree from scratch" which is correct,
  but misses the "render must be side-effect-free" is WHY this works,
  and also the step where the scheduler's min-heap re-roots via
  `siftUp` on push. Doc §12.4.

**`continuation.html`:**
- **Code excerpt shows `performWorkOnRoot(root, lanes, didTimeout)`** —
  close but not quite. The actual entry on the Scheduler side is
  `performWorkOnRootViaSchedulerTask(root, didTimeout)`; it INTERNALLY
  calls `performWorkOnRoot(root, lanes, forceSync)`. The shown signature
  is an amalgamation. Doc §10.4, §15.3.
- **`return performWorkOnRoot.bind(null, root, lanes)`** is close but
  the real code is `return performWorkOnRootViaSchedulerTask.bind(null, root)`
  (no `lanes` in the bind — lanes are recomputed on each slice). Doc §15.3.
- **Missing the identity check**: `root.callbackNode === originalCallbackNode`
  is what decides between "return continuation" and "return null". The
  sub-page skips it.
- **Missing `forceSync = didTimeout`** bridge between the scheduler's
  `didTimeout` argument and the reconciler's sync-render switch (doc
  §10.4, §13.2).

---

## 5. Missing relationships / arrows

- **`unstable_cancelCallback` → `task.callback = null` → lazy cleanup in
  workLoop / advanceTimers**. There is no arrow at all from "cancel"
  into the work loop's cleanup branch. Doc §11.2.

- **`root.callbackNode` → Scheduler task handle → reuse vs cancel+reschedule**.
  The diagram never depicts `root.callbackNode` as a pointer to the
  Scheduler's Task, nor the reconciler's cancel-old/schedule-new sequence
  on priority change (doc §11.4, §15.5).

- **`scheduleCallback` → `requestHostCallback` → `isMessageLoopRunning`
  flag → `schedulePerformWorkUntilDeadline` → MessageChannel post**.
  The diagram collapses this into one arrow but the flag cascade is
  where the re-entrance guard lives. Doc §6.1, §9.4.

- **`handleTimeout` → `advanceTimers` → either `requestHostCallback` or
  re-arm `requestHostTimeout` for the next timer**. Entire branch absent.
  Doc §6.6.

- **`performWorkUntilDeadline` finally → `schedulePerformWorkUntilDeadline`
  iff `hasMoreWork` else `isMessageLoopRunning = false`**. Present but
  the self-healing case (error path) is missing.

- **`workLoop` completion branch → arm host timeout for next delayed
  task**. Lines 252–255 in the doc: if heap empty but `timerQueue` still
  has entries, call `requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime)`
  before returning false. Diagram has no arrow for this "wake me up when
  the next timer fires" edge.

- **Reconciler `lanesToEventPriority` → `schedulerPriorityLevel`**. The
  lane→event→scheduler priority mapping (doc §12.7) is entirely missing.

---

## 6. Missing module-level state (explicit call-out)

The doc's Quick State Summary table lists (doc §2.11):

| Variable | Purpose | In diagram? |
|---|---|---|
| `getCurrentTime` | Time source (perf.now or Date.now fallback) | no |
| `maxSigned31BitInt` | Idle timeout sentinel | no |
| `taskQueue` | Ready min-heap | yes |
| `timerQueue` | Delayed min-heap | yes |
| `taskIdCounter` | FIFO tiebreaker | no |
| `currentTask` | In-flight task pointer | partial (as local) |
| `currentPriorityLevel` | Ambient priority | no |
| `isPerformingWork` | Re-entrance guard | no |
| `isHostCallbackScheduled` | Pump-scheduled flag | no |
| `isHostTimeoutScheduled` | Timer-scheduled flag | no |
| `needsPaint` | Paint-yield flag | mentioned, not shown |
| `localSetTimeout`/`localClearTimeout`/`localSetImmediate` | Captured host APIs | no |
| `isMessageLoopRunning` | Pump guard | no |
| `taskTimeoutID` | Host-timeout handle | no |
| `frameInterval` | Slice budget | mentioned (5 ms only) |
| `startTime` | Per-slice anchor | no |

A "module state" callout box would be trivially high-impact.

---

## 7. Missing public API surface

The diagram shows `scheduleCallback` and nothing else. The doc §5 lists
16 exports. Missing entirely:

- `unstable_runWithPriority` — save/swap/restore ambient priority.
- `unstable_next` — demote-to-Normal helper (never promote).
- `unstable_wrapCallback` — capture priority at wrap time.
- `unstable_getCurrentPriorityLevel`.
- `unstable_cancelCallback` — lazy tombstone cancellation.
- `unstable_shouldYield` (exported `shouldYieldToHost`).
- `unstable_requestPaint` (exported `requestPaint`).
- `unstable_forceFrameRate` (exported `forceFrameRate`).
- `unstable_now` (exported `getCurrentTime`).
- The `unstable_Profiling` object (null unless profiling enabled).
- The five priority constants exported as `unstable_*Priority`.

Also missing: doc §5.11 "APIs that no longer exist" — `unstable_pauseExecution`,
`unstable_continueExecution`, `unstable_getFirstCallbackNode`,
`cancelHostCallback`, `isSchedulerPaused`, `enableIsInputPending`,
`isInputPending`, `continuousYieldTime`, `maxYieldInterval`. Useful for
readers who've seen older docs/articles.

---

## 8. Missing reconciler integration

The diagram arrow just says "React reconciler calls scheduleCallback(priority,
callback)". The real story (doc §15) needs:

- **`performWorkOnRootViaSchedulerTask(root, didTimeout)`** — the actual
  callback that gets scheduled. Signature matches Scheduler's
  `Callback = (boolean) => ?Callback`.
- **`root.callbackNode`** — the Scheduler Task handle stored on the
  FiberRoot.
- **`root.callbackPriority`** — the lane used when this task was scheduled.
- **`originalCallbackNode = root.callbackNode`** — captured at entry for
  the identity check.
- **`lanesToEventPriority` → `schedulerPriorityLevel`** mapping (doc §12.7):
  Discrete/Continuous → UserBlocking, Default → Normal, Idle → Idle.
- **`forceSync = didTimeout`** bridge: when the Scheduler's
  `didUserCallbackTimeout` is true, the reconciler flips
  `performWorkOnRoot` into synchronous rendering (doc §10.4, §13).
- **`performWorkOnRoot` return → `scheduleTaskForRootDuringMicrotask` →
  identity check → return bound continuation OR null** (doc §10.4).
- **`workLoopConcurrentByScheduler` polls `shouldYield()`** — the same
  `shouldYieldToHost` function that workLoop calls, shared clock on
  both sides (doc §12.3, §15.4).
- **Sync work bypass** — `SyncLane` does NOT enter the scheduler. It's
  flushed via `queueMicrotask` in `processRootScheduleInMicrotask`
  (doc §4.5, §15.6). This is critical context for the preemption story.

---

## 9. Missing preemption mechanics

Diagram shows the narrative (transition → click → resume → restart) but
hides the mechanism. Missing:

- **`siftUp` on `push`**: when the click task is pushed, `SchedulerMinHeap.push`
  runs `siftUp` which compares `sortIndex` with parents and bubbles up.
  Because the click's `sortIndex` (~250 for UserBlocking) is smaller than
  the transition's (~5000), the new task becomes the heap root. Doc §3.2,
  §12.4.
- **`peek(taskQueue) !== (old task)` on next slice**: the next
  `performWorkUntilDeadline` invocation calls `peek` and naturally finds
  the new root — no explicit "preempt" code path.
- **"Preemption is a heap re-root between macrotasks, not during one"**
  — this one-line insight from doc §12.1 is the whole thesis and should
  be prominent.
- **Reconciler-level `prepareFreshStack`** as distinct from Scheduler-level
  heap re-root — two different mechanisms layered (doc §12.6 table).

---

## 10. Missing error handling

Diagram has no error story at all. The doc dedicates §14 to this. Things
the diagram should say:

- **No try/catch around `callback()`** in production (line 212 of
  Scheduler.js). Errors propagate.
- **Inner try/catch only in profiling mode**, only to re-throw after
  `markTaskErrored`. "The only catch in the scheduler is an error tap."
- **`performWorkUntilDeadline` finally** self-heals via `let hasMoreWork = true`
  initialized BEFORE the try.
- **Throwing task → pre-invocation tombstone** means the task is popped
  on the next slice via the else-branch, never re-invoked.
- **`flushWork` outer finally** unconditionally restores `currentTask`,
  `currentPriorityLevel`, `isPerformingWork` regardless of throw / return.

The doc even quotes the design comment (lines 495–500 of Scheduler.js):

> // Intentionally not using a try-catch, since that makes some debugging
> // techniques harder. Instead, if `flushWork` errors, then `hasMoreWork`
> // will remain true, and we'll continue the work loop.

That sentence would be perfect for a callout in the diagram.

---

## 11. Missing starvation-prevention detail

The diagram says "expired (expirationTime <= now)? → skip check, run
immediately." Good. Missing:

- **Exact yield formula**: `if (currentTask.expirationTime > currentTime
  && shouldYieldToHost()) break;` — both conjuncts matter (doc §7.1 step
  5, §13.1).
- **The reconciler side**: when the scheduler reports `didTimeout = true`,
  `performWorkOnRootViaSchedulerTask` sets `forceSync = true`, which
  makes `performWorkOnRoot` call `renderRootSync` instead of
  `renderRootConcurrent`. Render switches from time-sliced to
  synchronous. Doc §10.4, §13.2.
- **`markStarvedLanesAsExpired` / `includesExpiredLane`** on the reconciler
  side (doc §13.3): reconciler has its OWN expiration check that also
  flips `shouldTimeSlice` to false. Two layers compose.
- **The practical starvation table** (doc §13.1):
  - Immediate: instantly non-yieldable
  - UserBlocking: after 250 ms
  - Normal: after 5000 ms
  - Low: after 10000 ms
  - Idle: after ~12.43 days (effectively never)

---

## 12. Missing host pump fallback chain

Diagram / `message-channel.html` presents MessageChannel as THE mechanism.
Reality (doc §9.1, §9.2, gotchas #20, #21):

**Tier 1: `setImmediate`** (Node / legacy IE / jsdom — preferred even
when MessageChannel is available).
- Doesn't keep Node process alive (GH issue facebook/react#20756).
- Runs earlier in Node's event loop phases than setTimeout.
- Node+jsdom tests still pick setImmediate because of capture-at-init.

**Tier 2: `MessageChannel`** (browsers, Workers).
- Not clamped by HTML 5-nesting / 4 ms rule.
- Background-tab throttled ~1/min.
- Keeps Node process alive (why Node uses setImmediate).

**Tier 3: `setTimeout(fn, 0)`** (exotic non-browser, non-Node hosts).
- Pays full 4 ms clamp after 5 nestings.
- Heavy background throttling.

The selector at Scheduler.js lines 516–547 runs ONCE at module init,
captures references to `localSetImmediate` / `MessageChannel` / `localSetTimeout`
to evade later polyfill / zone.js / fake-timer monkey-patching, and picks
the first that's available. None of this is in the diagram.

A separate box needed: **`requestHostTimeout` uses REAL `setTimeout`**
(not MessageChannel) because the semantics are "wait N ms then fire" —
delay is intentional, clamping is irrelevant (doc §9.5).

---

## 13. Missing `advanceTimers` detail

Diagram shows one arrow `timerQueue ⤏ taskQueue` labelled "advanceTimers()".
Missing:

- **The three-case loop** (doc §6.3):
  1. Cancelled timer (`callback === null`) → pop and discard.
  2. Fired timer (`startTime <= currentTime`) → pop, rewrite
     `sortIndex` from `startTime` to `expirationTime`, push into taskQueue.
  3. Not yet fireable → return (heap invariant: if root isn't ready,
     nothing deeper is).
- **`sortIndex` rewrite happens BETWEEN pop and push** so no heap is
  ever in an inconsistent state.
- **Four call sites**: `workLoop` entry (190), before continuation yield
  (223), after task completion (235), and `handleTimeout` (129).
- **Cancelled-timer reap** is the ONLY cleanup for cancelled delayed
  tasks.

---

## 14. Missing `handleTimeout`

Completely absent from the diagram. The doc dedicates §6.6 to it. Key
points:

- It is the wake-up for delayed tasks when there's no ready work.
- Armed by `requestHostTimeout(handleTimeout, startTime - currentTime)`
  inside `scheduleCallback`'s delayed branch and at the end of `workLoop`
  when the heap is drained but a timer is pending.
- Handler: clear `isHostTimeoutScheduled`, call `advanceTimers`, then
  either `requestHostCallback` (there's now ready work) or re-arm another
  host timeout for the next pending timer.
- Uses real `setTimeout` via `localSetTimeout`, single-slot via
  `taskTimeoutID`.
- Idempotent — can fire twice harmlessly.
- This is a SECOND, SEPARATE pump from MessageChannel.

Also missing: `cancelHostTimeout` and the fact that there's no
corresponding `cancelHostCallback` (doc §9.4, gotcha #24).

---

## 15. Missing yield-decision formula

Diagram: "elapsed >= 5ms? → yield     needsPaint? → yield".

Correct formula (doc §7.1, §8.1):

**Inside workLoop (line 194):**
```js
if (currentTask.expirationTime > currentTime && shouldYieldToHost()) break;
```
(Both conjuncts. An expired task ignores the yield check.)

**Inside shouldYieldToHost (lines 447–460):**
```js
if (!enableAlwaysYieldScheduler && enableRequestPaint && needsPaint) return true;
const timeElapsed = getCurrentTime() - startTime;  // module startTime, NOT Task.startTime
if (timeElapsed < frameInterval) return false;
return true;
```

The diagram misses:
- The `expirationTime > currentTime` guard in the workLoop caller.
- The role of module-level `startTime` as per-slice anchor.
- The `frameInterval` variable (not hardcoded 5 ms).
- The `enableAlwaysYieldScheduler` short-circuit on `needsPaint`.

Also, `shouldYieldToHost` is also called from the RECONCILER's
`workLoopConcurrentByScheduler` on every fiber — i.e. "fiber-by-fiber
yield polling." Doc §8.1, §12.3, §15.4.

---

## 16. Naming / labeling issues

- **"► 01-problem-statement"**, **"► 02-data-structures"**, etc., are
  cryptic. The doc uses sectional names (Module state, Data structures,
  Priorities, Public API, Task lifecycle, Work loop, Yield mechanism,
  Host pump, Continuation pattern, Cancellation, Preemption, Starvation
  prevention, Error handling, Reconciler integration). Use human titles.
- **"06-message-channel"** should be "Host pump (setImmediate →
  MessageChannel → setTimeout)".
- **"08-preemption"** should say "Cooperative preemption (heap re-root
  between macrotasks)".
- **"run task callback"** label is vague — should be "invoke
  `callback(didTimeout)`" with `didTimeout = currentTask.expirationTime <= currentTime`.
- **"returns fn (more work)" / "returns null (done)"** is OK but could
  note "`typeof result === 'function'` → continuation; anything else →
  complete".
- `data-ref` line numbers are stale everywhere — audit against doc §17.

---

## 17. Visual hierarchy gaps

Most important concept that isn't emphasised: **the five-line callback
contract** `Callback = (didTimeout: boolean) => ?Callback`. This is the
entire API between Scheduler and consumers. It's the difference between
"React" and "something else" driving the scheduler. It should be a
prominent element.

Second-most: **"No true preemption — cooperative yield + heap re-root
between macrotasks."** This single sentence is the central thesis of
the whole system.

Third-most: **The two heaps are the only data structure.** Everything
else is module-level flags and function pointers. The diagram has the
heaps but not the "everything else is flags" framing.

Fourth: **Scheduler has zero dependency on React.** Reconciler is one
consumer; `SchedulerMock` and `SchedulerNative` are others. Diagram
implies tight coupling.

---

## Actionable recommendations for the next agent

Ordered by impact.

### P0 — Must fix

1. **Fix `preemption.html` priority errors.** Replace "SyncLane →
   ImmediatePriority" with "click → discrete event priority →
   UserBlockingPriority (timeout 250 ms)". Replace "click(100)" with
   "click(~250)" in the heap visualisation. Add a callout: "SyncLane
   work never reaches the scheduler — it flushes via microtask in
   `processRootScheduleInMicrotask`."

2. **Add a host-pump tier box.** Replace the single "MessageChannel"
   box with a 3-tier selector: `setImmediate` (Node/IE, preferred,
   cites issue #20756) → `MessageChannel` (browser/Worker, 4 ms clamp
   avoidance) → `setTimeout(fn, 0)` (fallback). Show that the selector
   runs once at module init and captures references to defeat polyfills.

3. **Add `handleTimeout` / `requestHostTimeout` branch.** A separate
   orange arrow from `timerQueue` → `requestHostTimeout(handleTimeout, ms)`
   → `localSetTimeout` (NOT MessageChannel) → `handleTimeout` →
   `advanceTimers` → either `requestHostCallback` (ready work now) or
   re-arm host timeout. Label it "delayed-task wake-up, separate pump".

4. **Fix stale `data-ref` line numbers.** Audit every `data-ref`
   attribute against the doc §17 quick-reference table. `scheduleCallback`
   327, `workLoop` 188, `shouldYieldToHost` 447, `performWorkUntilDeadline`
   485, `cancelCallback` 418, `advanceTimers` 103, `handleTimeout` 127,
   `flushWork` 144, `requestHostCallback` 549, `requestHostTimeout` 556,
   `taskQueue` 79, `timerQueue` 80.

5. **Fix "Idle: ~12 days"** → "Idle: ~12.43 days (`maxSigned31BitInt =
   2^30 - 1 = 1073741823 ms`, V8 SMI-tagged on 32-bit)".

### P1 — High impact

6. **Add a "Module-level state" panel.** A 2-column grid listing each
   of the ~15 module variables from doc §2.11 with a one-line purpose.
   Group by role: Time / Heaps / Execution / Pump flags / Paint / Native
   captures / Slice anchor.

7. **Expand the workLoop body** to show the actual line-by-line flow
   from doc §7.1:
   - `currentTask = peek(taskQueue)` (line 191)
   - yield check `if (currentTask.expirationTime > currentTime && shouldYieldToHost()) break;` (line 194)
   - `callback = currentTask.callback` snapshot (line 200)
   - **pre-invocation tombstone** `currentTask.callback = null` (line 203) — HIGHLIGHT
   - `currentPriorityLevel = currentTask.priorityLevel` (line 205)
   - `didUserCallbackTimeout = currentTask.expirationTime <= currentTime` (line 207)
   - `callback(didUserCallbackTimeout)` (line 212, NO try/catch)
   - `currentTime = getCurrentTime()` refresh (line 213)
   - branch: continuation → `callback = result`, advanceTimers, return true
   - branch: complete → `if (currentTask === peek) pop`, advanceTimers
   - branch: cancelled (callback === null) → pop unconditionally

8. **Add an error-handling callout**: "No try/catch in production. Errors
   propagate through the stack; `hasMoreWork = true` initialized BEFORE
   the try means the pump self-heals; pre-invocation tombstone means a
   throwing task is never re-invoked." Quote the code comment from
   lines 495–500.

9. **Correct `continuation.html` signature** to
   `performWorkOnRootViaSchedulerTask(root, didTimeout) → ?RenderTaskFn`
   with the actual flow: capture `originalCallbackNode`, call
   `performWorkOnRoot(root, lanes, forceSync=didTimeout)`, call
   `scheduleTaskForRootDuringMicrotask`, identity check
   `root.callbackNode === originalCallbackNode`, return
   `performWorkOnRootViaSchedulerTask.bind(null, root)` or null.

10. **Add the continuation INVARIANT callout**: "The same `Task` object
    is mutated in place — `sortIndex`, `expirationTime`, `id`, and heap
    position are all unchanged. This is why `root.callbackNode` identity
    is stable across all slices."

11. **Add the preemption thesis line** near the top of the preemption
    panel: "Preemption is a heap re-root between macrotasks, not during
    one."

### P2 — Medium impact

12. **Add a public API panel** enumerating all 16 `unstable_*` exports
    from doc §5, grouped by category: scheduling (schedule/cancel),
    ambient-priority (runWithPriority/next/wrapCallback/getCurrentPriorityLevel),
    yield (shouldYield/requestPaint/forceFrameRate), clock (now),
    profiling.

13. **Add a reconciler-integration band** showing:
    `lane → lanesToEventPriority → EventPriority → schedulerPriorityLevel → scheduleCallback(..., performWorkOnRootViaSchedulerTask.bind(null, root))`
    with `root.callbackNode` as the returned handle stored on the FiberRoot.

14. **Expand `advanceTimers` to show the three-case loop**: cancelled
    → discard, fired → rewrite sortIndex and promote, not-yet → return.
    Label the rewrite "sortIndex: startTime → expirationTime (between
    pop and push)".

15. **Add a heap-comparator mini-panel**: `compare(a, b): sortIndex
    primary, id secondary (FIFO tiebreaker via `taskIdCounter++`)`.
    Note: heap only supports popping the root → this is WHY cancellation
    is lazy.

16. **Annotate the yield-check arrow with the full formula**:
    `expirationTime > currentTime && shouldYieldToHost()` — both conjuncts.
    Expired tasks ignore yield.

17. **Add a starvation table** tying priority → timeout → time-to-non-yieldable:
    Immediate ∞ instantly, UserBlocking 250 ms, Normal 5 s, Low 10 s,
    Idle 12.43 days. With an arrow to the reconciler's `forceSync =
    didTimeout` handoff.

18. **Rename sub-page labels**: "► 06-message-channel" → "Host pump",
    "► 07-continuation-pattern" → "Continuation (in-place Task mutation)",
    "► 08-preemption" → "Preemption (heap re-root between macrotasks)",
    "► 01-problem-statement" → "The problem: 200 ms block vs 5 ms slices",
    "► 02-data-structures" → "Min-heaps (taskQueue / timerQueue)",
    "► 03-priority-timeout-mapping" → "Priority → expirationTime",
    "► 04-work-loop" → "workLoop (drain taskQueue)",
    "► 05-yield-mechanism" → "shouldYieldToHost (5 ms + paint)".

### P3 — Nice to have

19. **Fix `message-channel.html` label**: "setTimeout: 4 ms minimum
    delay" → "setTimeout: 4 ms clamp after 5 nested levels (HTML spec)".

20. **Fix `message-channel.html` rAF label**: "requestAnimationFrame:
    frame-aligned ~16 ms (too slow)" → "requestAnimationFrame:
    paused in background tabs, can't yield multiple times per frame".

21. **Add `forceFrameRate` mini-callout**: `[0, 125]` fps inclusive,
    `frameInterval = Math.floor(1000 / fps)`, fps=0 resets to default.
    Note: default 5 ms is TIGHTER than this API's ceiling of 8 ms at
    125 fps.

22. **Add `enableAlwaysYieldScheduler` experimental mode** as a small
    footnote: flips yielding upside-down, per-task instead of per-5 ms,
    gated on `__EXPERIMENTAL__`.

23. **Add the `unstable_Profiling` object** note — null unless
    `enableProfiling` is true.

24. **Add the three-layer try/finally structure of `flushWork` /
    `performWorkUntilDeadline`** with labels: outer try/finally = state
    restoration, inner try/catch = profiling error tap (re-throws).

---

## What the diagram does well (for balance)

- The BROWSER MAIN THREAD bookend-banner and the "without scheduler:
  200 ms block / with scheduler: 5 ms chunks" framing is genuinely good
  — it sets up the "why" before the "how".
- The collapsed/expanded subpage pattern is a useful way to keep the
  top-level diagram readable while allowing drill-down.
- The `advanceTimers` dashed-flow animated arrow between the two
  queues is a nice visual cue for the promotion direction.
- The EMERGENT BEHAVIORS separator correctly distinguishes primitives
  from emergent patterns.
- The continuation and preemption subpages BOTH correctly identify that
  the continuation mechanism is what enables preemption.
- The flow-dash animation on the loop-back arrow of workLoop is a good
  cue for "this is a loop".
- The use of colour (blue = data, orange = control-flow, green = browser,
  red = error/sync, violet = terminal) is consistent and readable.
