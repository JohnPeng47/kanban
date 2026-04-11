## performWorkUntilDeadline

Source of truth: `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js` lines 485-514.

Canonical flow (in order, per source):

1. L486-488 — `if (enableRequestPaint) needsPaint = false;`
2. L489 — `if (isMessageLoopRunning)` guard
3. L490 — `const currentTime = getCurrentTime();`
4. L493 — `startTime = currentTime;`
5. L501 — `let hasMoreWork = true;` (BEFORE the try)
6. L502-503 — `try { hasMoreWork = flushWork(currentTime); }`
7. L504-512 — `finally { if (hasMoreWork) schedulePerformWorkUntilDeadline(); else isMessageLoopRunning = false; }`

Box-by-box check of the diagram (svg lines 629-655, SVG x=32..952, y=1944):

| # | Diagram box text | Match? |
|---|---|---|
| 1 | "macrotask fires · port1.onmessage" | OK — fires the `performWorkUntilDeadline` body; the `port1.onmessage = performWorkUntilDeadline` wiring is L534-538. |
| 2 | "needsPaint = false · startTime = now()" | PARTIALLY IMPRECISE — these are two separate statements at L487 and L493 with an `if (isMessageLoopRunning)` guard and an intermediate `currentTime = getCurrentTime()` between them. Collapsing them into one visual box is fine for a flowchart, but the diagram drops the `isMessageLoopRunning` guard entirely. Not shown at all. Minor. |
| 3 | "hasMoreWork = true · init BEFORE try · self-heal" | OK — exactly matches L501 and the self-heal comment at L495-500. |
| 4 | "try { hasMoreWork = flushWork() }" | OK — L502-503. The diagram drops the `currentTime` argument passed to `flushWork`. Minor. |
| 5 | "finally { reschedule / idle }" | OK — L504-512. Captures both branches (`schedulePerformWorkUntilDeadline` and `isMessageLoopRunning = false`). |

**Throw-resilience callout (svg line 658):** `"if flushWork throws → hasMoreWork stays true → reschedule next slice · error escapes to onerror"` — ACCURATE. The comment block at L495-500 says exactly this: "if `flushWork` errors, then `hasMoreWork` will remain true, and we'll continue the work loop" and "exit the current browser task so the error can be observed."

**Missing / minor:**

- MINOR: The `isMessageLoopRunning` guard (L489) is not represented in the flowchart — the macrotask can fire and find the pump already marked idle, in which case nothing happens. Worth a one-line callout, but not wrong as drawn.
- MINOR: Box 2 merges two distinct statements (L487, L493) with an intervening `getCurrentTime()` sample at L490. Acceptable compression.
- OK: Order of boxes matches source control flow exactly.

---

## flushWork

Source of truth: Scheduler.js L144-186.

Canonical order:

1. L145-147 — `if (enableProfiling) markSchedulerUnsuspended(initialTime);` (omitted from diagram, fine)
2. L150 — `isHostCallbackScheduled = false;`
3. L151-155 — `if (isHostTimeoutScheduled) { isHostTimeoutScheduled = false; cancelHostTimeout(); }`
4. L157 — `isPerformingWork = true;`
5. L158 — `const previousPriorityLevel = currentPriorityLevel;`
6. L159 — `try { ... return workLoop(initialTime); ... }`
7. L177-185 — `finally { currentTask = null; currentPriorityLevel = previousPriorityLevel; isPerformingWork = false; ... }`

Diagram text (svg lines 663-664):
- Top row: `"isHostCallbackScheduled=false · cancel pending timeout · isPerformingWork=true · save currentPriorityLevel → workLoop(t)"`
- Bottom row: `"finally: currentTask=null · restore priority · isPerformingWork=false"`

**Order check:** The diagram's top-row order (`isHostCallbackScheduled=false` → cancel pending timeout → `isPerformingWork=true` → save pri → `workLoop`) matches the source order L150 → L151-155 → L157 → L158 → L162/175. OK.

**Finally-block order:** Source order is L178 (`currentTask=null`) → L179 (`currentPriorityLevel = previousPriorityLevel`) → L180 (`isPerformingWork=false`). Diagram says `"currentTask=null · restore priority · isPerformingWork=false"` — matches. OK.

**Missing / minor:**

- MINOR: The diagram collapses the two-layer try (outer `try/finally` + inner profiling `try/catch` at L160-172) into a single bar. Reasonable simplification — a flowchart-level view does not need to show the profiling-only error tap. The tombstone trick / error propagation is covered in the separate "Error resilience" row at svg L824-866.
- OK: No factual errors in the bar.

