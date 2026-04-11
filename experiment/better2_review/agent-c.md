# Agent-C accuracy audit — better2_diagram.html

Audited file: `/home/john/kanban/experiment/iter-1/better2_diagram.html`
(task prompt referenced `/home/john/kanban/experiment/better2_diagram.html` which does not exist — the only `better2_diagram.html` in the tree is under `iter-1/`).

Source of truth:
- `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberRootScheduler.js`
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactEventPriorities.js`
- `/home/john/kanban/data/repos/react/packages/react-reconciler/src/ReactFiberWorkLoop.js`
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerFeatureFlags.js`

---

## Host Pump

### Flow order inside and around the cycle box

SVG depicts (top → bottom):
1. `user-land caller` (outside cycle)
2. `scheduleCallback(pri, cb)`
3. Diamond `isHostCallbackScheduled?` (re-entrance check)
4. `requestHostCallback · L549` (on "no" branch)
5. Label on arrow down: `isMessageLoopRunning = true`
6. Inside the double-bordered PUMP CYCLE:
   1. `schedulePerformWorkUntilDeadline`
   2. `port2.postMessage(null)`
   3. `[ browser macrotask queue ]`
   4. `port1.onmessage`
   5. `performWorkUntilDeadline → flushWork → workLoop`
   6. Branch on `hasMoreWork`: yes → loop back to (1), no → exit.

Verified against Scheduler.js:

- `requestHostCallback` is at L549-554. It does `if (!isMessageLoopRunning) { isMessageLoopRunning = true; schedulePerformWorkUntilDeadline(); }`. SVG "L549" label is correct and "isMessageLoopRunning = true" annotation is correct.
- `performWorkUntilDeadline` at L485-514 calls `flushWork(currentTime)`, and in `finally` calls `schedulePerformWorkUntilDeadline()` again if `hasMoreWork`. So the loop-back-inside-the-box is correct in principle.
- `flushWork` at L144-186 calls `workLoop(initialTime)` — correct.
- The MessageChannel branch at L532-540 does `channel.port1.onmessage = performWorkUntilDeadline` and `schedulePerformWorkUntilDeadline = () => { port.postMessage(null); }`. So the ordering `schedulePerformWorkUntilDeadline → port2.postMessage(null) → macrotask → port1.onmessage → performWorkUntilDeadline` is correct.

MINOR — simplification of the entry guard

SVG labels the diamond `isHostCallbackScheduled?` with caption `(re-entrance check)`. The actual code at Scheduler.js L409 is:

```js
if (!isHostCallbackScheduled && !isPerformingWork) {
  isHostCallbackScheduled = true;
  requestHostCallback();
}
```

so the guard is `(!isHostCallbackScheduled && !isPerformingWork)`, not just `!isHostCallbackScheduled`. The diagram omits the `!isPerformingWork` half. This is a small but real simplification — if we're already inside a work pump (`isPerformingWork=true`) and a user callback synchronously calls `scheduleCallback`, the diamond as drawn would incorrectly allow a re-arm. The correct text would be something like `isHostCallbackScheduled OR isPerformingWork?`.

MINOR — ordering of `isHostCallbackScheduled = true` and `isMessageLoopRunning = true`

The SVG shows the diamond, then the `requestHostCallback · L549` box, with `isMessageLoopRunning = true` as the arrow label below the box. In the real code, `isHostCallbackScheduled = true` is set at L410 by the CALLER (unstable_scheduleCallback) BEFORE entering `requestHostCallback`. Then `isMessageLoopRunning = true` is set INSIDE `requestHostCallback` at L551. The SVG is fine at a conceptual level, but elides the `isHostCallbackScheduled = true` step entirely. The "L549" pointer is to the correct function definition line.

OK — `requestHostCallback` line number

Scheduler.js L549 is the exact definition `function requestHostCallback() {`. Correct.

OK — pump cycle loop-back

SVG draws the `hasMoreWork = true` arrow looping back to step 1 (`schedulePerformWorkUntilDeadline`) and keeps `scheduleCallback` OUTSIDE the loop. That matches the source: the `finally` at L504-512 calls `schedulePerformWorkUntilDeadline()` again, not the user-caller's `scheduleCallback`. Correct.

### INIT-TIME tier selection note

