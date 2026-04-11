# Iter-2 Critique of `iter-1/diagram.html`

Source doc: `/home/john/kanban/experiment/iter-2/source-doc.md`
Diagram under review: `/home/john/kanban/experiment/iter-1/diagram.html`
Previous critique (already-addressed items skipped): `/home/john/kanban/experiment/iter-1/critique.md`

Iter-1 already fixed the "first-round" gaps: module state panel, three-tier host pump, the second `handleTimeout` pump, pre-invocation tombstone, `hasMoreWork = true` self-heal, SyncLane-bypass correction, `2^30 - 1` idle value, public-API surface, reconciler bridge, continuation in-place invariant. This critique focuses on what's STILL missing or wrong after those edits.

---

## Summary — seven most important remaining gaps

1. **No execution traces.** The source doc has three Appendices (A, B, C — 350+ lines of annotated runtime traces) that walk slice-by-slice through (i) a transition being preempted by a click, (ii) a throwing task self-healing, (iii) a delayed task waking via `handleTimeout`. The iter-1 diagram has zero dynamic/temporal/trace representation — everything is static structural boxes. This is the single largest depth gap.

2. **The three reconciler work loops are flattened into one.** The source doc §10.5 and §15.5 call out `workLoopSync`, `workLoopConcurrent` (throttled, 25 ms non-idle / 5 ms idle), and `workLoopConcurrentByScheduler` as three distinct loops selected at `ReactFiberWorkLoop.js:2991–2995`. The iter-1 reconciler-bridge panel only shows `workLoopConcurrentByScheduler` and never mentions that `forceSync → renderRootSync → workLoopSync` is how starvation bypass actually manifests on the reconciler side.

3. **Appendix D ordering constraints are not visualized.** The source doc's Appendix D enumerates 16 subtle ordering rules (tombstone-before-invoke, clock-refresh-after-invoke, advanceTimers-before-return-true, `hasMoreWork = true` before the try, etc.). Iter-1's workLoop panel shows the code lines but never highlights the ordering as a constraint. There is no dedicated "what MUST happen before what" panel.

4. **The "callback contract" is under-emphasized.** `Callback = (didTimeout: boolean) => ?Callback` is the entire coroutine protocol in five characters. Iter-1 mentions it once in a small mini-panel at line 390 of the diagram. The signature, the `didTimeout → forceSync` bridge on the reconciler side, and the `typeof === 'function'` runtime check deserve a central callout — this IS the scheduler's public protocol.

5. **The feedback loop (the "heart") is not visually a loop.** The critical mental model — `postMessage → performWorkUntilDeadline → flushWork → workLoop → continuation stored → return true → finally → schedulePerformWorkUntilDeadline → postMessage → (heap may have re-rooted in the gap) → ...` — is drawn in iter-1 as a vertical column of boxes with arrows pointing down. There is no loop-back arrow from `hasMoreWork=true` all the way back up to `performWorkUntilDeadline`. The reader has to mentally reconstruct the loop that IS the scheduler.

6. **Several factual slips and stale claims remain.** `Scheduler.js · 598 lines` at the title (source doc says 599). `NormalPriority = 3` shown in the API panel but `NoPriority = 0` is mis-shown as just a sentinel without noting its `case` position in `unstable_runWithPriority`'s validation. `forceSync = didTimeout;  // L521` at line 689 — the actual line in `ReactFiberRootScheduler.js` is 589 per source doc §17.7, not 521. `processRootScheduleInMicrotask` shown referring to `L442-456` in the preemption panel, but source doc §15.8 says `339-341`.

7. **Excess information density obscures the thesis.** The diagram is ~1960 SVG units tall with 15+ panels. The five-word thesis — "heap re-root between macrotasks" — is buried in a small "THESIS" sub-column of the module-state panel. The most important concept should be the visual centerpiece, not a footnote.

---

## Detailed findings

### A. Depth gaps — surface mentions that need mechanics

**A1. Continuation invariant is named but not shown.**
Iter-1 has "INVARIANT: Same Task object mutated in place. sortIndex, expirationTime, id, heap position ALL unchanged." That is correct text but there is no visual showing **before and after**: same task at position `i`, `callback` field mutated, everything else pointing to the same memory. A tiny "heap cell" diagram with the callback slot flipping would carry the invariant.

Source: doc §10.3 (five-item stability list), §10.7 (continuation vs deadline-break table).
Iter-1 gap: diagram lines 742–745 assert the invariant textually but never visualize the shared heap slot.