---

## workLoop state machine

Source of truth: Scheduler.js L188-258. This is the highest-stakes section of the audit. Findings below, in source order.

### 1. ENTRY box (svg L701-704)

Diagram text: `"ENTRY · L189-191"`, `"advanceTimers"`, `"curTask = peek"`.

Source:
```
189    let currentTime = initialTime;
190    advanceTimers(currentTime);
191    currentTask = peek(taskQueue);
```

**OK.** The order (advanceTimers first, THEN peek) is faithful. The L189 `currentTime = initialTime` is omitted — fine, it is just parameter binding.

### 2. `curTask null?` diamond (svg L714-716)

Diagram text: `"curTask null?"`, `"L192"`.

Source: L192 `while (currentTask !== null) {` — the `while` condition is the implicit diamond. **OK.**

### 3. DRAINED exit (svg L721-725)

Diagram text: `"DRAINED"`, `"peek timerQueue"`, `"requestHostTimeout"`, `"return false"`.

Source:
```
251    } else {
252      const firstTimer = peek(timerQueue);
253      if (firstTimer !== null) {
254        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
255      }
256      return false;
257    }
```

**MISLEADING CONTROL FLOW (MINOR).** The "drained" branch is NOT reached directly from the `null?` diamond at L192 — it is reached after the `while` loop finishes normally (i.e. after `currentTask = peek(taskQueue)` at L240 produces `null` AND the loop condition at L192 becomes false). The post-loop tail at L249-257 then checks `currentTask !== null` *again* (L249) and takes the false branch at L251. The diagram collapses this (null at loop-entry → DRAINED straight out) which is semantically correct for the "first call has empty taskQueue" case and for the "loop drained it" case (because the loop-back arrow at svg L707 re-enters ENTRY, which re-peeks). So the wiring is defensible, but a reader inspecting source-to-diagram mapping will notice the post-loop tail (L249-257) is not drawn anywhere.

**MINOR:** The DRAINED box has no line-number anchor. Task description specifically asks about L256 — that is the `return false;` line. Adding `L249-256` on the box would match the pattern used for BREAK (`return true · L250`).

### 4. yield? diamond (svg L732-734)

Diagram text: `"not expired AND"`, `"shouldYield? · L194"`.

Source:
```
193    if (!enableAlwaysYieldScheduler) {
194      if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
195        // This currentTask hasn't expired, and we've reached the deadline.
196        break;
197      }
198    }
```

**OK.** Condition phrased as "not expired AND shouldYield" matches `currentTask.expirationTime > currentTime && shouldYieldToHost()`. The `!enableAlwaysYieldScheduler` feature-flag guard (L193) is omitted — acceptable simplification.

### 5. BREAK exit (svg L739-741)

Diagram text: `"BREAK"`, `"return true · L250"`.

Source: `break;` is at L196. `return true;` is at L250 (the post-loop tail):
```
248    // Return whether there's additional work
249    if (currentTask !== null) {
250      return true;
```

**CRITICAL (order of operations is OK but the line anchor is slightly misleading).** The diagram box labels the BREAK with `L250`. That is the line where the actual `return true` happens — accurate, because the `break` at L196 falls through to the post-loop tail at L249-250. However, the question posed in the audit prompt asked whether `L250` is correct when the `break` itself is at L196 — the answer is: **yes**, because the diagram is labeling the *return site*, not the break site. But a reader would benefit from seeing `break L196 → return true L250` spelled out. **MINOR.**

### 6. `cb === function?` diamond (svg L748-750)

Diagram text: `"cb === function?"`, `"L201"`.

Source:
```
200    const callback = currentTask.callback;
201    if (typeof callback === 'function') {
```

**OK.** L201 is the correct line for the `typeof callback === 'function'` test.

### 7. `pop (tombstone)` / cancelled branch (svg L755-758)

Diagram text: `"pop (tombstone)"`, `"cancelled sweep"`, `"L238"`.

Source:
```
237    } else {
238      pop(taskQueue);
239    }
```

**OK.** L238 is exactly `pop(taskQueue);` in the cancelled branch. Label is correct.

**However** — the calling this box "tombstone" is semantically confusing because the term "TOMBSTONE" is also used (correctly) on the invoke-path box at svg L768-770 to describe the `currentTask.callback = null` pre-clearing at L203. Using "tombstone" for both the *creation* (L203) and the *reaping* (L238) of the tombstone is okay because that IS the pair — one sets the marker, the other sweeps it — but a reader may conflate them. **MINOR** labelling concern.

