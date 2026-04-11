# React Scheduler: The Macrotask Pump

**Source:** `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`

This document explores how the React Scheduler turns a plain JavaScript callback into a recurring "run every macrotask" pump using `MessageChannel`, `setImmediate`, or `setTimeout` as escape hatches. It covers `performWorkUntilDeadline`, `schedulePerformWorkUntilDeadline`, `requestHostCallback`, `requestHostTimeout`, and the background-tab / clamping rules that shape the design.

---

## 1. The big picture

The scheduler's work loop (`flushWork` -> `workLoop`) is synchronous. It drains as many tasks as it can, then yields. Yielding means: "stop running, give the event loop a chance to paint/handle input, and come back as soon as possible."

"As soon as possible" is the tricky part. The scheduler needs a primitive that:

1. Puts a callback on the **next** macrotask (not a microtask — microtasks would block paint/input).
2. Has effectively zero enforced delay (unlike `setTimeout(fn, 0)`, which the HTML spec clamps to 4ms after a few levels of nesting).
3. Doesn't wait for a frame boundary (ruling out `requestAnimationFrame`).
4. Doesn't wait for idle time (ruling out `requestIdleCallback`).
5. Keeps firing even when the tab is backgrounded (throttled, yes, but not frozen).

There is no perfect primitive for that. React picks the best available per environment, falling through this hierarchy:

1. `localSetImmediate` — Node.js and legacy IE.
2. `MessageChannel` — DOM and Web Worker environments.
3. `setTimeout(fn, 0)` — fallback for exotic non-browser, non-Node environments.

---

## 2. Captured native references (lines 96-101)

```js
// Capture local references to native APIs, in case a polyfill overrides them.
const localSetTimeout = typeof setTimeout === 'function' ? setTimeout : null;
const localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : null;
const localSetImmediate =
  typeof setImmediate !== 'undefined' ? setImmediate : null; // IE and Node.js + jsdom
```

### Why capture at module load?