**A2. The `originalCallbackNode` identity check has no visual.**
The reconciler bridge panel at iter-1 line 690 shows `if (root.callbackNode === originalCallbackNode)` as a text line but never explains the "why" — this check is load-bearing for reusing the same Scheduler Task across slices, and it only works because of the in-place mutation in A1. The two facts are on different panels with no visual connection.

Source: doc §10.3 facts 1–5, §15.6.
Recommendation: draw an arrow from the continuation panel's "same task object" invariant to the reconciler bridge's identity check, labelled "depends on".

**A3. `advanceTimers` four call sites are not enumerated in one place.**
Source doc §6.3 table lists exactly four callers: `handleTimeout:129`, `workLoop:190 (entry)`, `workLoop:223 (pre-yield)`, `workLoop:235 (post-completion)`. Iter-1 has a single arrow labeled `advanceTimers` between the heaps and a line in the workLoop panel that only shows the entry call at L190. The pre-yield and post-completion calls are implied by the code snippets but not called out.

**A4. `frameYieldMs` fork variation not shown.**
Source doc §8.2 table: `frameYieldMs = 5` in prod and native-fb, `= 10` in www build. Iter-1 module-state panel has "frameYieldMs (5ms prod, 10ms www)" in a tiny caption but the "why 5" (3 slices per 60 Hz frame, doc §8.5) is absent.

**A5. The `workLoop` local `currentTime` refresh pattern.**
Doc §7.1 point 1 and gotcha #9 — `currentTime` is a LOCAL variable inside `workLoop` that is refreshed at line 213 (`currentTime = getCurrentTime()` after each callback). Iter-1 shows line 213 as "post-callback clock refresh" but doesn't explain that this is a **local**, not the module `startTime`, and that its purpose is to make the subsequent `advanceTimers(currentTime)` calls use a fresh clock.

### B. Ordering constraints — Appendix D

Iter-1 partially shows ordering through its sequential code-snippet layout, but several load-bearing constraints are not visible as constraints:

| Appendix D rule | Source line | In iter-1? |
|---|---|---|
| tombstone (L203) before `callback(...)` (L212) | 203, 212 | Yes (called out "◄ PRE-INVOCATION TOMBSTONE") |
| `currentTime = getCurrentTime()` after `callback(...)` | 213 | Mentioned but not flagged as constraint |
| `advanceTimers` before `return true` (continuation) | 223 | In code text, not highlighted as "ordering rule" |
| `currentTask = peek(taskQueue)` after pop | 240 | Shown at loop-back but not flagged |
| `advanceTimers` at workLoop entry | 190 | Shown in code |
| sortIndex rewrite BETWEEN `pop(timerQueue)` and `push(taskQueue)` | 112–114 | Not shown; advanceTimers is a single arrow |
| `isHostCallbackScheduled = false` at flushWork entry | 150 | Shown in flushWork panel |
| `cancelHostTimeout` at flushWork entry | 153–154 | Shown |
| `isPerformingWork = true` BEFORE `workLoop` call | 157 | Shown |
| `let hasMoreWork = true;` BEFORE the try | 501 | Called out in error panel |
| `needsPaint = false` at TOP of performWorkUntilDeadline | 487 | Shown |
| `startTime = currentTime` at top of performWorkUntilDeadline | 493 | Shown |
| `isHostTimeoutScheduled = false` at handleTimeout entry | 128 | Not shown (handleTimeout only in host-pump panel, not in its own body) |
| `isHostTimeoutScheduled` stays true across cancel+re-arm | 391–398 | Not shown |
| Yield check uses BOTH conjuncts | 194 | Called out well |
| advanceTimers `<=` not `<` for startTime | 110 | Not shown |

Fourteen of 16 are at least referenced, but they're not collected as "ordering rules". A dedicated "Appendix D" style compact table would pay off.

### C. Execution traces — entirely absent

Source doc has three full traces:
- **Appendix A** (preemption): 100+ lines walking through a transition being preempted mid-slice by a click, including the lane→event→priority path, `cancelCallback(T_transition)`, `push(T_click)`, heap re-root, `T_transition` sitting in the heap as a tombstone with `callback = null`, and the priority-change restart via `prepareFreshStack`.
- **Appendix B** (error): 9 steps through a throwing task, showing the tombstone-before-throw interplay with `hasMoreWork = true`, then next-slice cleanup via the cancelled branch.
- **Appendix C** (delayed wake): `scheduleCallback({delay:100})` → `requestHostTimeout(handleTimeout, 100)` → 100 ms quiet → `handleTimeout(100)` → `advanceTimers` → `requestHostCallback` → `performWorkUntilDeadline` → task runs → heap drains → `isMessageLoopRunning = false`.