SVG text:
> `setImmediate (Node/IE) → MessageChannel (DOM/Workers, preferred) → setTimeout(,0) (exotic hosts)`

Scheduler.js L516-547 order:
1. `if (typeof localSetImmediate === 'function')` → L529-531 (sets up localSetImmediate branch)
2. `else if (typeof MessageChannel !== 'undefined')` → L532-540 (MessageChannel branch)
3. `else` → L541-547 (localSetTimeout fallback)

So the order is `localSetImmediate → MessageChannel → setTimeout`. The SVG is accurate.

MINOR — "(DOM/Workers, preferred)" is editorial. The real comment at L533-534 is "DOM and Worker environments. We prefer MessageChannel because of the 4ms setTimeout clamping." The word "preferred" in the SVG is correct only in the narrower sense "preferred over setTimeout"; because `localSetImmediate` is chosen first when available, MessageChannel is NOT strictly "preferred" — it's second in the tier list. In Node 15+/jsdom hybrid environments, setImmediate wins. The SVG text is slightly misleading but the ordering arrows are right.

### TIMER PUMP note

SVG text:
> `scheduleCallback(..., {delay:N}) → requestHostTimeout → localSetTimeout → handleTimeout → advanceTimers`

Verified:
- `unstable_scheduleCallback` with `options.delay > 0` takes the `startTime > currentTime` branch at L385-399, pushes to `timerQueue`, and if this is the earliest timer calls `requestHostTimeout(handleTimeout, startTime - currentTime)` at L398.
- `requestHostTimeout` at L556-564 calls `localSetTimeout(() => callback(getCurrentTime()), ms)`.
- The delayed callback is `handleTimeout` at L127-142. It calls `advanceTimers(currentTime)` at L129.
- `handleTimeout` then, at L131-134, if there is a non-null task queue, calls `requestHostCallback()`. The SVG chain does NOT mention this last step (`handleTimeout → requestHostCallback`), which is how promoted timer tasks actually start running. This is a small omission but not strictly wrong — the text is "for delayed tasks only" and stops at `advanceTimers`, leaving the reader to infer what happens next.

OK overall. Minor completeness issue: the chain stops one step before `requestHostCallback`, which is the bridge back into the main pump.

---

## Error Resilience

SVG chain (left → right):
1. `callback throws · L212 · no try/catch`
2. `workLoop propagates · PROD has no catch · (profiling = TAP only)`
3. `flushWork finally · currentTask = null · restore priority · unlock (isPerformingWork=false)`
4. `performWork... finally · hasMoreWork STILL true · (init=true · never reassigned)`
5. `reschedule next slice · pump stays alive · error → browser onerror`

Plus pre-tombstone callout:
> `PRE-TOMBSTONE TRICK: cb was nulled at L203 BEFORE the throw · task is already a corpse · next peek pops it via cancelled branch L238 · never re-invoked`

Verified:

OK — "callback throws · L212 · no try/catch"

Scheduler.js L212 is literally `const continuationCallback = callback(didUserCallbackTimeout);`. There is no try/catch around it inside workLoop. Correct.

OK — "workLoop propagates · PROD has no catch · (profiling = TAP only)"

Scheduler.js L159-176 has the outer `try` in `flushWork`. Inside that try:

```js
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
```

So the profiling branch has an inner try/catch that does `markTaskErrored` + `isQueued = false` and re-throws — it is TAP-only (observability, "tap" the error, re-throw). Prod has no catch at all. SVG is correct. The parenthetical "(profiling = TAP only)" is an accurate shorthand.

OK — "flushWork finally · currentTask = null · restore priority · unlock"

Scheduler.js L177-185:
```js
} finally {
  currentTask = null;
  currentPriorityLevel = previousPriorityLevel;
  isPerformingWork = false;
  ...
}
```
All three are present. Correct.

OK — "performWork... finally · hasMoreWork STILL true · (init=true · never reassigned)"

Scheduler.js L501-512:
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

If `flushWork(currentTime)` throws, the assignment `hasMoreWork = ...` never happens, so `hasMoreWork` keeps its initialized `true` value. The `finally` block then reschedules. Correct.

OK — "reschedule next slice · pump stays alive · error → browser onerror"