The comment is blunt: "in case a polyfill overrides them." Scheduler ships as a library, potentially loaded very early in page init. If user code later monkey-patches `window.setTimeout` (via a testing library, a transport wrapper like `sinon`'s fake timers, an APM tool that decorates timers for instrumentation, or a zone.js patch), the scheduler would silently pick up the patched version. That's a footgun because:

- Fake timers in tests would make the scheduler freeze when the test harness pauses.
- APM wrappers might add async-context tracking that changes timing.
- Zone.js patching (Angular interop) would hijack the macrotask pump into a zone, which is not what React wants.

By grabbing the references at module evaluation time — before almost any user code has a chance to run — the scheduler pins itself to the *original* native implementations.

### Why `typeof ... === 'function'` / `!== 'undefined'`?

This works in every environment — browser globals, Node globals, Worker globals, and exotic hosts (React Native, Hermes, QuickJS embeds, JSC embeds) — without a `ReferenceError`. In globals-free environments (or when a global is absent, like `setImmediate` in browsers), the slot becomes `null` and the later branching handles it.

### Note on `globalThis`

The user's task description mentions "(`globalThis`) is used at the top of the file to capture these." In this specific build of `Scheduler.js` the references use the bare identifiers (`setTimeout`, `clearTimeout`, `setImmediate`) guarded by `typeof`. The `typeof` guard is the portable alternative to `globalThis.setTimeout` and accomplishes the same "capture without throwing" goal — a bare reference to an undefined global would throw, but `typeof undeclared === 'undefined'` is safe by JS language rules. The net effect is identical to `globalThis.setTimeout`: pin a reference before user code can shadow it.

---

## 3. `performWorkUntilDeadline` (lines 485-514)

This is the function that runs **on every macrotask tick**. It's the body of the pump.

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

### Line-by-line control flow

- **Line 486-488**: Clear the `needsPaint` flag at the start of every macrotask. `needsPaint` is an advisory signal set by `requestPaint()`; the scheduler treats it as "please yield as soon as possible so the browser can paint." Since we *are* at a macrotask boundary, the browser has already had its chance, so reset the flag and start fresh.

- **Line 489**: `if (isMessageLoopRunning)` — guard against spurious ticks. If `requestHostCallback` was never called (or the loop was stopped), we do nothing. This matters because with `MessageChannel` the port is persistent: once you `postMessage(null)`, the event will fire even if the scheduler has meanwhile decided it wants to stop.

- **Line 490**: `const currentTime = getCurrentTime();` — snapshot wall time (either `performance.now()` or `Date.now() - initialTime`, see lines 59-71).

- **Line 493**: `startTime = currentTime;` — this writes the module-level `startTime` variable declared on line 445. That variable is later read by `shouldYieldToHost()` (line 452) to decide whether enough time has elapsed in this time slice to justify yielding. **Critically**, `startTime` is reset on every macrotask — not every task, not every pump invocation across the lifetime of the app, but every fresh macrotask tick. This gives the work loop a full `frameInterval` (~5ms by default) to run before being asked to yield.

- **Line 501**: `let hasMoreWork = true;` — default to "keep pumping." This is paired with the comment explaining why there is no `try { ... } catch { ... }` around `flushWork`: a `try/catch` would swallow errors and make debugging harder (the DevTools "pause on caught exceptions" option is awkward because all errors are technically caught). Instead, the scheduler uses a `finally` block so that *even if `flushWork` throws*, `hasMoreWork` stays `true` and the pump reschedules itself. The thrown error still bubbles out of the current macrotask, so it's observable in DevTools and top-level error handlers.

- **Line 503**: `hasMoreWork = flushWork(currentTime);` — this is the entry to the synchronous work loop. It drains as many tasks as `shouldYieldToHost()` allows, then returns whether there's leftover work.

- **Lines 505-511**: The `finally` handles two outcomes:
  - **`hasMoreWork === true`** (or an error was thrown): call `schedulePerformWorkUntilDeadline()` to book the next macrotask tick. This is the "keep pumping" branch.
  - **`hasMoreWork === false`**: set `isMessageLoopRunning = false`. This halts the pump. No new macrotask is scheduled. The loop is fully dormant until something external (a new `unstable_scheduleCallback` call or `handleTimeout` firing) calls `requestHostCallback()` again.

### Why `isMessageLoopRunning = false` is the halt signal

Setting `isMessageLoopRunning = false` is how the scheduler gracefully exits. Since this function is the *only* thing that runs inside the macrotask, simply not rescheduling itself is sufficient to stop. There is no explicit `channel.port1.close()` or `clearTimeout` — the pump just... doesn't book its next tick.

This is important for correctness: if `requestHostCallback()` were called from outside during a tick, the check `if (!isMessageLoopRunning)` (line 550) lets it know whether to re-kick the pump.

---

## 4. `schedulePerformWorkUntilDeadline` — the three branches (lines 516-547)

This is the meat of the task. The scheduler picks *one* implementation at module evaluation time and locks it in.

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

### Branch 1: `localSetImmediate` (lines 517-531) — Node.js and old IE

```js
if (typeof localSetImmediate === 'function') {
  schedulePerformWorkUntilDeadline = () => {
    localSetImmediate(performWorkUntilDeadline);
  };
}
```

**When chosen:** Node.js (all versions, `setImmediate` is a Node global), legacy IE (`setImmediate` was a Microsoft proposal that only shipped in IE10+), and jsdom when running on top of Node.

**Why preferred over `MessageChannel`** (even though Node 15+ has `MessageChannel` globally):

1. **Doesn't prevent process exit.** This is the biggest reason. `MessageChannel` ports keep a reference alive that acts as an event source. If a short-lived Node process (say, an SSR render, a Jest test file, or a CLI tool) uses React, an active `MessageChannel` would keep the event loop alive even after all real work is done, so `node script.js` would hang waiting for a nonexistent event. `setImmediate`, by contrast, only schedules a one-shot — once it runs, there's no lingering reference. The linked issue is https://github.com/facebook/react/issues/20756.

2. **Runs earlier.** `setImmediate` fires after I/O callbacks but before `setTimeout(fn, 0)` in Node's event loop phases. In browsers that ever implemented it (IE only, in practice), it also ran earlier than `MessageChannel`. "Runs earlier" maps directly to "lower latency between work and next tick," which is exactly what the scheduler wants.

3. **Node+jsdom mix.** Tests that use jsdom run on Node but have a `MessageChannel` global (because jsdom exposes it, or because Node 15+ has one natively). The `setImmediate` check comes *first* in the `if` ladder, so in this common setup React correctly picks `setImmediate` instead of the `MessageChannel` it could see.

**Caveat from the comment:** "Although both of these would be inferior to native scheduling." Both `setImmediate` and `MessageChannel` are hacks for "run on next macrotask with minimal delay." A real `scheduler.postTask()` API (which is the web platform standard, slowly rolling out) is what the team actually wants — but it's not universally available yet.

### Branch 2: `MessageChannel` (lines 532-540) — DOM and Workers

```js
} else if (typeof MessageChannel !== 'undefined') {
  const channel = new MessageChannel();
  const port = channel.port2;
  channel.port1.onmessage = performWorkUntilDeadline;
  schedulePerformWorkUntilDeadline = () => {
    port.postMessage(null);
  };
}
```

**When chosen:** Any DOM-like environment (browsers, Electron renderer, etc.) and Web Workers (which don't have DOM but do have `MessageChannel`).

**Setup happens once at module load:**

- Create a single `MessageChannel` instance. This gives you two linked ports, `port1` and `port2`.
- Install `performWorkUntilDeadline` as the `onmessage` handler on `port1`. This is the *listener*.
- Save a reference to `port2` as `port`. This is the *sender*.

**Runtime trigger:** `port.postMessage(null)` fires a `message` event on `port1`, which calls `performWorkUntilDeadline` on the next macrotask. The payload is `null` because it's irrelevant — the scheduler only cares about the *event*, not its contents.

**Why `MessageChannel` over `setTimeout(fn, 0)`:** the HTML spec's [timer clamping rules](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers). Paraphrasing the key rule:

> If nesting level is greater than 5, and timeout is less than 4, then set timeout to 4.

In plain English: if you chain `setTimeout(fn, 0)` callbacks — each one from inside the previous — the browser will start enforcing a **4ms minimum delay** after the 5th level of nesting. For a rapid pump like React's work loop, this means after the first handful of ticks, every subsequent `setTimeout(fn, 0)` costs you 4ms of forced idle. Over a long render that's hundreds of milliseconds of pure latency with nothing happening.

`MessageChannel` has **no such clamping**. `port.postMessage(null)` enqueues a `message` task that runs on the next available macrotask with effectively zero delay. It is the near-perfect "run on next macrotask" primitive for browser main threads.

**Why `MessageChannel` is still not ideal:**

1. **Background tab throttling.** When a browser tab is hidden (backgrounded), `MessageChannel` tasks are throttled — not stopped, but their execution frequency is dramatically reduced. Chrome/Edge apply an "intensive wake-up throttling" policy that limits background tabs to roughly one wake-up per minute after the tab has been hidden for ~5 minutes (exact numbers vary). The scheduler *does* still run in background tabs; it just runs much less often. That's actually fine for most React work — there's nothing visible to render — but it's surprising if you're relying on scheduler timing for non-UI work.

2. **No priority.** `MessageChannel` doesn't distinguish between "I need this now" and "run it whenever." The scheduler has its own internal priority system (`ImmediatePriority`, `UserBlockingPriority`, etc.) but they all fight for the same `postMessage` queue at the host level.

3. **Not zero-cost.** `postMessage` across a MessageChannel involves structured cloning (even of `null`) and a trip through the host's task queue. It's much cheaper than `setTimeout` but not free.

4. **Keeps the event loop alive in Node.** As covered above — which is why Node uses `setImmediate` instead.

**Why not `requestAnimationFrame` (rAF)?** rAF is tied to frame boundaries — it fires roughly every 16.67ms on a 60Hz display, and only right before the browser paints. That's useful for animation code that needs to align with repaint, but it's the wrong primitive for a work pump:

- If you want to run a batch of work that doesn't need to be frame-aligned, rAF wastes up to ~16ms waiting for the next frame.
- In background tabs, rAF pauses entirely (0 fps).
- The scheduler wants to yield *multiple times per frame* when possible (its `frameInterval` is ~5ms by default), which rAF cannot express.

**Why not `requestIdleCallback` (rIC)?** rIC fires only when the browser is *idle* — when it has nothing else queued and no upcoming frame deadline. That's the opposite of what a work scheduler wants:

- The whole point of `unstable_scheduleCallback` is that the work is *semantically urgent* (a state update, a render) and should happen promptly. rIC would delay indefinitely.
- rIC has no fixed cadence — if the page is busy, it might never fire at all.
- rIC was designed for truly low-priority work like telemetry flushing and prefetching. React's scheduler sits above rIC in the urgency hierarchy.

### Branch 3: `setTimeout` fallback (lines 541-547)

```js
} else {
  // We should only fallback here in non-browser environments.
  schedulePerformWorkUntilDeadline = () => {
    // $FlowFixMe[not-a-function] nullable value
    localSetTimeout(performWorkUntilDeadline, 0);
  };
}
```

**When chosen:** Environments that have neither `setImmediate` nor `MessageChannel`. In practice: exotic JS hosts like older React Native JSC without a `MessageChannel` polyfill, Hermes, QuickJS, or pre-Node-15 Node stripped of its globals (very rare — `setImmediate` is a Node global).

**The 4ms clamping tax.** This branch pays the full HTML spec tax: after 5 levels of nested `setTimeout(fn, 0)`, every subsequent call is clamped to 4ms minimum. Since `performWorkUntilDeadline` is *always* calling `schedulePerformWorkUntilDeadline` from inside itself, the nesting level grows to 5 and stays there forever. From then on, the pump runs at most once every 4ms — adding roughly 3.95ms of dead time to every tick. Over a 100-task render, that's ~400ms of pure idle.

**Additional background-tab penalty.** Browsers throttle `setTimeout` in background tabs even more aggressively than `MessageChannel` — typically to 1 second minimum for hidden tabs, with "intensive throttling" eventually kicking in. Together with the 4ms clamp, `setTimeout` is a genuinely bad choice for any hot scheduling loop. The comment ("We should only fallback here in non-browser environments") reflects this: the fallback exists only so the scheduler doesn't crash in oddball hosts, not because it's a reasonable choice in browsers.

---

## 5. `requestHostCallback` (lines 549-554)

```js
function requestHostCallback() {
  if (!isMessageLoopRunning) {
    isMessageLoopRunning = true;
    schedulePerformWorkUntilDeadline();
  }
}
```

This is how the *outside world* asks the scheduler to start (or resume) pumping. It's called from:

- `unstable_scheduleCallback` (line 411) when a new non-delayed task arrives and nothing else is running.
- `handleTimeout` (line 134) when a delayed task becomes due.

**Idempotent by design.** The `if (!isMessageLoopRunning)` guard means you can call `requestHostCallback()` any number of times without double-scheduling. If the pump is already running, the existing tick will pick up whatever was just enqueued on its next `flushWork` call. This matters because multiple `scheduleCallback` calls in rapid succession shouldn't create multiple overlapping `postMessage` events.

**The start sequence:**
1. Set `isMessageLoopRunning = true` so that when `performWorkUntilDeadline` is eventually called, it actually runs (instead of bailing on the `if (isMessageLoopRunning)` check).
2. Call `schedulePerformWorkUntilDeadline()` once to book the very first macrotask tick.

After that, `performWorkUntilDeadline` self-perpetuates via its `finally` block — it either books the next tick (if `hasMoreWork`) or sets `isMessageLoopRunning = false` and stops.

---

## 6. `requestHostTimeout` / `cancelHostTimeout` (lines 556-570)

Delayed tasks get a separate track. The scheduler uses actual `setTimeout` here, not `MessageChannel`, because delays are inherently time-based.

```js
function requestHostTimeout(
  callback: (currentTime: number) => void,
  ms: number,
) {
  // $FlowFixMe[not-a-function] nullable value
  taskTimeoutID = localSetTimeout(() => {
    callback(getCurrentTime());
  }, ms);
}

function cancelHostTimeout() {
  // $FlowFixMe[not-a-function] nullable value
  localClearTimeout(taskTimeoutID);
  taskTimeoutID = ((-1: any): TimeoutID);
}
```

**Why `setTimeout` here and not `MessageChannel`?** Because the semantic is fundamentally different:

- `requestHostCallback` means "run ASAP, on next macrotask." Delay should be zero. This is where clamping hurts, so `MessageChannel` wins.
- `requestHostTimeout` means "run `ms` milliseconds from now." The whole point is the delay. `setTimeout` is literally the API for this — there's no reason to fight it.

Also, `requestHostTimeout` is not a hot loop. It fires at most once per delayed task, and each task usually waits tens or hundreds of milliseconds. The 4ms clamping is irrelevant here because nobody's nesting `setTimeout` calls at 0ms.

**Single-slot design.** Note that `taskTimeoutID` is a single module-level variable, not a collection. The scheduler only tracks *one* pending host timeout at a time — specifically, the earliest one in `timerQueue`. If a new delayed task arrives that's earlier than the current one, `unstable_scheduleCallback` calls `cancelHostTimeout()` first and then `requestHostTimeout()` with the new shorter delay (see lines 391-398). This keeps the host timeout always pointing at the head of the timer queue.

**The callback wrapper.** `localSetTimeout(() => { callback(getCurrentTime()); }, ms)` wraps the real callback so that when the timeout fires, it passes the current time as an argument. The only real consumer is `handleTimeout(currentTime)` (line 127), which needs that timestamp to call `advanceTimers(currentTime)`.

---

## 7. How `startTime` connects `performWorkUntilDeadline` to the work loop

The module-level `startTime` (declared on line 445) is the bridge between "when did this macrotask start" and "should I yield yet."

```js
// lines 444-445
let frameInterval: number = frameYieldMs;
let startTime = -1;
```

```js
// performWorkUntilDeadline, line 493
startTime = currentTime;
```

```js
// shouldYieldToHost, lines 447-460
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

**The contract:** Every time the macrotask pump fires, `startTime` resets. From that moment, the work loop has `frameInterval` milliseconds (default ~5ms — `frameYieldMs`) to run before `shouldYieldToHost()` starts returning `true`. When it does, `workLoop` breaks, `flushWork` returns `true` (hasMoreWork), and `performWorkUntilDeadline` reschedules itself for the next macrotask.

This is how the scheduler achieves "yield multiple times per frame": each macrotask = one 5ms slice of work. On a 60Hz display (~16.67ms per frame), that's 2-3 slices per frame, with the browser getting a chance to handle input / paint / layout in between.

---

## 8. Background tab behavior summary

| Primitive           | Background tab behavior                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `setImmediate`      | (Node only — no browser tabs, so N/A)                                                    |
| `MessageChannel`    | Throttled (intensive wake-up throttling ~1/min after prolonged hide), but continues      |
| `setTimeout(fn, 0)` | Heavily throttled (1s minimum + intensive throttling), but continues                     |
| `requestAnimationFrame` | **Paused entirely** (0 fps) — one of several reasons the scheduler doesn't use rAF  |
| `requestIdleCallback`   | Still fires but even more deferred; wrong primitive for "urgent" work anyway          |

**Key takeaway:** The scheduler *continues running* in background tabs via `MessageChannel`, just slowly. React components will eventually update; it's not frozen. This is usually fine because visible rendering is not happening anyway, and when the tab becomes visible again normal cadence resumes.

---

## 9. End-to-end lifecycle: one cycle of the pump

Putting all the pieces together, here's what happens when you call `unstable_scheduleCallback(NormalPriority, myCb)` in a browser:

1. **Enqueue.** `unstable_scheduleCallback` (lines 327-416) creates a `Task`, pushes it onto `taskQueue` (a min-heap sorted by `expirationTime`), then checks `if (!isHostCallbackScheduled && !isPerformingWork)`. If true, it sets `isHostCallbackScheduled = true` and calls `requestHostCallback()`.

2. **Start the pump.** `requestHostCallback()` (line 549) checks `if (!isMessageLoopRunning)`. If true, sets `isMessageLoopRunning = true` and calls `schedulePerformWorkUntilDeadline()`. In the browser, that's `port.postMessage(null)` on the pre-created `MessageChannel`.

3. **Next macrotask arrives.** The browser dequeues the `message` event, fires `channel.port1.onmessage`, which is `performWorkUntilDeadline` (line 485).

4. **Reset the clock.** `performWorkUntilDeadline` clears `needsPaint`, checks `isMessageLoopRunning` (still true), snapshots `currentTime`, and writes `startTime = currentTime`. Now the 5ms timeslice budget starts.

5. **Run work.** `flushWork(currentTime)` (line 144) is called. It sets `isHostCallbackScheduled = false` (because we *are* the scheduled callback now — it's actively running), cancels any host timeout, and enters `workLoop(initialTime)` (line 188).

6. **Drain tasks.** `workLoop` peeks the min-heap, runs tasks one by one, checking `shouldYieldToHost()` between each. `shouldYieldToHost` compares `getCurrentTime() - startTime` to `frameInterval` (~5ms). Once the budget is exceeded, the loop breaks.

7. **Return control.** `workLoop` returns `true` if there's more work, `false` otherwise. That bubbles up to `flushWork` -> `performWorkUntilDeadline`.

8. **Reschedule or halt.** In the `finally` block:
   - If `hasMoreWork`, call `schedulePerformWorkUntilDeadline()` again -> another `port.postMessage(null)` -> loop back to step 3.
   - Else, set `isMessageLoopRunning = false`. The pump is now dormant. No new macrotask is booked. Everything is quiet until step 1 happens again (someone calls `unstable_scheduleCallback`, or `handleTimeout` fires because a delayed task is due).

The crucial property: **between step 8 rescheduling and step 3 running again, the browser has a full macrotask boundary to paint, process input, run other scripts, etc.** That's the "yielding" that makes React feel responsive even during large renders.

---

## 10. Why not all of: a summary table

| Primitive                 | Pro                                                   | Con                                                                                |
| ------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `setImmediate`            | Fires earliest in Node's event loop; no Node-exit bug | Only in Node and IE; not standard in browsers                                      |
| `MessageChannel`          | Near-zero delay; no 4ms clamp; works in Workers       | Keeps Node process alive; throttled in background tabs; no priority                |
| `setTimeout(fn, 0)`       | Universally available                                  | 4ms clamp after 5 nestings; heavy background-tab throttling                        |
| `requestAnimationFrame`   | Frame-aligned (good for actual animations)            | Wastes up to 16ms waiting for frame; paused in background tabs; wrong granularity  |
| `requestIdleCallback`     | Fires when browser is truly free                      | Arbitrarily delayed; wrong for urgent work; can never fire on busy pages           |
| `scheduler.postTask()`    | Native web standard with priority support             | Not universally shipped; React could adopt when coverage is solid                  |
| Microtasks (`queueMicrotask`) | Run immediately after current task               | Run *before* paint/input, so they block the browser — exactly what scheduler avoids|

---

## 11. Referenced source file

- `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`
  - Lines 96-101: native reference captures (`localSetTimeout`, `localClearTimeout`, `localSetImmediate`).
  - Lines 437-445: `isMessageLoopRunning`, `taskTimeoutID`, `frameInterval`, `startTime` module state.
  - Lines 447-460: `shouldYieldToHost` — consumer of `startTime` and `frameInterval`.
  - Lines 485-514: `performWorkUntilDeadline` — the pump body.
  - Lines 516-547: `schedulePerformWorkUntilDeadline` — three-branch host primitive selection.
  - Lines 549-554: `requestHostCallback` — external entry point to start the pump.
  - Lines 556-570: `requestHostTimeout` / `cancelHostTimeout` — delayed task track using real `setTimeout`.

---

## 12. Key insights

1. **The scheduler is a recursive macrotask pump.** `performWorkUntilDeadline` reschedules itself after each run *only if* there's more work. There's no interval, no fixed cadence — it runs exactly as often as needed, then stops.

2. **`MessageChannel` is the browser's best "run ASAP" primitive** short of the not-yet-ubiquitous `scheduler.postTask` API. It bypasses the 4ms `setTimeout` clamping rule from the HTML spec, which would otherwise cripple any rapid scheduling loop.

3. **Node gets `setImmediate` because `MessageChannel` prevents process exit.** This is a real bug (react#20756) that the scheduler works around by checking `setImmediate` *first* in the primitive selection ladder, even though Node 15+ has `MessageChannel` available.

4. **`startTime` is reset every macrotask tick, not every task.** This is what gives the work loop its time-slice budget — the scheduler doesn't measure "how long has this individual task run," it measures "how long have we been blocking the main thread since our macrotask started."

5. **`isMessageLoopRunning` is both the halt switch and the restart guard.** Setting it to `false` stops the pump. The `!isMessageLoopRunning` check in `requestHostCallback` prevents duplicate `postMessage` calls from stacking up, since once the pump is running the current tick will naturally observe any newly enqueued tasks.

6. **Local references are captured at module load time.** This defends against polyfills, fake timers, and zone.js patches that might later shadow `setTimeout`, `setImmediate`, or `clearTimeout`. The `typeof ... === 'function'` guard is the cross-environment portable way to do this without a `ReferenceError` in hosts that lack the global.

7. **Delayed tasks use a separate, simpler path.** `requestHostTimeout` just wraps `setTimeout`. Delays are intentional, so clamping and throttling don't matter — in fact, the timer is almost always for an `ms` much greater than 4 anyway.

8. **There is no try/catch around `flushWork` by design.** Errors propagate out of the macrotask so DevTools can observe them. The `finally` block guarantees the pump reschedules itself even on error, so a thrown task doesn't halt the scheduler.