Iter-1's "Preemption" expandable panel has a ~6-line prose sketch of scenario A but no state-over-time rendering. Nothing at all for B or C.

This is the biggest structural gap. A static structural diagram cannot convey scheduling — you need at least one animated or timeline-style panel showing state between slices.

### D. Reconciler integration depth

**D1. Three work loops not shown.**
Source doc §10.5 / §15.5 / §17.7:
```js
if (__DEV__ && actQueue !== null) workLoopSync();
else if (enableThrottledScheduling) workLoopConcurrent(includesNonIdleWork(lanes));
else workLoopConcurrentByScheduler();
```
Iter-1 reconciler bridge only mentions `workLoopConcurrentByScheduler` at line 693. `workLoopSync` and `workLoopConcurrent` are absent, which means there is no way for the diagram to depict the `forceSync → renderRootSync → workLoopSync` path that makes starvation bypass actually run to completion on the reconciler side.

**D2. `performWorkOnRootViaSchedulerTask` sequence not shown.**
Source doc §15.3 has a 9-step sequence from task invocation to identity check. Iter-1 reconciler-bridge panel has 6 lines of code fragments but no ordered walkthrough. Notably missing:
- Step 2: `hasPendingCommitEffects()` early exit
- Step 3: `flushPendingEffectsDelayed()` and its post-flush identity re-check
- Step 8: `scheduleTaskForRootDuringMicrotask(root, now())` at end
- Step 9: the conditional return of `bind(null, root)` vs `null`

**D3. `scheduleImmediateRootScheduleTask` Safari fallback absent.**
Source doc §15.9: `ReactFiberRootScheduler.js:650–695` — the rare uses of `ImmediateSchedulerPriority` in modern React come from two fallbacks (Safari iframe microtask context, `supportsMicrotasks` false). Iter-1 mentions "Scheduler's ImmediatePriority is effectively unreachable from reconciler concurrent mode" but never explains the two exceptions. Minor but worth a one-line note.

**D4. `didTimeout → forceSync` bridge annotation is wrong.**
Iter-1 line 689: `forceSync = didTimeout;  // L521`. Source doc §15.7 gives the full expression: `const forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout;` and locates it at `ReactFiberRootScheduler.js:589` (§17.7). The iter-1 version is both incomplete (missing the guard flag) and has a wrong line number (`521` vs `589`).

**D5. The `workInProgressRoot` continuation check is missing.**
Source doc §10.6, §15.4, `ReactFiberWorkLoop.js:2785`:
```js
if (workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes) {
  prepareFreshStack(root, lanes);
} else {
  // This is a continuation of an existing work-in-progress.
  ...
}
```
This identity check is what distinguishes "resume" vs "restart" on the reconciler side, and is what preserves partial WIP trees across slices. Iter-1 doesn't mention it. Without it, the reader can't understand why Scheduler-level continuation keeps the render going (answer: Scheduler's stable Task identity + reconciler's stable `workInProgressRoot` module global).

### E. Missing public API items

Cross-referencing iter-1 Public API panel (lines 151–202) against source doc §5:

| Export | In iter-1? | Notes |
|---|---|---|
| `unstable_ImmediatePriority` | Yes | |
| `unstable_UserBlockingPriority` | Yes | |
| `unstable_NormalPriority` | Yes | |
| `unstable_IdlePriority` | Yes | |
| `unstable_LowPriority` | Yes | |
| `unstable_runWithPriority` | Yes | |
| `unstable_next` | Yes | |
| `unstable_scheduleCallback` | Yes | |
| `unstable_cancelCallback` | Yes | |
| `unstable_wrapCallback` | Yes | |
| `unstable_getCurrentPriorityLevel` | Yes | |
| `unstable_shouldYield` | Yes | |
| `unstable_requestPaint` | Yes | |
| `unstable_now` | Yes | |
| `unstable_forceFrameRate` | Yes | |
| `unstable_Profiling` | Partial | mentioned as a note, not listed |

Total: 15 exports + `unstable_Profiling` = 16. Iter-1 says "16 exports" which is correct count.

**Missing from iter-1:** the "APIs that no longer exist" list (source doc §5.11) — `unstable_pauseExecution`, `unstable_continueExecution`, `unstable_getFirstCallbackNode`, `cancelHostCallback`, `isSchedulerPaused`, the old `navigator.scheduling.isInputPending()` integration (`continuousYieldTime`, `maxYieldInterval`, `enableIsInputPending`). These are historical interest but worth noting because older blog posts mention them; a small "removed / deprecated" note would save readers from searching for dead code.

### F. Subtle corner cases