The `schedulePerformWorkUntilDeadline()` call in the `finally` re-arms the pump. Because `performWorkUntilDeadline` is the `port1.onmessage` handler, an uncaught throw inside it bubbles out of the MessageChannel message dispatch and lands on `window.onerror` / `globalThis.onerror`. In a Node `setImmediate` branch it would be reported via the Node "uncaughtException" channel, and in the `setTimeout` fallback via the timer error dispatch — all of which are host-level, not swallowed. The SVG label "browser onerror" is correct for the dominant DOM case.

OK — pre-tombstone trick callout

Scheduler.js L203 sets `currentTask.callback = null` BEFORE calling the callback at L212. If L212 throws, `currentTask.callback` is already null. On the next slice, `workLoop` peeks the same task (since `pop` at L232 never ran), sees `typeof callback !== 'function'` at L201, falls into the `else pop(taskQueue)` branch at L237-239. The SVG cites "L238" which is inside the `else` block — correct. The task is popped via the cancelled-sweep branch, not re-invoked. Accurate.

MINOR — scope mismatch between "flushWork finally" and "performWork... finally"

The SVG shows both finallys as steps in a linear chain, which is correct as a temporal sequence but could be misread as if they were separate catch layers. In reality the `flushWork` try/finally is nested inside `performWorkUntilDeadline`'s try/finally — a single throw unwinds both. This is a presentation choice, not a factual error.

---

## Reconciler Lane Mapping

SVG table:

| LANE | EVENT | SCHEDULER |
|---|---|---|
| `SyncLane` | `Discrete` | `MICROTASK (bypass!)` |
| `InputContinuous` | `Continuous` | `UserBlocking (250 ms)` |
| `DefaultLane` | `Default` | `Normal (5 000 ms)` |
| `IdleLane` | `Idle` | `Idle (≈12.43 d)` |

SVG warning: `⚠ Scheduler's ImmediatePriority is effectively unreachable — SyncLane bypasses to microtask`

### CRITICAL — Row 2 is incomplete: `DiscreteEventPriority` ALSO maps to `UserBlockingSchedulerPriority`

ReactFiberRootScheduler.js L480-498:

```js
switch (lanesToEventPriority(nextLanes)) {
  // Scheduler does have an "ImmediatePriority", but now that we use
  // microtasks for sync work we no longer use that. Any sync work that
  // reaches this path is meant to be time sliced.
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

`DiscreteEventPriority` and `ContinuousEventPriority` share the same case arm and both map to `UserBlockingSchedulerPriority`. The SVG only shows `Discrete → MICROTASK (bypass!)` — that is correct only in the common case where `includesSyncLane(nextLanes) === true` and the root is NOT prerendering (ReactFiberRootScheduler.js L442-456). When that guard is hit, the code returns early without ever hitting the lane-mapping switch. But when a `SyncLane` root is prerendering (`checkIfRootIsPrerendering` returns true), it falls through to the concurrent path and gets mapped via the switch to `UserBlockingSchedulerPriority` with a 250 ms timeout — so "MICROTASK (bypass!)" is NOT universal for SyncLane.

In addition, `ContinuousEventPriority` in the SDK corresponds to `InputContinuousLane`, not "all continuous input lanes" — the SVG's row-2 left cell `InputContinuous` is correct. But the comment on row 1 ("Discrete → MICROTASK (bypass!)") obscures that Discrete's fall-through case lands on UserBlocking, same as Continuous. A more faithful rendering would be something like:

- `SyncLane` (non-prerendering root) → inline microtask bypass (skips Scheduler entirely)
- `SyncLane` (prerendering root) → UserBlocking (250 ms)
- `InputContinuousLane` → Continuous → UserBlocking (250 ms)
- `DefaultLane` → Default → Normal (5000 ms)
- `IdleLane` → Idle → Idle (≈12.43 d)

The missing SyncLane prerender fallthrough is a MINOR completeness issue; the missing "Discrete also maps to UB" pairing is a MINOR factual omission (relevant if the SVG is used to understand the switch statement itself).

### MINOR — "Normal (5 000 ms)" vs low/normal distinction

`NormalSchedulerPriority` has `normalPriorityTimeout = 5000` per `SchedulerFeatureFlags.js` L14. Correct.

### MINOR — "Idle (≈12.43 d)"

`IdlePriority` sets `timeout = maxSigned31BitInt` at Scheduler.js L358, and `maxSigned31BitInt = 1073741823` at L76. `1073741823 / 86_400_000 ≈ 12.4265 days`. SVG "≈12.43 d" is accurate.

### MINOR — "Scheduler's ImmediatePriority is effectively unreachable"

The SVG says ImmediatePriority is "effectively unreachable — SyncLane bypasses to microtask." This is TOO strong. ImmediatePriority IS used by the reconciler itself, just not via `lanesToEventPriority`:

- ReactFiberRootScheduler.js L680-683: Safari iframe workaround — `Scheduler_scheduleCallback(ImmediateSchedulerPriority, processRootScheduleInImmediateTask)` when already in render/commit context.
- ReactFiberRootScheduler.js L690-693: `if (!supportsMicrotasks) { Scheduler_scheduleCallback(ImmediateSchedulerPriority, processRootScheduleInImmediateTask); }` — host environments without microtask support fall back to Scheduler's ImmediatePriority.

So the claim should be narrowed to: "ImmediatePriority is not reachable via the `lanesToEventPriority` switch for normal render callbacks; it is still used by `scheduleImmediateRootScheduleTask` for Safari and no-microtask-host fallbacks." The SVG's current text is misleading enough to confuse a reader who greps the source and finds `ImmediateSchedulerPriority` lit up twice. I'd flag this MINOR.

### OK — SyncLane microtask bypass is real

ReactFiberRootScheduler.js L442-456:
```js
if (
  includesSyncLane(nextLanes) &&
  !checkIfRootIsPrerendering(root, nextLanes)
) {
  // Synchronous work is always flushed at the end of the microtask, so we
  // don't need to schedule an additional task.
  ...
  return SyncLane;
}
```

And the microtask scheduler is armed via `scheduleImmediateRootScheduleTask` → `scheduleMicrotask(...)` at L666, which runs `processRootScheduleInMicrotask` at the microtask checkpoint. So the bypass is accurate in the non-prerendering case.

---

## Reconciler 4-Actor Sequence

SVG actors (columns): `reconciler | Scheduler | workLoop | callback(root)`

SVG messages (top → bottom):
1. `reconciler → Scheduler: scheduleCallback(p, performWork…)`
2. Scheduler self-work: `push(taskQ) / requestHC / postMessage`
3. `Scheduler → reconciler: ← taskNode`
4. Reconciler self: `root.callbackNode = taskNode`
5. `— time passes: macrotask fires —`
6. `Scheduler → workLoop: performWorkUntilDeadline`
7. `workLoop → callback: peek · tomb · callback(didT)`
8. callback self: `renderRoot… shouldYield?`
9. `callback → workLoop: ← continuation fn`
10. workLoop self: `task.cb = cont · advTmrs`
11. `workLoop → Scheduler: return true`
12. Scheduler self: `hasMoreWork=T · schedulePerfo…`

Verified:

OK — Step 1: `scheduleCallback(p, performWork…)`

ReactFiberRootScheduler.js L500-503:
```js
const newCallbackNode = scheduleCallback(
  schedulerPriorityLevel,
  performWorkOnRootViaSchedulerTask.bind(null, root),
);
```
The callback passed is `performWorkOnRootViaSchedulerTask.bind(null, root)`. The SVG's "performWork…" is correct shorthand.

MINOR — Step 2: `push(taskQ) / requestHC / postMessage`

Inside `unstable_scheduleCallback` (Scheduler.js L327-416), the non-delayed path is L400-412:
```js
newTask.sortIndex = expirationTime;
push(taskQueue, newTask);
if (enableProfiling) { markTaskStart(...); newTask.isQueued = true; }
if (!isHostCallbackScheduled && !isPerformingWork) {
  isHostCallbackScheduled = true;
  requestHostCallback();
}
```

`requestHostCallback` then calls `schedulePerformWorkUntilDeadline`, which in the MessageChannel branch is `port.postMessage(null)`. So the sequence inside scheduleCallback is `push → (maybe) requestHostCallback → postMessage`. The SVG's `push(taskQ) / requestHC / postMessage` is accurate temporal ordering. OK.

Note however: `requestHC` only runs if `!isHostCallbackScheduled && !isPerformingWork`. For an already-pumping scheduler the `requestHC / postMessage` steps are skipped. The SVG depicts the cold-start case, which is fine.

OK — Step 3: `← taskNode`

`unstable_scheduleCallback` returns `newTask` (Scheduler.js L415). The SVG label "taskNode" is right.

OK — Step 4: `root.callbackNode = taskNode`

ReactFiberRootScheduler.js L506: `root.callbackNode = newCallbackNode;`. Correct.

MINOR — Step 6: `performWorkUntilDeadline` (Scheduler → workLoop)

The arrow goes directly from Scheduler to workLoop labeled "performWorkUntilDeadline". In reality, the `port1.onmessage = performWorkUntilDeadline` assignment means the browser macrotask dispatcher calls `performWorkUntilDeadline`, which then calls `flushWork`, which calls `workLoop`. The SVG's previous "performWorkUntilDeadline → flushWork → workLoop" box in the host-pump section handled flushWork explicitly; in the sequence diagram flushWork is elided. That elision is a presentation choice and not factually wrong (the Scheduler lane in the sequence diagram represents the Scheduler module, including `performWorkUntilDeadline` and `flushWork`).

OK — Step 7: `peek · tomb · callback(didT)`

Inside `workLoop` L190-212:
- L190: `advanceTimers(currentTime)`
- L191: `currentTask = peek(taskQueue)` — "peek"
- L203: `currentTask.callback = null` — "tomb" (tombstone)
- L212: `const continuationCallback = callback(didUserCallbackTimeout)` — "callback(didT)"

Order is correct. Note the first `advanceTimers` call is elided here, and re-shown in step 10 as "advTmrs". That's accurate: there are two advanceTimers calls — one on workLoop entry (L190) and one after a continuation return (L223). The SVG only annotates the second one in step 10. Minor stylistic choice, not a factual problem.

OK — Step 8: `renderRoot… shouldYield?`

`performWorkOnRootViaSchedulerTask` (ReactFiberRootScheduler.js L513-606) calls `performWorkOnRoot(root, lanes, forceSync)` at L590, which inside ReactFiberWorkLoop.js calls `renderRootConcurrent` (or `renderRootSync` for forceSync). The concurrent work loop calls `shouldYield` (Scheduler's `shouldYieldToHost`) per unit of work. So "renderRoot… shouldYield?" is a fair shorthand.

OK — Step 9: `← continuation fn`

ReactFiberRootScheduler.js L600-604:
```js
if (root.callbackNode != null && root.callbackNode === originalCallbackNode) {
  return performWorkOnRootViaSchedulerTask.bind(null, root);
}
return null;
```

When callbackNode identity holds, the callback returns a bound function — the continuation. SVG correct.

OK — Step 10: `task.cb = cont · advTmrs`

Scheduler.js L218, L223:
```js
currentTask.callback = continuationCallback;
...
advanceTimers(currentTime);
return true;
```

Correct.

OK — Step 11: `return true`

Scheduler.js L224: `return true;` from workLoop back to flushWork, which returns it to performWorkUntilDeadline as `hasMoreWork = true`.

OK — Step 12: `hasMoreWork=T · schedulePerfo…`

Scheduler.js L504-508 — correct. The "…" is fine.

Overall the sequence diagram is accurate for the cold-start + single-yield scenario.

---

## Preemption Timeline

SVG shows tick marks at `t=0 / 5 / 7 / 8 / 45 ms` and four colored rectangles:
- `render 5ms` (blue, 0-5ms)
- `browser · click in` (pale green, 5-7ms)
- `click runs` (amber, 7-8ms)
- `browser · paint` (pale green, 8-?)
- `trans RESTART` (blue, 45-?)

Heap snapshots:
- `t=5 ms: [5000:trans]`
- `t=6 · click pushed: [250:click, 5000:trans]`
- `t=8 · peek: click runs`
- `t=45 ms: restart`

Narrative footer:
> 1. trans yields via shouldYield · 2. click fires scheduleCb(UB) · 3. siftUp → click at root
>
> ⚠ render must be side-effect-free — restart throws WIP tree away

### CRITICAL — heap snapshot labels conflate sortIndex with timeout

The snapshot `[250:click, 5000:trans]` is wrong. The min-heap is keyed on `sortIndex`, and for ready tasks `sortIndex = expirationTime = startTime + timeout`. Using the preloop-08 canonical trace values (click scheduled at t=7, UserBlocking timeout=250):

```
T_click.expirationTime = 7 + 250 = 257
T_click.sortIndex      = 257
```

The diagram labels it as `250`, which is the raw timeout constant, not the sortIndex. For `T_transition` scheduled at t=0 with Normal timeout=5000, `sortIndex = 0 + 5000 = 5000`, so the `5000:trans` label happens to be numerically right (because startTime=0). But the click label should be `257:click` (or generally `startTime+250:click`).

This matters because it hides WHY click beats trans in the heap: it's not "250 < 5000" (that would be comparing timeouts), it's `startTime_click + 250 < startTime_trans + 5000`, i.e. `257 < 5000`, where both values are absolute wall-clock-ish expiration times in the same units. If a reader internalizes "it's the 250 vs 5000" they'll miss the `startTime` offset entirely and mis-reason about long-running apps where startTime is not near 0.

Cross-reference: `/home/john/kanban/experiment/preloop/08-preemption.md` L769-785 uses the correct `sortIndex=257` explicitly.

Recommended fix: change the labels to `[257:click, 5000:trans]` or annotate the heap with `sortIndex=startTime+timeout` to make the computation explicit.

### OK — prepareFreshStack is a real function

The narrative "lanes changed → prepareFreshStack → restart" maps to `prepareFreshStack(root, lanes)` at ReactFiberWorkLoop.js L2001 (definition) and L2631 (the use site that fires when `workInProgressRootRenderLanes !== lanes`). The SVG doesn't cite the name directly in the timeline panel, but the supporting narrative in the iter-1 doc uses the correct concept.

### OK — "render must be side-effect-free"

This matches `preloop/08-preemption.md` §11 "Why render must be side-effect-free — the load-bearing invariant" and is the correct justification for why the WIP tree can be discarded on restart. Accurate.

### MINOR — t=45 ms seems arbitrary

The `t=45 ms` tick for "transition restarts" is a plausible illustrative value but has no canonical source. `preloop/08-preemption.md` uses `t=10ms` and a different sequence. As long as the diagram is treated as schematic this is fine, but there is no direct code-line justification for `45`.

### MINOR — "click in" from t=5-7 implies the click hits mid-yield

The SVG shows the transition yielding at t=5, then a 2ms browser window, then click runs at t=7. This is a stylized version of the real preloop-08 story (where the transition yields at t=5ms, the click `addEventListener` handler runs on the next browser task, triggers `scheduleCallback(UserBlocking)` which enqueues T_click). The 2ms gap "browser · click in" is meant to represent the browser dispatching the click event to the DOM listener and the handler's `scheduleCallback(UB)` call. It's plausible but not derivable from source lines directly.

### MINOR — "trans yields via shouldYield"

The narrative claim is accurate for any transition slice that runs past `frameInterval` (5ms by default), which is exactly the SVG's depicted `render 5ms`. Scheduler.js L447-460: when `timeElapsed >= frameInterval` and no `needsPaint`, `shouldYieldToHost` returns true, and the workLoop `break`s at L196. Correct.

### MINOR — click priority path

The SVG and narrative treat "click" as landing at `UserBlocking (250ms)`. Per preloop-08 L762-768, the real DOM click maps through `DiscreteEventPriority → SyncLane`, which would bypass to microtask (not UserBlocking at 250). Preloop-08 explicitly re-narrates the scenario as an `onClick` that sets state at Continuous priority to keep the Scheduler-level heap re-root story intact. The SVG adopts the same illustrative choice but does not flag the "assume ContinuousEventPriority" caveat anywhere. A reader who has memorized `Discrete → microtask bypass` will be mildly confused. MINOR.

---

## Continuation Pattern

SVG:
- Slice chain: `slice 1 (render 5ms, return self)` → `br` gap → `slice 2 (render 5ms, return self)` → … → `slice N (wIP === null, return null)` → `commit`
- Invariant box:
  - `same Task object mutated in place`
  - `sortIndex · expirationTime · id · heap position  ALL unchanged across slices`
  - `→ no siftUp/siftDown on re-arm · O(1) re-queue of continuation`
  - `→ root.callbackNode === originalCallbackNode holds for entire render`
  - `per-pause state lives in reconciler (workInProgress, etc), Scheduler holds only a function pointer`

Verified:

OK — "same Task object mutated in place"

Scheduler.js L218: `currentTask.callback = continuationCallback;`. This is the only mutation between slices. Correct.

OK — "sortIndex · expirationTime · id · heap position ALL unchanged"

The continuation branch at Scheduler.js L214-224:
```js
if (typeof continuationCallback === 'function') {
  currentTask.callback = continuationCallback;
  if (enableProfiling) markTaskYield(currentTask, currentTime);
  advanceTimers(currentTime);
  return true;
}
```

No assignment to `sortIndex`, `expirationTime`, `id`, or `heap position`. And crucially, the `else` branch (L225-236) is the only path that calls `pop(taskQueue)` — continuation does NOT pop. So the task physically stays at heap root. Correct.

OK — "no siftUp/siftDown on re-arm · O(1) re-queue"

Because nothing is pushed/popped on the continuation branch, there is no heap reshape. Next `peek` is O(1). Correct, and matches preloop/07-continuation-pattern.md L97.

CRITICAL-ADJACENT — "root.callbackNode === originalCallbackNode holds for entire render"

This statement is correct in spirit but technically imprecise. The actual check in ReactFiberRootScheduler.js is at L600:

```js
if (root.callbackNode != null && root.callbackNode === originalCallbackNode) {
  return performWorkOnRootViaSchedulerTask.bind(null, root);
}
return null;
```

where `originalCallbackNode` was snapshotted at L545 for THIS invocation of `performWorkOnRootViaSchedulerTask`. The identity check ensures that the task executing now is still the same task the reconciler had stashed in `root.callbackNode` — i.e. no one called `cancelCallback` + `scheduleCallback` in between. Because the Scheduler mutates `callback` in place on the same `Task` object, `root.callbackNode` (a reference to that Task) stays identity-equal across slices. Correct.

But note: `root.callbackNode === originalCallbackNode` holds "for the entire render" ONLY as long as no higher-priority update comes in. If it does, `ensureRootIsScheduled` at L451-456 / L475-478 calls `cancelCallback(existingCallbackNode)` and `scheduleCallback(...)` a fresh task, at which point `root.callbackNode` is reassigned to a NEW Task, and the old task's `callback` is null (cancelled). On the next slice, the OLD task's check at L600 fails and returns null — no continuation. This is exactly how preemption manifests at the reconciler level (preloop/08 "preempt via callbackNode identity check"). The SVG statement reads as though the invariant is unconditional across the entire render. It would be more accurate as "… holds for the entire uninterrupted render — a preempting scheduleCallback breaks the identity and ends the continuation."

I'll flag this as MINOR since the diagram's broader context is a single uninterrupted render ("one render, many slices").

OK — "per-pause state lives in reconciler (workInProgress, etc), Scheduler holds only a function pointer"

This matches the reconciler globals `workInProgress`, `workInProgressRoot`, `workInProgressRootRenderLanes`, etc., defined in ReactFiberWorkLoop.js. The Scheduler `Task` holds only `callback` (a function) plus scheduling bookkeeping. Accurate.

---

## Summary

### CRITICAL
1. **Preemption timeline — heap labels use raw timeout constants instead of sortIndex.** The SVG labels the click-task heap entry as `250:click` when it should be `257:click` (or `startTime+250`). The `5000:trans` label is numerically right only because startTime=0. This misrepresents the heap ordering key and could mislead readers who believe the heap compares raw timeouts. Fix: use `[257:click, 5000:trans]` and/or annotate `sortIndex = startTime + timeout`. See `preloop/08-preemption.md` L769-785 for the canonical computation.

### MINOR
1. **Host-pump re-entrance diamond simplifies `(!isHostCallbackScheduled && !isPerformingWork)` to just `isHostCallbackScheduled?`.** The `!isPerformingWork` half is load-bearing when a running callback calls `scheduleCallback`. Scheduler.js L409.

2. **Host-pump init-tier selection text uses "(DOM/Workers, preferred)".** MessageChannel is only "preferred" over setTimeout, not over `localSetImmediate` — `localSetImmediate` is chosen first in the tier list (L517). The ordering arrows in the SVG are correct, the parenthetical is slightly misleading.

3. **TIMER PUMP chain stops at `advanceTimers` and omits the subsequent `handleTimeout → requestHostCallback` bridge back into the main pump.** Scheduler.js L131-134.

4. **Lane mapping row 1 ("Discrete → MICROTASK (bypass!)") omits that `DiscreteEventPriority` ALSO maps to `UserBlockingSchedulerPriority` in the switch at ReactFiberRootScheduler.js L485-488.** The microtask bypass applies only when `includesSyncLane(nextLanes)` AND NOT prerendering (L442-456). For a prerendering SyncLane root, Discrete falls through to the switch and lands on UserBlocking at 250 ms. MINOR.

5. **"ImmediatePriority is effectively unreachable" is too strong.** `ImmediateSchedulerPriority` is still used by `scheduleImmediateRootScheduleTask` for the Safari iframe workaround (ReactFiberRootScheduler.js L680-683) and for no-microtask-host environments (L690-693). The SVG text would be more accurate as "unreachable via `lanesToEventPriority`."

6. **Sequence diagram step 6 elides `flushWork` between `performWorkUntilDeadline` and `workLoop`.** The host-pump section shows the three-layer call chain correctly, so this is redundant-ish, but a reader who only looks at the sequence diagram misses the intermediate layer.

7. **Continuation-pattern invariant "`root.callbackNode === originalCallbackNode` holds for the entire render" is conditional on no preemption.** If a higher-priority update arrives mid-render, `ensureRootIsScheduled` cancels the old task and creates a new one, breaking the identity. The SVG caveat-free statement is accurate only for an uninterrupted render. Worth one line of qualification.

8. **Preemption timeline "click" priority story papers over the Discrete → SyncLane → microtask bypass.** Preloop-08 narrates the same scenario assuming an `onClick` at Continuous priority rather than Discrete, to keep the Scheduler-heap story intact. The SVG inherits this simplification silently — a reader who has memorized "Discrete → microtask bypass" will wonder why click hits the Scheduler heap at all. A one-line footnote would help.

9. **Preemption timeline's `t=45 ms` restart tick has no canonical source** — it's an illustrative value. Fine as schematic, but worth flagging as "illustrative."

### OK
- Host pump cycle order, loop-back topology, and `L549` line citation all correct.
- `requestHostCallback` sets `isMessageLoopRunning = true` at L551 — correctly annotated.
- `MessageChannel` branch (`port1.onmessage = performWorkUntilDeadline`, `port.postMessage(null)`) faithful to L532-540.
- Error resilience chain: L212 throw, no try/catch in prod workLoop, profiling TAP-and-rethrow (L160-172), flushWork finally (L177-185), performWorkUntilDeadline `hasMoreWork = true` init preserved through throw (L501), pump re-arms via `schedulePerformWorkUntilDeadline()` in finally (L508), errors reach host `onerror` — all verified.
- Pre-tombstone trick: `currentTask.callback = null` at L203 before invoke, cancelled sweep via `pop(taskQueue)` at L238 — correct.
- Lane mapping rows 3 (`DefaultLane → Default → Normal 5000ms`) and 4 (`IdleLane → Idle → Idle ≈12.43d`) match ReactFiberRootScheduler.js L489-494 and SchedulerFeatureFlags.js L14 + `maxSigned31BitInt` (Scheduler.js L76).
- Sequence diagram: `scheduleCallback → push → requestHC → postMessage → return taskNode` inside scheduleCallback is accurate (Scheduler.js L400-415). `root.callbackNode = taskNode` matches ReactFiberRootScheduler.js L506. `peek · tomb · callback(didT)` order matches workLoop L191-212. Continuation return at L214-224, `hasMoreWork=T → schedulePerfo…` at performWorkUntilDeadline finally L504-508.
- Continuation pattern: `currentTask.callback = continuationCallback` (L218), no mutation of `sortIndex/expirationTime/id/heap position`, no pop, O(1) re-queue — all correct. Matches preloop/07 §97 and §414.
- `prepareFreshStack` is a real function at ReactFiberWorkLoop.js L2001, invoked from L2631 when workInProgress lanes diverge.
- "Render must be side-effect-free" matches preloop/08 §11.