### 8. TOMBSTONE box — L203 BEFORE invoke (svg L768-770)

Diagram text: `"TOMBSTONE · L203 (BEFORE invoke)"`, `"currentTask.callback = null"`.

Source:
```
202      // $FlowFixMe[incompatible-use] found when upgrading Flow
203      currentTask.callback = null;
204      // $FlowFixMe[incompatible-use] found when upgrading Flow
205      currentPriorityLevel = currentTask.priorityLevel;
206      // $FlowFixMe[incompatible-use] found when upgrading Flow
207      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
208      if (enableProfiling) {
209        markTaskRun(currentTask, currentTime);
210      }
211      const continuationCallback = callback(didUserCallbackTimeout);
```

**OK and CRITICAL ACCURATE.** L203 is indeed `currentTask.callback = null;` and it is at L203, BEFORE the invoke at L212. This is the entire "pre-tombstone trick" explained in the diagram's "PRE-TOMBSTONE TRICK" callout at svg L865. Accurate.

**MISSING (MINOR):** Between TOMBSTONE and INVOKE, the source does *three* things the diagram does not show:
- L205: `currentPriorityLevel = currentTask.priorityLevel;` — the per-task priority assignment. The audit prompt asks to flag this explicitly. **FLAGGED: missing.** Impact is low because the finally block in flushWork restores `previousPriorityLevel`, and the leak between iterations is documented in preloop/04. The diagram does not claim to be exhaustive, but this omission means a reader won't learn where `unstable_getCurrentPriorityLevel` inside the user callback gets its value.
- L207: `didUserCallbackTimeout = currentTask.expirationTime <= currentTime;` — the diagram's INVOKE box says `result = cb(didTimeout)` but does not say where `didTimeout` comes from. It is computed at L207. **MINOR** — a small label `didTimeout = expTime ≤ curTime · L207` would close the gap.
- L208-210: `markTaskRun` — profiling-only, fine to omit.

### 9. INVOKE box (svg L774-776)

Diagram text: `"INVOKE · L212 (no try/catch)"`, `"result = cb(didTimeout)"`.

Source: L212 `const continuationCallback = callback(didUserCallbackTimeout);`

**OK.** Line number correct. The "no try/catch" annotation is accurate in the prod path. (The inner profiling try/catch at L160-172 is in `flushWork`, NOT around the `callback()` call itself — so strictly, there is NO try/catch immediately around L212 in either path. The "no try/catch" label is correct.)

### 10. REFRESH CLOCK (svg L780-782)

Diagram text: `"REFRESH CLOCK · L213"`, `"currentTime = getCurrentTime()"`.

Source: L213 `currentTime = getCurrentTime();`

**OK.** Line number exactly right.

### 11. `result === function?` diamond (svg L787-789)

Diagram text: `"result === function?"`, `"L214"`.

Source: L214 `if (typeof continuationCallback === 'function') {`

**OK.**

### 12. COMPLETION box (LEFT, svg L794-798)

Diagram text: `"COMPLETION"`, `"if (curTask===peek)"`, `"  pop  · L232 (guarded)"`.

Source:
```
225      } else {
226        if (enableProfiling) {
227          markTaskCompleted(currentTask, currentTime);
228          currentTask.isQueued = false;
229        }
230        // $FlowFixMe[incompatible-use] found when upgrading Flow
231        // Note: Inlined for perf reasons
232        if (currentTask === peek(taskQueue)) {
233          pop(taskQueue);
234        }
235        advanceTimers(currentTime);
236      }
```

**MISSING (MINOR):** The COMPLETION box does NOT mention `advanceTimers(currentTime)` at L235. The audit prompt specifically asks: *"does it show that advanceTimers runs after the guarded pop?"* — **NO, it does not.** The box only shows the guarded pop at L232. This is a real omission because the companion CONTINUATION box at svg L807 *does* mention `advTmrs`. The asymmetry may mislead readers into thinking advanceTimers runs only in the continuation path. Source runs it in BOTH paths (L235 for completion, L223 for continuation).

**Recommended fix:** Add a third line in the COMPLETION box: `"advanceTimers · L235"`, matching the pattern used for CONTINUATION.

### 13. CONTINUATION box (RIGHT, svg L805-808)

Diagram text: `"CONTINUATION"`, `"cb = result · advTmrs"`, `"return true · L224"`.