**F1. `handleTimeout` line 138 asymmetry — still not shown.**
Source doc §6.4 point 3, gotcha #11: in the re-arm path, `requestHostTimeout` is called WITHOUT setting `isHostTimeoutScheduled = true`. Iter-1 host-pump panel line 456 says "orphaned timeouts fire harmlessly: handleTimeout is idempotent" but never shows the actual asymmetry (cancelled unconditionally at L128, but only re-set in the `else` branch at L395 in `scheduleCallback`, not re-set at L138 in `handleTimeout`).

**F2. `handleTimeout` body not shown.**
The entire body of `handleTimeout` (source doc §6.4, lines 127–142) is absent from iter-1. The host-pump panel collapses it into one sentence: "handleTimeout + requestHostTimeout (L127–142, L556–570) — SECOND, SEPARATE PUMP". But `handleTimeout` does non-trivial work: clear flag, `advanceTimers`, then one of three branches (schedule host callback / re-arm for later timer / do nothing). This is a twin entry point to `performWorkUntilDeadline` and deserves its own panel.

**F3. `{delay: 0}` is not a delay.**
Source doc gotcha #2, §6.1 step (b). Iter-1 timerQueue panel line 364 has "⚠ {delay: 0} is NOT a delay — strict > 0 check, falls to immediate branch". Good — but this is one of the 40 gotchas in §16; many others are absent.

**F4. `performWorkUntilDeadline` and `handleTimeout` are TWIN entry points.**
Source doc gotcha #35: "handleTimeout and performWorkUntilDeadline are the two 'entry points' into a new slice of work." Iter-1 does not frame them as twins — it presents `performWorkUntilDeadline` as the main flow and `handleTimeout` as an auxiliary thing inside the host-pump panel. A visual showing both entry points → `advanceTimers` → either run loop or re-arm would make the "two pumps" model concrete.

**F5. The `didUserCallbackTimeout` computation site.**
Iter-1 shows `L207 const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;` in the workLoop panel, which is correct. But it doesn't connect this to the reconciler's `forceSync` bridge nor to the "starvation escape" bypass in the yield check. Drawing an arrow from line 207 to the reconciler bridge's `forceSync` line, AND to the yield check's `expirationTime > currentTime` conjunct, would show the two uses of the same value.

**F6. `currentPriorityLevel` ambient leak across tasks.**
Source doc §2.5, gotcha #23: `currentPriorityLevel` is set per-task at L205 but NOT unwound between tasks inside a single `workLoop` — only at flushWork's finally (L179). The iter-1 module-state panel says "leaks mid-loop" in a dim caption, which is good but buried. This is the kind of thing that SHOULD be in the ordering constraints panel.

**F7. `workLoop` exits with `return true` from two lines.**
Source doc §7.2 table: L224 (continuation) and L250 (deadline break), both yielding "more work pending" boolean. Iter-1 termination line at 596–598 says "return true (yielded, more work)" but doesn't call out that these are two physically different return sites with different semantics (the continuation path has just mutated `callback` and called `advanceTimers`; the deadline-break path has NOT). Source doc §10.7 has the full comparison table.

### G. Correctness double-check / stale refs

Line-number audit of iter-1's `data-ref` and inline annotations against source doc §17.1/§17.7:

| iter-1 reference | iter-1 says | Source doc says | Status |
|---|---|---|---|
| `Scheduler.js · 598 lines` (title, line 113) | 598 | 599 | Off by 1 |
| `scheduleCallback` | 327 | 327–416 | OK |
| `cancelCallback` | 418 | 418–431 | OK |
| `runWithPriority` | 260 | 260–283 | OK |
| `shouldYield` | 447 | 447–460 | OK |
| `requestPaint` | 462 | 462–466 | OK |
| `forceFrameRate` | 468 | 468–483 | OK |
| `unstable_now` | 59 | 59–71 | OK |
| `advanceTimers` | 103 | 103–125 | OK |
| `handleTimeout` | 127 | 127–142 | OK |
| `flushWork` | 144 | 144–186 | OK |
| `workLoop` | 188 | 188–258 | OK |
| `performWorkUntilDeadline` | 485 | 485–514 | OK |
| `requestHostCallback` | 549 | 549–554 | OK |
| `requestHostTimeout` | 556 | 556–570 | OK |
| `compare` | 91 | 91–95 | OK |
| `SchedulerPriorities.js` | 10 | 10–18 | OK |
| `Task` type | 49 | 47–57 | Slightly off (47, not 49) |
| module state | 59 | 59–101, 437–445 | Partial OK |
| `push` heap | 17 | 17–21 | OK |
| reconciler main `scheduleCallback` call | 500 | 500–503 | OK |
| `performWorkOnRootViaSchedulerTask` | (implicit) | 513 | Should be called out |
| `forceSync = didTimeout;  // L521` (line 689) | 521 | 589 | **Wrong** |
| `processRootScheduleInMicrotask (... :442–456)` (line 790) | 442–456 | 339–341 | **Wrong** |
| `workLoopConcurrentByScheduler (L3051)` (line 693) | 3051 | 3051–3057 | OK |

