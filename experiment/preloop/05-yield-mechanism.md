# React Scheduler — Yield Mechanism (`shouldYieldToHost`, `frameInterval`, `needsPaint`, the 5 ms deadline)

All line numbers refer to
`/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`
unless otherwise noted.

---

## 1. `shouldYieldToHost()` — the heart of cooperative scheduling

### Exact source (lines 447–460)

```js
447  function shouldYieldToHost(): boolean {
448    if (!enableAlwaysYieldScheduler && enableRequestPaint && needsPaint) {
449      // Yield now.
450      return true;
451    }
452    const timeElapsed = getCurrentTime() - startTime;
453    if (timeElapsed < frameInterval) {
454      // The main thread has only been blocked for a really short amount of time;
455      // smaller than a single frame. Don't yield yet.
456      return false;
457    }
458    // Yield now.
459    return true;
460  }
```

### What it actually checks

`shouldYieldToHost()` makes two decisions in strict order:

1. **Paint fast-path (lines 448–451).** If `enableAlwaysYieldScheduler` is off
   (the normal case), `enableRequestPaint` is on (default `true` in
   `SchedulerFeatureFlags.js` line 16), and the `needsPaint` flag has been set
   by some prior call to `unstable_requestPaint`, then yield *immediately*
   regardless of how much of the time budget is left. This is how React tells
   the scheduler "I just committed something visible; let the browser paint
   before we run another slice."

2. **Deadline check (lines 452–459).**
   `const timeElapsed = getCurrentTime() - startTime;`
   `startTime` is the per-slice anchor set at the top of
   `performWorkUntilDeadline` (see §3). So `timeElapsed` is literally "how many
   milliseconds have passed since this browser task began draining work." If
   that is still **less than** `frameInterval` (5 ms by default), return
   `false` → do not yield, keep running tasks in the same browser task. Once
   the elapsed time catches up to or exceeds `frameInterval`, return `true` →
   `workLoop` will break out and the scheduler will post a new message to
   continue later.

### What does `getCurrentTime() - startTime < frameInterval` return?