Source:
```
214      if (typeof continuationCallback === 'function') {
...
218        currentTask.callback = continuationCallback;
...
223        advanceTimers(currentTime);
224        return true;
```

**OK.** "cb = result" corresponds to L218 (`currentTask.callback = continuationCallback`), "advTmrs" corresponds to L223, "return true · L224" is exactly L224.

### 14. Loop-back arrow (svg L707-708)

Diagram text: `"loop back: curTask = peek · L240"`, path from bottom of work-loop back up into ENTRY.

Source: L240 `currentTask = peek(taskQueue);`

**OK — line number correct.** The loop-back target is ENTRY, which says `advanceTimers · curTask = peek`. In source, the loop iterates by re-evaluating the `while` condition at L192 AFTER L240's re-peek; it does NOT re-run `advanceTimers(currentTime)` from L190 on each iteration — that happens only on the first entry to `workLoop`. **MINOR semantic drift:** routing the loop-back into ENTRY implies `advanceTimers` runs on each iteration, which it does not (advanceTimers on each iteration runs only from L223 / L235, inside the branch bodies). Consider routing the loop-back to the `curTask null?` diamond instead of the ENTRY box.

### 15. `didTimeout` derivation (INVOKE)

The prompt asks: *"does INVOKE actually pass `didTimeout` as the argument?"*

Source L212: `const continuationCallback = callback(didUserCallbackTimeout);` — yes, the argument is the pre-computed L207 `didUserCallbackTimeout`. The diagram labels the parameter `didTimeout` (shortened form) which is fine as a visual convention, though the source variable name is `didUserCallbackTimeout`.

**MINOR:** could annotate the INVOKE box with `didTimeout = L207` or show the computation somewhere.

### 16. Cancelled-branch loop arrow (svg L761)

The diagram shows a dashed short arrow from the "pop (tombstone)" box labeled "loop" that goes further left off-screen. This visually suggests the cancelled branch bypasses the peek-and-re-enter step. Source L238 `pop(taskQueue);` falls through to L240 `currentTask = peek(taskQueue);` and the `while` re-evaluates. The "loop" dangle is ambiguous — it is not actually wired to the loop-back spine — **MINOR** cosmetic issue.

---

## shouldYieldToHost

Source of truth: Scheduler.js L447-460.