Two stale line numbers to fix: the `forceSync` comment (`521 → 589`) and the `processRootScheduleInMicrotask` ref (`442–456 → 339–341`). Also `Task` type line 49 → 47 is a minor fix.

### H. Visual hierarchy / narrative flow

**H1. Thesis not central.**
Iter-1's "THESIS" subpanel at module-state line 321 ("No true preemption. Yield + heap re-root between slices.") is a tiny caption in the corner of an already-dense panel. The source doc §1.1 presents this as THE paragraph the whole scheduler exists to implement. It should be a prominent, possibly centered, panel with its own visual weight.

**H2. No loop-back.**
The diagram flows top-to-bottom: title → public API → priorities → module state → data structures → host pump → work loop → more/no more work → browser time → error → reconciler bridge → continuation + preemption. This reads like a textbook TOC, not a scheduler. The scheduler is defined by two loops:
- **Outer loop:** `performWorkUntilDeadline → flushWork → workLoop → return true → schedulePerformWorkUntilDeadline → performWorkUntilDeadline` (this is THE macrotask cycle).
- **Inner loop:** the `while (currentTask !== null)` inside `workLoop`.

Iter-1 has a small loop-back line inside `workLoop` (line 592–593) for the inner loop. The outer loop is nowhere — it would require an arrow from the "hasMoreWork=true" green box (line 611) back up through "browser time" back to `performWorkUntilDeadline`. Drawing that curve is the single highest-impact visual change.

**H3. Density obscures the key story.**
The diagram has ~15 high-information panels stacked vertically with ~45+ arrows. A reader has to read everything to find the centerpiece. Adding a small "narrative" panel near the top with three numbered arrows ("① scheduleCallback builds Task + pushes heap → ② host pump fires performWorkUntilDeadline → ③ workLoop drains heap under 5 ms budget, yields via continuation, loops") would give a reading order.

**H4. `startTime` module-var vs `Task.startTime` collision partially handled.**
Iter-1 module-state panel line 300–302 correctly flags the naming collision with a red warning. Good. But the visual tie between this `startTime` and the `shouldYieldToHost` formula at line 567 (`timeElapsed = now() - startTime`) is absent. An arrow from the module-state `startTime` entry to the `shouldYieldToHost` panel labelled "read here for 5 ms budget" would make the module-scope connection obvious.

### I. Claims vs reality

**I1. "Scheduler has zero React dependency" — true.**
Iter-1 reconciler bridge at line 668. Source doc §1.2. Correct.

**I2. "forceSync = didTimeout" — incomplete.**
Iter-1 line 689: `forceSync = didTimeout;  // L521 starvation → renderRootSync`. Actual source doc §15.7:
```js
const forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout;
```
Missing the `!disableSchedulerTimeoutInWorkLoop` guard. This matters because source doc §15.7 has a direct comment ("TODO: We only check `didTimeout` defensively...") saying the reconciler has its own expiration tracking and `didTimeout` is "redundant". Claiming a plain `forceSync = didTimeout` is a slight simplification that drops context.

**I3. "SyncLane work never reaches the scheduler — flushed via queueMicrotask in processRootScheduleInMicrotask" — correct but wrong line.**
Line 790 cites `ReactFiberRootScheduler.js:442–456`. Source doc §15.8 puts the relevant code at `339–341` (the `flushSyncWorkAcrossRoots_impl` call inside `processRootScheduleInMicrotask`). The header definition is at `:259`. Fix the line range.

**I4. "shouldYield === Scheduler.shouldYieldToHost — shared clock on both sides" — correct and a nice touch.**
Iter-1 line 696. Good — keep.

**I5. "continuationCallback === 'function' → store on same Task" — correct but continuation bypass of `shouldYieldToHost` not emphasized.**
Source doc §10.2 step G: "continuation yields do NOT consult `shouldYieldToHost`. The callback is trusted when it says 'call me back.'" Iter-1's continuation branches panel (line 575–580) says "task.callback = continuationCallback; advanceTimers(currentTime); return true" but never says the return-true bypasses the yield check. This is a subtle but important semantic: two tasks that both want to yield get different treatment.

### J. Missing connections / arrows