It returns `false` while we are still inside the 5 ms slice (meaning "don't
yield") and `true` after the 5 ms budget is spent (meaning "yield"). But note
the check is written as the *inverse* — `shouldYieldToHost` returns `false`
(no yield) when `timeElapsed < frameInterval`. So:

- `timeElapsed < frameInterval` (budget still available) → `shouldYieldToHost` returns `false`
- `timeElapsed >= frameInterval` (budget exhausted) → `shouldYieldToHost` returns `true`

It is exported as `unstable_shouldYield` (line 584) so the reconciler can poll
"can I keep working or should I hand back control?"

---

## 2. `frameInterval` and the `frameYieldMs` default

### Declaration (Scheduler.js lines 440–445)

```js
440  // Scheduler periodically yields in case there is other work on the main
441  // thread, like user events. By default, it yields multiple times per frame.
442  // It does not attempt to align with frame boundaries, since most tasks don't
443  // need to be frame aligned; for those that do, use requestAnimationFrame.
444  let frameInterval: number = frameYieldMs;
445  let startTime = -1;
```

`frameInterval` is a **module-level mutable** initialized from the imported
`frameYieldMs` constant (line 16 of `Scheduler.js`). It is:

- **Read** only in `shouldYieldToHost()` (line 453).
- **Written** only in `forceFrameRate()` (lines 478 and 481).

### Defaults per fork

| File | `frameYieldMs` |
| --- | --- |
| `packages/scheduler/src/SchedulerFeatureFlags.js` line 11 | `5` |
| `packages/scheduler/src/forks/SchedulerFeatureFlags.native-fb.js` line 11 | `5` |
| `packages/scheduler/src/forks/SchedulerFeatureFlags.www.js` line 16 | `10` |

So the public React Scheduler uses a **5 ms** slice. Facebook's www build
relaxes this to 10 ms.

### The comment "multiple times per frame"

The header comment (lines 440–443) is the rationale: at 60 Hz a frame is
~16.67 ms long, so a 5 ms slice lets React work *at most three times per
frame* before giving the browser a chance to handle input, layout, paint,
etc. The comment explicitly says the scheduler does **not** try to align with
frame boundaries — for frame-aligned work React says "use
`requestAnimationFrame`" instead.

---

## 3. `startTime` — the per-slice anchor

### Declaration

```js
445  let startTime = -1;
```

### Where it is set — `performWorkUntilDeadline` (lines 485–514)

```js
485  const performWorkUntilDeadline = () => {
486    if (enableRequestPaint) {
487      needsPaint = false;
488    }
489    if (isMessageLoopRunning) {
490      const currentTime = getCurrentTime();
491      // Keep track of the start time so we can measure how long the main thread
492      // has been blocked.
493      startTime = currentTime;
494
495      // If a scheduler task throws, exit the current browser task so the
496      // error can be observed.
497      //
498      // Intentionally not using a try-catch, since that makes some debugging
499      // techniques harder. Instead, if `flushWork` errors, then `hasMoreWork` will
500      // remain true, and we'll continue the work loop.
501      let hasMoreWork = true;
502      try {
503        hasMoreWork = flushWork(currentTime);
504      } finally {
505        if (hasMoreWork) {
506          // If there's more work, schedule the next message event at the end
507          // of the preceding one.
508          schedulePerformWorkUntilDeadline();
509        } else {
510          isMessageLoopRunning = false;
511        }
512      }
513      ...
```

### Why it is the per-slice anchor

`performWorkUntilDeadline` is the function that runs when the host wakes the
scheduler up (via `MessageChannel.onmessage`, `setImmediate`, or `setTimeout`
— see lines 517–547). Every time a new browser task begins draining work,
line 493 re-samples `getCurrentTime()` and stores it in `startTime`. So
`startTime` is not "when this React task was scheduled" and not "when this
scheduler callback was created" — it is "when did **this** browser-level
macrotask start executing React work?"

That is exactly the quantity `shouldYieldToHost` needs: it measures
`getCurrentTime() - startTime` against `frameInterval` to decide whether the
*current* message-event slice has blocked the main thread long enough. When
the slice yields and a new one starts, line 493 resets `startTime` so each
slice gets a fresh 5 ms budget.

Line 487 also **clears `needsPaint` at the start of every slice** — a paint
request only yields the current slice; after the browser has had a chance to
paint, the next slice starts fresh.

---

## 4. `continuousYieldTime` / `maxYieldInterval` / `enableIsInputPending`

Grepping the entire current scheduler package:

- `continuousYieldTime` → **not present**.
- `maxYieldInterval` → **not present**.
- `enableIsInputPending` → **not present** in `packages/scheduler`.
- `isInputPending` → appears only once in the React monorepo, as a historical
  comment in
  `/home/john/kanban/data/repos/react/packages/react-dom/src/__tests__/ReactDOMEventListener-test.js`
  line 219:
  `// the work to refine this in the scheduler (maybe by leveraging`
  `// isInputPending?).`

**These mechanisms have been removed.** Older versions of React's scheduler
experimented with Chromium's `navigator.scheduling.isInputPending()` API
gated behind an `enableIsInputPending` feature flag; there was also a
`continuousInput`/`maxYieldInterval` two-tier budget that would extend the
slice up to a hard ceiling if `isInputPending()` reported no pending input.
None of that is in the current source. The only timing constants that remain
in `Scheduler.js` are:

- `frameInterval` / `frameYieldMs` (5 ms, see §2)
- The priority timeouts imported on lines 17–19 of `Scheduler.js`:
  - `userBlockingPriorityTimeout = 250`
  - `normalPriorityTimeout = 5000`
  - `lowPriorityTimeout = 10000`
  - (`IdlePriority` uses `maxSigned31BitInt = 1073741823`, line 76)

Those are **task expiration** constants used at scheduling time (lines 347–
369) and are orthogonal to the slice budget — they define when a task is
considered "expired" (see §8) and not how long a slice may run.

---

## 5. `needsPaint` flag

### Declaration

```js
94  var needsPaint = false;
```

### Lifecycle

| Location | Action |
| --- | --- |
| line 94 | Module-level `var`, initialized `false` |
| line 464 inside `requestPaint()` | Set to `true` by `unstable_requestPaint` when `enableRequestPaint` |
| line 448 inside `shouldYieldToHost()` | Read — if `true` forces immediate yield |
| line 487 at top of `performWorkUntilDeadline` | **Cleared** (`needsPaint = false`) at the start of every new slice, again gated on `enableRequestPaint` |

The cycle is: "React commits something" → `requestPaint()` sets `needsPaint =
true` → the very next `shouldYieldToHost()` call inside the running
`workLoop` returns `true` → the slice breaks out → the host task ends → the
browser gets a chance to paint → the scheduler's next message fires →
`performWorkUntilDeadline` clears `needsPaint` and records a new
`startTime` → the next slice runs normally.

Because the clear happens **at the start of the slice that runs after yield**
(not at the end of the yielding slice), the flag correctly "survives" the
gap between slices and guarantees that at least one browser frame boundary
is crossed.

---

## 6. `unstable_requestPaint`

### Source (lines 462–466)

```js
462  function requestPaint() {
463    if (enableRequestPaint) {
464      needsPaint = true;
465    }
466  }
```

Exported on line 585 as `unstable_requestPaint`.

### Where React calls it

`packages/react-reconciler/src/Scheduler.js` line 19 re-exports it:

```js
19  export const requestPaint = Scheduler.unstable_requestPaint;
```

The reconciler calls it once, in `ReactFiberWorkLoop.js` line 4167, right
after a commit that produces visible changes:

```js
4165  // Tell Scheduler to yield at the end of the frame, so the browser has an
4166  // opportunity to paint.
4167  requestPaint();
```

So the sequence is: commit finishes → `requestPaint()` → `needsPaint = true`
→ on the very next `shouldYieldToHost` check the work loop breaks → host
task ends → browser paints → next message-event slice begins with
`needsPaint` cleared.

Note that `unstable_requestPaint` does **not** schedule anything new and
does not call `shouldYieldToHost` itself. It is pure state flipping. Its
effect only materializes when the scheduler next polls `shouldYieldToHost`
from inside `workLoop`.

---

## 7. `unstable_forceFrameRate(fps)`

### Source (lines 468–483)

```js
468  function forceFrameRate(fps: number) {
469    if (fps < 0 || fps > 125) {
470      // Using console['error'] to evade Babel and ESLint
471      console['error'](
472        'forceFrameRate takes a positive int between 0 and 125, ' +
473          'forcing frame rates higher than 125 fps is not supported',
474      );
475      return;
476    }
477    if (fps > 0) {
478      frameInterval = Math.floor(1000 / fps);
479    } else {
480      // reset the framerate
481      frameInterval = frameYieldMs;
482    }
483  }
```

### How it changes `frameInterval`

- Rejects nonsensical input: `fps < 0` or `fps > 125` logs via
  `console['error']` (bracket syntax is used to dodge Babel/ESLint transforms)
  and returns without changing anything.
- `fps > 0`: sets `frameInterval = Math.floor(1000 / fps)`. For example:
  - `fps = 60` → `frameInterval = 16` (ms)
  - `fps = 120` → `frameInterval = 8`
  - `fps = 30` → `frameInterval = 33`
- `fps === 0`: restore the default by reassigning
  `frameInterval = frameYieldMs` (i.e. back to 5 ms).

So `unstable_forceFrameRate` lets an embedder widen or narrow the per-slice
budget. The upper bound of 125 fps corresponds to `frameInterval = 8` ms,
meaning React refuses to slice *narrower* than 8 ms via this API — the
built-in 5 ms default is actually tighter than anything `forceFrameRate`
allows, because the default was not set through this API but through the
feature flag.

Exported on line 587 as `unstable_forceFrameRate`. Nothing in the React
monorepo currently calls it from production code paths; it exists as a
stability hook for embedders. The `SchedulerPostTask.js` and
`SchedulerNative.js` forks stub it (no-op and throw-not-implemented
respectively).

---

## 8. The `expirationTime > currentTime` vs `shouldYieldToHost()` interplay in `workLoop`

### The check (lines 192–198)

```js
192  while (currentTask !== null) {
193    if (!enableAlwaysYieldScheduler) {
194      if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
195        // This currentTask hasn't expired, and we've reached the deadline.
196        break;
197      }
198    }
```

### How each side is computed

- `currentTask.expirationTime` was set at `unstable_scheduleCallback` time
  (lines 371–380) as `startTime + timeout`, where `timeout` depends on
  priority (lines 347–369): `-1` for `ImmediatePriority` (already expired),
  `250` for `UserBlockingPriority`, `5000` for `NormalPriority`, `10000` for
  `LowPriority`, `maxSigned31BitInt` for `IdlePriority`.
- `currentTime` is the time threaded into `workLoop` from
  `performWorkUntilDeadline` → `flushWork` (line 503) and then updated inside
  the loop after running each callback (line 213).

### The meaning of the conjunction

The condition is **AND**: yield only if *both*

1. the task hasn't expired (`expirationTime > currentTime`), **and**
2. the host says "please yield" (`shouldYieldToHost()`).

If the task *has* expired (`expirationTime <= currentTime`), the first
conjunct is false, the whole condition is false, and the loop does **not**
break regardless of `shouldYieldToHost`. Expired tasks bypass yielding
entirely — they get forced through even if the 5 ms slice has been blown.
The callback still learns it was late, because the very next lines
(207, 212) pass `didUserCallbackTimeout` into the user callback:

```js
207    const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
...
212    const continuationCallback = callback(didUserCallbackTimeout);
```

That flag is how `ImmediatePriority` tasks (which have `timeout = -1`,
i.e. *already expired at creation*) run synchronously and never yield: every
pass through line 194 sees `expirationTime > currentTime` as false, so they
short-circuit the yield check and keep running until they finish.

This is also how React enforces starvation protection: a `LowPriority` task
scheduled 10 seconds ago will have `expirationTime <= currentTime`, so even
if a continuous stream of higher-priority user-blocking work keeps asking
`shouldYieldToHost` to be true, once the low-priority task is picked from
the heap it will bypass yield and run to at least one completion step.

`enableAlwaysYieldScheduler` is an experimental flag (`__EXPERIMENTAL__` in
`SchedulerFeatureFlags.js` line 18). When on, the line 193–198 block is
skipped entirely and yielding is handled at the *bottom* of the loop instead
(lines 241–246), where the scheduler yields between tasks based purely on
`currentTask === null || currentTask.expirationTime > currentTime`. In
experimental mode the scheduler *always* yields after each task rather than
trying to pack multiple tasks into a 5 ms slice.

---

## 9. Why 5 ms, not 16.67 ms, and not `requestIdleCallback`

### The 5 ms / 16.67 ms relationship

A 60 Hz display has a frame budget of `1000 / 60 ≈ 16.67` ms. Inside that
frame the browser has to handle input events, run JS, recalc style, do
layout, compose the frame, and actually paint. If React sat on the main
thread for the full 16.67 ms none of those things could happen. 5 ms is
deliberately chosen so that *multiple React slices can fit within a single
frame* — the comment on lines 441–442 literally says "by default, it yields
multiple times per frame." Concretely, at 5 ms React will take roughly one
third of a frame's worth of JS budget per slice, then hand the thread back
to the browser, which can run input listeners or layout if anything is
pending. If nothing is pending, the next message-event slice will fire
almost immediately and React keeps going.

### Why not `requestIdleCallback`

React's original scheduler prototype did use `requestIdleCallback`, but the
team moved off it for a few reasons that this file embodies:

1. **`requestIdleCallback` only fires when the browser is genuinely idle.**
   That makes it unsuitable for user-blocking updates like input responses,
   which need to run ASAP even under load.
2. **Firefox/Chromium firing cadence is unpredictable** and can be very
   coarse (50 ms+). React needs a consistent ~5 ms cadence.
3. **`requestIdleCallback` throttles aggressively** in background tabs and
   when paired with animation-heavy pages, starving React.
4. React wants to **make its own time budget explicit** and to run work
   eagerly in user-blocking / input scenarios while still yielding often.

So React reimplemented the "slice then yield" pattern on top of
`MessageChannel` (preferred, lines 532–540) or `setImmediate` (Node, lines
517–531) or `setTimeout(..., 0)` (fallback, lines 541–547). `MessageChannel`
is preferred in browsers specifically because `setTimeout(0)` gets clamped
to a 4 ms minimum in most engines (line 534 comment: "We prefer
MessageChannel because of the 4ms setTimeout clamping"). Using a message-
channel post keeps the inter-slice gap as small as possible so the total
overhead of yielding 2–3 times per frame stays negligible.

5 ms is therefore a deliberate compromise: long enough that slicing overhead
is amortized over meaningful work, short enough that three slices fit in a
60 Hz frame, and short enough that input latency stays under one frame even
if React is in the middle of work when the input arrives.

---

## 10. `enableIsInputPending` — confirmed absent in current source

Grepped the whole scheduler package and the wider React tree:

- **Zero hits** for `enableIsInputPending` anywhere under
  `packages/scheduler/`.
- **Zero hits** for `navigator.scheduling` or `isInputPending` as a function
  call anywhere under `packages/`.
- The only remaining reference to the term in the whole repo is a throwaway
  comment in
  `/home/john/kanban/data/repos/react/packages/react-dom/src/__tests__/ReactDOMEventListener-test.js`
  line 219 (`// maybe by leveraging isInputPending?`) and two generated
  diagram text files under `data/repos/react/diagrams/layout3/`.

Historically the scheduler had a code path that used Chromium's experimental
`navigator.scheduling.isInputPending()` API to extend the slice if no input
was pending, with a hard ceiling (`maxYieldInterval` / `continuousYieldTime`)
of roughly 50–300 ms. That integration has been fully removed from the
current source in this tree; the only remaining yield trigger is
`(timeElapsed >= frameInterval) || needsPaint`.

---

## 11. "Yield because of deadline" vs "yield because of continuation return"

Both paths end with `hasMoreWork = true` bubbling back up to
`performWorkUntilDeadline` (line 503) and trigger
`schedulePerformWorkUntilDeadline()` (line 508) so the scheduler wakes up
again. But internally they are structurally different.

### Path A: deadline reached (the `break` at line 196)

```js
193    if (!enableAlwaysYieldScheduler) {
194      if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
195        // This currentTask hasn't expired, and we've reached the deadline.
196        break;
197      }
198    }
```

- We break out of the `while` loop **before calling the task's callback at
  all** for this slice.
- `currentTask` is left on the heap (we never popped it, we never called its
  callback, we never nulled `currentTask.callback`).
- `workLoop` falls out of the loop, reaches line 249 (`if (currentTask !==
  null) return true;`) and returns `true`.
- Next slice: `workLoop` peeks the same task again (line 191) and resumes
  exactly where it left off — calling its callback fresh.
- **Semantics: "pause between tasks."** The task we were about to run is
  untouched; we just didn't start it this slice.

### Path B: continuation returned (lines 214–224)

```js
214      if (typeof continuationCallback === 'function') {
215        // If a continuation is returned, immediately yield to the main thread
216        // regardless of how much time is left in the current time slice.
217        // $FlowFixMe[incompatible-use] found when upgrading Flow
218        currentTask.callback = continuationCallback;
219        if (enableProfiling) {
220          // $FlowFixMe[incompatible-call] found when upgrading Flow
221          markTaskYield(currentTask, currentTime);
222        }
223        advanceTimers(currentTime);
224        return true;
225      }
```

- Here we *did* run the task's callback. The callback itself decided to
  yield by returning another function.
- We rewrite `currentTask.callback = continuationCallback` — the same task
  entry on the heap is kept, but its callback pointer is replaced with the
  continuation.
- We `return true` **from inside the loop body**, not by breaking. This
  return bubbles directly out of `workLoop`.
- Crucially, this path does **not** consult `shouldYieldToHost` and does
  **not** check `expirationTime`. The comment on lines 215–216 spells it
  out: "If a continuation is returned, immediately yield to the main thread
  regardless of how much time is left in the current time slice." The
  callback is trusted when it says "I'm done for now, but call me back."
- Next slice: the heap peek returns the same task, but its `callback` field
  now points at the continuation, so we effectively resume the caller's own
  state machine on its own terms.
- **Semantics: "pause in the middle of a task."** This is what the
  reconciler uses when a render is interleaved — it returns a continuation
  to the scheduler so that the next slice picks up its own "next fiber to
  process" rather than restarting.

### What propagates differently

| | Path A (deadline) | Path B (continuation) |
| --- | --- | --- |
| Exits `workLoop` via | `break` at line 196, then `return true` at line 250 | `return true` at line 224 (inside loop) |
| Did the callback run this slice? | No | Yes, exactly once |
| `currentTask.callback` | Unchanged | Replaced with continuation |
| `advanceTimers(currentTime)` called before exit? | Not in this branch — handled implicitly on next entry | Yes, explicit call on line 223 |
| `markTaskYield` profiling marker? | No (no `markTaskYield` for path A) | Yes (line 221) |
| Reason | Main thread deadline | Callback voluntarily yielded |

Both ultimately cause `flushWork` to return `true`, which propagates to
`hasMoreWork` at line 503 and causes line 508 to post the next message — so
from the host's perspective they look the same. The difference is entirely
*inside* React: whether the "in-progress unit" is a not-yet-started task
left on the heap or a half-finished task with a replaced callback pointer.

---

## Appendix — cross-references

- `shouldYieldToHost` definition: Scheduler.js lines 447–460; export as
  `unstable_shouldYield` at line 584.
- `frameInterval` declaration/read/write: lines 444, 453, 478, 481.
- `frameYieldMs` default constants:
  - `packages/scheduler/src/SchedulerFeatureFlags.js` line 11 (`5`)
  - `packages/scheduler/src/forks/SchedulerFeatureFlags.native-fb.js` line 11 (`5`)
  - `packages/scheduler/src/forks/SchedulerFeatureFlags.www.js` line 16 (`10`)
- `startTime` module variable: declared line 445, set line 493.
- `needsPaint`: declared line 94, set line 464, read line 448, cleared line 487.
- `requestPaint` / `unstable_requestPaint`: definition Scheduler.js lines
  462–466; re-exported in `packages/react-reconciler/src/Scheduler.js` line 19;
  called from `packages/react-reconciler/src/ReactFiberWorkLoop.js` line 4167.
- `forceFrameRate` / `unstable_forceFrameRate`: definition lines 468–483;
  export line 587; stubbed in `SchedulerPostTask.js` line 235 and thrown in
  `SchedulerNative.js` line 101.
- `workLoop` deadline check: lines 192–198.
- `workLoop` continuation path: lines 214–224.
- `workLoop` expired-task flag to callback: lines 207, 212.
- `performWorkUntilDeadline` (sets `startTime`, clears `needsPaint`): lines 485–514.
- Host task scheduling (`MessageChannel` / `setImmediate` / `setTimeout`):
  lines 517–547.
- Priority → timeout mapping used for `expirationTime`: lines 347–369.
- `enableIsInputPending` / `isInputPending`: not present in current scheduler
  source; the only repo-wide mention is a comment in
  `packages/react-dom/src/__tests__/ReactDOMEventListener-test.js` line 219.