```
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

Diagram inset panel (svg L670-698):

1. Diamond 1 (svg L676-682): `"needsPaint? · L448"` → `yes → → true` (green arrow), `no → ↓`
2. Diamond 2 (svg L685-692): `"now - startTime < frameInterval?"` → `yes → → false` (red arrow), `no → ↓`
3. Terminal (svg L694-695): `"return true"`
4. Footnote (svg L697): `"startTime is module var"`

**Logic check:**

- Diamond 1: `needsPaint?` yes → returns `true`. Source L448 `if (... needsPaint) return true;`. **OK.** (The `!enableAlwaysYieldScheduler && enableRequestPaint &&` conjuncts are elided, which is acceptable because the normal code path has both flags set to their defaults.)
- Diamond 2: `now - startTime < frameInterval?` yes → returns `false`. Source L453 `if (timeElapsed < frameInterval) return false;`. **OK.** The arithmetic direction matches (`<`, not `>=`), and the yes-branch returns `false`, which is the correct "still have budget" answer.
- Terminal: `return true`. Source L459. **OK.**

**Two-diamond structure is correct.** This is the upgrade the prompt explicitly flagged as the whole point of better2 vs better1 ("better1 had the two checks collapsed into one ambiguous diamond"). Better2 correctly separates them into two sequential diamonds in strict L448 → L452-456 → L459 order.

**Labeling check — `< frameInterval` vs `>= frameInterval`:**

Source: `if (timeElapsed < frameInterval) return false;`. The diamond asks `now - startTime < frameInterval?`. Same predicate. Yes → `false` (don't yield, budget left). No → fallthrough → `return true`. **EXACTLY MATCHES SOURCE.**

**Footnote:** `"startTime is module var"` — accurate. Set by `performWorkUntilDeadline` at L493 on each slice entry, read here at L452. Declared at L445.

**Missing line anchors:** Diamond 2 has no line-number label. Consider adding `L452-453`. **MINOR.**

---

## Return paths

The audit prompt says:

> The diagram shows three colored boxes: CONTINUATION yield (L224), DEADLINE yield (L250), DRAINED (L256). Verify each line number.

**FINDING — discrepancy with prompt description:** The diagram does NOT have three separate "return path" callout boxes at the bottom. What it has:

1. A subhead at svg L816: `"Three return paths → hasMoreWork flag → next slice behavior"` — but this is ONLY the header label. No follow-up colored boxes are drawn beneath it.
2. The three return paths are instead embedded in the workLoop state machine itself:
   - `DRAINED` violet box at svg L721-725 → `"return false"` (no line number)
   - `BREAK` violet box at svg L739-741 → `"return true · L250"`
   - `CONTINUATION` green box at svg L805-808 → `"return true · L224"`
   - Also a small `"YIELDED (cont)"` violet cap at svg L812-813 below CONTINUATION.

**Line-number verification against source:**

| Path | Diagram label | Source L | Correct? |
|---|---|---|---|
| Continuation yield | `return true · L224` | L224 `return true;` inside `if (typeof continuationCallback === 'function')` | **OK** |
| Deadline yield (break → post-loop) | `return true · L250` | L250 `return true;` inside `if (currentTask !== null)` | **OK** |
| Drained | `return false` (no L#) | L256 `return false;` | **MISSING L256 LABEL — MINOR** |

**Prompt asks if these exist as "three colored boxes" at the bottom of work loop.** They do not. They are woven into the state machine. That is a *better* design (no duplication, shows exit at its true structural location), but the prompt's expectation of a bottom-of-diagram callout strip is unmet. Worth flagging because the svg subhead `"Three return paths → hasMoreWork flag → next slice behavior"` at svg L816 advertises something that is not there — it is a dangling heading.

**Recommended fix:** Either (a) add a small 3-box strip under svg L816 summarizing the three return paths with line numbers L224, L250, L256, or (b) delete the `"Three return paths"` subhead at svg L816 since it has no body.

---

## Summary

### CRITICAL (factually wrong, will mislead readers)

None. The diagram is substantially accurate. The "pre-tombstone trick" at L203, the two-diamond shouldYieldToHost structure, the BREAK/CONTINUATION return paths at L250/L224, the self-healing `hasMoreWork = true` pattern, the flushWork try/finally order, and the performWorkUntilDeadline box order are all faithful to Scheduler.js L103-258, L447-460, L485-514.

### MINOR (imprecise labels, missing detail)

1. **performWorkUntilDeadline box 2** merges L487 (`needsPaint = false`) and L493 (`startTime = now()`) into one box, silently dropping the `isMessageLoopRunning` guard at L489 and the intermediate `currentTime = getCurrentTime()` sample at L490. Acceptable compression but omits detail.
2. **performWorkUntilDeadline box 4** drops the `currentTime` argument passed to `flushWork(currentTime)` at L503.
3. **COMPLETION box does NOT mention `advanceTimers(currentTime)` at L235.** Asymmetric with the CONTINUATION box which does show `advTmrs`. This is the most impactful minor finding because the audit prompt specifically asked about it — reader could reasonably conclude advanceTimers runs only on the continuation path when in fact it runs in BOTH paths (L223 and L235).
4. **TOMBSTONE→INVOKE path omits L205** (`currentPriorityLevel = currentTask.priorityLevel;`). Prompt explicitly asked to flag this. Consider a small annotation between TOMBSTONE and INVOKE: `"L205: currentPriorityLevel = task.priorityLevel"`.
5. **INVOKE box does not show where `didTimeout` comes from.** It is computed at L207 as `currentTask.expirationTime <= currentTime`. Suggested annotation: `didTimeout = expTime ≤ curTime · L207`.
6. **Loop-back arrow is wired to ENTRY box**, which implies `advanceTimers` re-runs on every iteration. Source runs advanceTimers at L190 (once, on workLoop entry) plus inside the branch bodies at L223/L235. Cleaner to route the loop-back to the `curTask null?` diamond at svg L714 instead.
7. **DRAINED box missing line anchor** — should say `L256` (the `return false;` site) to match the pattern used for BREAK (`L250`) and CONTINUATION (`L224`).
8. **Diamond 2 in shouldYieldToHost inset missing line anchor** — should say `L452-453`.
9. **Dangling subhead** `"Three return paths → hasMoreWork flag → next slice behavior"` at svg L816 advertises a return-path strip that is not drawn. Either add the strip or drop the subhead.
10. **"pop (tombstone)" label conflict** — "tombstone" is used both for the *creation* of the null marker at L203 (INVOKE-path box) and for its *sweep* at L238 (cancelled-path box). Semantically correct (they are the two halves of the lazy-reap protocol) but may confuse readers. Consider `"pop (lazy reap)"` for the L238 box.
11. **BREAK box labeled `L250` not `L196`** — the label is the *return* site, not the *break* site. Both are correct lines for their respective events, but a reader tracing source lines would benefit from `"break L196 → return true L250"` dual-labeling.
12. **Cancelled branch "loop" dashed arrow** at svg L761 dangles off the left side of the `pop (tombstone)` box without connecting to the main loop-back spine. Cosmetic.
13. **flushWork bar collapses outer try/finally + inner profiling try/catch into one band.** Acceptable simplification, no correctness issue.

### OK (faithful to source)

- Order of boxes in performWorkUntilDeadline flowchart (L486 → L493 → L501 → L502-503 → L504-512).
- `hasMoreWork = true` initialized BEFORE the try block (L501 before L502).
- finally reschedules on `true` and flips `isMessageLoopRunning = false` on `false` (L505-511).
- Throw-resilience callout accurately paraphrases L495-500 comment.
- flushWork bar's assignment order (isHostCallbackScheduled=false → cancel timeout → isPerformingWork=true → save priority → workLoop) matches L150 → L151-155 → L157 → L158 → L162/175.
- flushWork finally-block order (currentTask=null → restore priority → isPerformingWork=false) matches L178 → L179 → L180.
- ENTRY box ordering: advanceTimers BEFORE peek (L190 before L191).
- yield-check condition phrased as "not expired AND shouldYield" correctly matches `currentTask.expirationTime > currentTime && shouldYieldToHost()` at L194.
- `cb === function?` at L201 is correct.
- Cancelled-branch pop at L238 is correct.
- `TOMBSTONE · L203 (BEFORE invoke)` — exact and critical; the ordering claim (nulling BEFORE invoke) is essential to the pre-tombstone trick and is correct.
- `INVOKE · L212 (no try/catch)` — line number correct, "no try/catch" correct in both prod and profiling paths (the profiling try/catch wraps `workLoop` in `flushWork`, not `callback()` in `workLoop`).
- `REFRESH CLOCK · L213` — correct.
- `result === function? · L214` — correct.
- `COMPLETION: if (curTask===peek) pop · L232 (guarded)` — the guarded-pop pattern is exactly L232-234.
- `CONTINUATION: cb = result · advTmrs · return true · L224` — matches L218 / L223 / L224.
- `loop back: curTask = peek · L240` — line number correct (though see minor #6 for the routing concern).
- `shouldYieldToHost` two-diamond structure: `needsPaint? L448 → yes=true` then `elapsed < frameInterval? L452-453 → yes=false` then `return true L459`. **Exactly matches source; this is the key improvement over better1.**
- Continuation return path L224, deadline return path L250 — both line numbers correct.
- Throw-resilience error propagation chain at svg L824-866: callback throws (L212) → workLoop propagates → flushWork finally → performWorkUntilDeadline finally (hasMoreWork still true) → reschedule. Accurate.

### Source line anchors used in this audit

All line numbers below refer to `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`:

- advanceTimers: L103-125
- flushWork: L144-186 (isHostCallbackScheduled=false L150, isPerformingWork=true L157, workLoop call L162/175, finally L177-185)
- workLoop: L188-258 (ENTRY L189-191, while L192, yield check L193-198, callback snapshot L200, tombstone L203, priority L205, didTimeout L207, invoke L212, refresh L213, continuation branch L214-224, completion branch L225-236, cancelled pop L238, re-peek L240, post-loop L248-257)
- shouldYieldToHost: L447-460 (needsPaint L448, elapsed computation L452, budget check L453, final return L459)
- frameInterval declaration: L444; startTime declaration: L445
- performWorkUntilDeadline: L485-514 (needsPaint=false L487, isMessageLoopRunning guard L489, currentTime sample L490, startTime anchor L493, hasMoreWork init L501, try L502-503, finally L504-512)

### Files audited

- Diagram: `/home/john/kanban/experiment/iter-1/better2_diagram.html` (work loop section: svg lines 620-817)
- Source: `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js` (L103-258, L447-460, L485-514)
- Prior docs: `/home/john/kanban/experiment/preloop/04-work-loop.md`, `/home/john/kanban/experiment/preloop/05-yield-mechanism.md`, `/home/john/kanban/experiment/iter-2/source-doc.md`

Note: the diagram file is located at `/home/john/kanban/experiment/iter-1/better2_diagram.html`, not `/home/john/kanban/experiment/better2_diagram.html` as the prompt stated.