**J1. No arrow from `unstable_cancelCallback` → the heap tombstones.**
Source doc §11. Cancellation is one of the most important concepts (why the heap is lazy) and iter-1's only mention is "lazy tombstone (task.callback=null)" in the public API panel. There's no arrow showing cancellation → tombstone in heap → swept by `advanceTimers` (timerQueue) or workLoop cancelled branch (taskQueue).

**J2. No arrow from `requestPaint` → `needsPaint = true` → yield check.**
Iter-1 public API panel mentions `unstable_requestPaint` but the flag lifecycle (set by user → read by yield check → cleared at top of next slice) is only visible as three disconnected text mentions in three panels. Should be a single flow arrow.

**J3. No feedback arrow `hasMoreWork → schedulePerformWorkUntilDeadline → performWorkUntilDeadline`.**
See H2. Biggest missing arrow.

**J4. No arrow `didUserCallbackTimeout → forceSync` from Scheduler to Reconciler.**
The yield check and the reconciler's sync-render switch use the same expired bit; they should be visually connected.

**J5. `scheduleCallback(delayed branch) → requestHostTimeout → handleTimeout → advanceTimers → requestHostCallback` path.**
Iter-1 shows this via two disconnected arrows (orange line for `delayed branch → requestHostTimeout` at line 398) but doesn't connect it to the eventual `requestHostCallback` that starts the main pump. The wake-up chain is broken visually.

### K. Missing data / tables / thresholds

**K1. Full priority table with `expirationTime @ t=0`.**
Source doc §4.3 and §17.5 have a precise table. Iter-1 priority-mapping panel has the timeouts but not the `expirationTime @ t=0` column.

**K2. `SchedulerFeatureFlags.js` defaults.**
Source doc §17.4:
| Flag | Default |
|---|---|
| `enableProfiling` | false |
| `frameYieldMs` | 5 |
| `userBlockingPriorityTimeout` | 250 |
| `normalPriorityTimeout` | 5000 |
| `lowPriorityTimeout` | 10000 |
| `enableRequestPaint` | true |
| `enableAlwaysYieldScheduler` | `__EXPERIMENTAL__` |

Iter-1 has the timeouts scattered across priority panel and module-state panel but no single "feature flags" table. `enableAlwaysYieldScheduler`, `enableRequestPaint`, `enableProfiling` all live in different places.

**K3. Background-tab throttling comparison table.**
Source doc §9.6:
| Primitive | Background |
|---|---|
| `setImmediate` | Node only, N/A |
| `MessageChannel` | ~1/min throttle |
| `setTimeout(fn, 0)` | 1 s minimum |
| `requestAnimationFrame` | **Paused entirely** |
| `requestIdleCallback` | Deferred |

Iter-1 host-pump panel has one-line mentions but no comparison. A table would justify "why MessageChannel".

**K4. Heap cost table.**
Source doc §3.2:
| Operation | Cost |
|---|---|
| `peek` | O(1) |
| `push` | O(log n) |
| `pop` | O(log n) |
| `unstable_cancelCallback` | O(1) |
| `advanceTimers` k | O(k log n) |

Iter-1 has one dense line at 382 that runs these together. A clean table would be nicer but this is minor.

### L. Iteration 1 narrative / mental-model issues (rendered-in-head pass)

**L1. Entry-point confusion.** Reading top-to-bottom, the first concrete action is in the "BROWSER MAIN THREAD" green band followed by "The problem: 200ms block vs 5ms slices". This is fine as framing but then jumps straight to Public API without showing HOW the reconciler invokes the scheduler. A reader has to wait until the reconciler-bridge panel (which is at the BOTTOM, line 662) to understand the entry point. Consider moving a mini "entry point" box near the top: `reconciler calls scheduleCallback(priority, perfWorkOnRootViaSchedulerTask.bind(null, root))`, annotated.

**L2. The "what runs when" story fragments across four panels.** Host pump panel shows the primitives. Work loop panel shows the inner loop. Error panel shows self-healing. Reconciler bridge shows the callback dance. But no single panel says "one macrotask = one call to performWorkUntilDeadline = up to 5 ms of draining = yields via continuation OR exhaustion OR error". The "slice" concept doesn't have its own visual.

**L3. `startTime` confusion persists.**
Iter-1 does correctly warn about the naming collision (line 302), but in the `shouldYieldToHost` panel at line 567 the formula is `timeElapsed = now() - startTime; // L452 (module startTime)`. "module startTime" is an ambiguous clarification — it could be read as "module scheduler's startTime" when the point is "module var, not the Task field". A clearer wording: `// L452 — uses module startTime (L445), NOT Task.startTime`.

**L4. The `enableAlwaysYieldScheduler` feature flag is not mentioned.**
Source doc §12.8 and gotcha #27. This experimental mode flips yielding upside down (three code changes at lines 193, 241, 448). The iter-1 diagram has no mention. Not critical for the core story but worth a one-line footnote in the workLoop panel.

**L5. The three-tier `performWorkUntilDeadline → flushWork → workLoop` onion.**
Source doc §7 calls these "three nested layers, from outermost to innermost". Iter-1's work-loop panel sequentially lists them but doesn't visually nest them. A nested-rectangle diagram (workLoop inside flushWork inside performWorkUntilDeadline) would convey the try/finally layering and the "error tap in profiling mode is between these two" visual intuition from §7.3 and §14.2.

---

## Actionable recommendations for the iter-2 diagram

Prioritized by how much mental-model benefit per unit of diagram space.

### P0 — must-fix

- **P0.1. Draw the outer feedback loop.** Add a loop-back arrow from "hasMoreWork=true → schedulePerformWorkUntilDeadline" (currently iter-1 line 611) back UP to `performWorkUntilDeadline` (line 497). This is THE macrotask cycle; without it the diagram reads as a flowchart instead of a loop. Label the arrow "next macrotask (browser may have re-rooted heap)".

- **P0.2. Add at least one execution trace.** Draw a small timeline panel (x-axis = time in ms, y-axis = what's happening) showing Appendix A: transition render → shouldYield → continuation → post message → click landing → cancelCallback → scheduleCallback(UserBlocking) → next slice peeks click task → `renderRootSync` (because `includesBlockingLane`) → prepareFreshStack → commit → next slice re-enters transition. This single panel replaces ~200 lines of source doc prose.

- **P0.3. Fix stale line numbers.**
  - Title: "598 lines" → "599 lines"
  - `Task` type ref: 49 → 47
  - `forceSync = didTimeout;  // L521` → `forceSync = !disableSchedulerTimeoutInWorkLoop && didTimeout;  // ReactFiberRootScheduler.js:589`
  - `processRootScheduleInMicrotask (...:442–456)` → `(...:259, flush at :339–341)`

- **P0.4. Show the three reconciler work loops.** In the reconciler-bridge panel, replace the single `workLoopConcurrentByScheduler` mention with a small 3-row table:
  | Loop | When | Yield? |
  |---|---|---|
  | `workLoopSync` | act / forceSync / expired | No |
  | `workLoopConcurrent` | `enableThrottledScheduling` | 25/5 ms `now()` poll |
  | `workLoopConcurrentByScheduler` | default | `shouldYield()` per fiber |
  Source: doc §10.5, §15.5. This is the single biggest missing chunk of reconciler context.

- **P0.5. Fix the `didTimeout → forceSync` bridge.** Include the `!disableSchedulerTimeoutInWorkLoop` guard. Optionally include the source doc's comment block about "Scheduler bug we're still investigating".

### P1 — high value

- **P1.1. Add an Appendix D "ordering constraints" panel.** A compact ~10-row table listing ordering rules that MUST hold (tombstone before invoke, clock refresh after invoke, `hasMoreWork=true` before try, etc.). Each row = rule + line numbers + one-phrase justification. Source doc Appendix D is literally this table in prose.

- **P1.2. Add a `handleTimeout` body panel.** Currently the host-pump panel has one sentence for `handleTimeout`. Expand it to show the three branches at L131–141: (a) if `!isHostCallbackScheduled && peek(taskQueue) !== null` → `requestHostCallback`; (b) else if `firstTimer` → re-arm for next timer (NOTE: this path does not set the flag!); (c) else no-op. Link to gotcha #11 asymmetry.

- **P1.3. Visually nest the three work-loop layers.** Redraw the work-loop panel as three concentric rectangles: outermost `performWorkUntilDeadline` (needsPaint=false, startTime=now, try/finally), middle `flushWork` (isHost*=false, isPerformingWork=true, previousPriority, try/finally), innermost `workLoop` (the while loop). Put the try/finally restoration in the matching layer's outer edge.

- **P1.4. Connect cancellation to the lazy sweep.** Draw an arrow from `unstable_cancelCallback` → heap cell "task.callback = null" → two sweep sites: `advanceTimers` (timerQueue path) and workLoop's else-branch L237 (taskQueue path). Source doc §11.2.

- **P1.5. Add a prominent thesis panel.** Near the top of the diagram, make a single centered rectangle with the six-word thesis: "Preemption is a heap re-root between macrotasks". Give it visible weight (larger font, framed). This is the sentence the whole scheduler embodies.

- **P1.6. Show `performWorkOnRootViaSchedulerTask` as a 9-step flow.** Source doc §15.3 has the exact sequence. Currently iter-1 shows it as 6 code fragments; replace with a numbered 9-step list including: `hasPendingCommitEffects` early exit, `flushPendingEffectsDelayed`, identity re-check after flush, `getNextLanes`, `forceSync` computation, `performWorkOnRoot`, `scheduleTaskForRootDuringMicrotask`, final identity check, return continuation-bind vs null.

- **P1.7. Visualize the continuation invariant with a heap cell.** Draw a small "heap slot for Task #1" with the `callback` field in a separate sub-slot. Show the sub-slot going `cb₁ → null → cb₂ → null → cb₃`. Label sortIndex, id, expirationTime as unchanged. This is the invariant in one picture.

### P2 — nice to have

- **P2.1. `frameYieldMs` fork variation callout.** Prod/native-fb = 5, www = 10. Source doc §8.2.

- **P2.2. Feature flags table.** Source doc §17.4, 7 rows. Put it alongside or inside the module-state panel.

- **P2.3. "Removed APIs" footnote.** `unstable_pauseExecution`, `unstable_continueExecution`, `unstable_getFirstCallbackNode`, `cancelHostCallback`, `isSchedulerPaused`, the old `isInputPending()` integration. Source doc §5.11.

- **P2.4. `enableAlwaysYieldScheduler` experimental mode callout.** Source doc §12.8. One-line note in the workLoop panel: "Experimental mode flips this (see L193, 241, 448)".

- **P2.5. Background-tab throttling table.** Source doc §9.6. Helps justify MessageChannel choice.

- **P2.6. Arrow from `didUserCallbackTimeout` at L207 → both uses.** (a) back into the yield check conjunct, and (b) forward to the reconciler's `forceSync`. One value, two consumers.

- **P2.7. Heap cost table.** Clean 5-row table in the data-structures panel.

- **P2.8. `advanceTimers` four-site callout.** A small box listing all four callers (L129, L190, L223, L235) and their reasons. Source doc §6.3 table.

- **P2.9. `workLoop` two-return-true distinction.** Tiny table or note in the termination section of the workLoop panel:
  | Line | Meaning |
  |---|---|
  | 224 | Continuation yield (mid-task) |
  | 250 | Deadline break (between tasks) |
  | 256 | Heap drained (return false; may arm host timeout) |

- **P2.10. "Two entry points" framing for `performWorkUntilDeadline` + `handleTimeout`.** Draw them as twin boxes at the same level, both feeding into `advanceTimers` and then diverging. Source doc gotcha #35.

### P3 — polish

- **P3.1. Add execution traces for Appendix B (error) and Appendix C (delayed wake).** If P0.2 covers only A, at least link to or outline B and C in compact form.

- **P3.2. Rename the `startTime` dim caption to be unambiguous.** Current: "(module startTime)". Better: "module `startTime` (L445), NOT `Task.startTime`".

- **P3.3. `scheduleImmediateRootScheduleTask` one-line mention.** Source doc §15.9. Explain why `ImmediatePriority` shows up in Safari fallbacks.

- **P3.4. `unstable_wrapCallback` priority-capture-at-wrap-time annotation.** Currently iter-1 mentions it in the notes column; could also annotate with the exact semantic: "captures `parentPriorityLevel` at wrap, restores at invoke — used by `ReactFiberAsyncAction` to preserve transition priority".

- **P3.5. `unstable_next` demote-only table.** Three rows: Immediate/UserBlocking/Normal → Normal; Low/Idle pass-through.

- **P3.6. `currentPriorityLevel` ambient leak annotation.** Currently "(leaks mid-loop)" in a dim caption. Promote to a proper note: "Set per-task at L205. NOT unwound between tasks inside a single workLoop — only in flushWork's finally L179. Gotcha #23."

---

## Priority summary

- **P0 (5 items)** — fix broken line refs, add feedback loop arrow, add one execution trace, show three work loops, fix `forceSync` expression.
- **P1 (7 items)** — ordering constraints table, handleTimeout body, nested work-loop layers, cancellation flow, thesis panel, 9-step reconciler sequence, heap-cell continuation invariant.
- **P2 (10 items)** — tables and small callouts that add depth without restructuring.
- **P3 (6 items)** — polish and lightweight fixes.

The single most important iter-2 change is **P0.1 (feedback loop arrow) + P0.2 (execution trace)** — together they convert the diagram from a static TOC into a dynamic model of what the scheduler actually does at runtime. Everything else is incremental.
