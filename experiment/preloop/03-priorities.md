# 03 — Priority Levels and Priority → Timeout Mapping

## 1. The five priority levels (`SchedulerPriorities.js`)

File: `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerPriorities.js` (19 lines).

```js
// Line 10
export type PriorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

// Lines 13-18
export const NoPriority = 0;
export const ImmediatePriority = 1;
export const UserBlockingPriority = 2;
export const NormalPriority = 3;
export const LowPriority = 4;
export const IdlePriority = 5;
```

| Constant | Value | Line |
|---|---|---|
| `NoPriority` | `0` | 13 |
| `ImmediatePriority` | `1` | 14 |
| `UserBlockingPriority` | `2` | 15 |
| `NormalPriority` | `3` | 16 |
| `LowPriority` | `4` | 17 |
| `IdlePriority` | `5` | 18 |

A `// TODO: Use symbols?` comment sits above the block. `NoPriority` is a sentinel — every internal slot defaults to `NormalPriority`.

## 2. The timeout constants

Two sources of timeout values: **production** uses `SchedulerFeatureFlags.js` for some and inlines others; **mock** scheduler has the familiar screaming-snake-case constants.

### 2a. Production — `SchedulerFeatureFlags.js` (lines 10-18)

```js
export const enableProfiling = false;
export const frameYieldMs = 5;

export const userBlockingPriorityTimeout = 250;
export const normalPriorityTimeout = 5000;
export const lowPriorityTimeout = 10000;
export const enableRequestPaint = true;

export const enableAlwaysYieldScheduler = __EXPERIMENTAL__;
```

Imported in `forks/Scheduler.js:17-19`. The other two timeouts (`-1` for immediate, `maxSigned31BitInt` for idle) are written **inline** in the switch statement, with `maxSigned31BitInt` declared at `Scheduler.js:73-76`:

```js
// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;
```

### 2b. Mock scheduler — `SchedulerMock.js:51-63`

```js
var maxSigned31BitInt = 1073741823;

// Times out immediately
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
// Eventually times out
var USER_BLOCKING_PRIORITY_TIMEOUT = 250;
var NORMAL_PRIORITY_TIMEOUT = 5000;
var LOW_PRIORITY_TIMEOUT = 10000;
// Never times out
var IDLE_PRIORITY_TIMEOUT = maxSigned31BitInt;
```

| Constant | Value | Production location | Mock location |
|---|---|---|---|
| `IMMEDIATE_PRIORITY_TIMEOUT` | `-1` | inline at `Scheduler.js:350` | `SchedulerMock.js:57` |
| `USER_BLOCKING_PRIORITY_TIMEOUT` | `250` | `SchedulerFeatureFlags.js:13` | `SchedulerMock.js:59` |
| `NORMAL_PRIORITY_TIMEOUT` | `5000` | `SchedulerFeatureFlags.js:14` | `SchedulerMock.js:60` |
| `LOW_PRIORITY_TIMEOUT` | `10000` | `SchedulerFeatureFlags.js:15` | `SchedulerMock.js:61` |
| `IDLE_PRIORITY_TIMEOUT` | `maxSigned31BitInt` (= 1073741823) | inline at `Scheduler.js:358` | `SchedulerMock.js:63` |

## 3. The switch statement in `unstable_scheduleCallback` — `Scheduler.js:346-371`

```js
var timeout;
switch (priorityLevel) {
  case ImmediatePriority:
    timeout = -1;
    break;
  case UserBlockingPriority:
    timeout = userBlockingPriorityTimeout;
    break;
  case IdlePriority:
    timeout = maxSigned31BitInt;
    break;
  case LowPriority:
    timeout = lowPriorityTimeout;
    break;
  case NormalPriority:
  default:
    timeout = normalPriorityTimeout;
    break;
}

var expirationTime = startTime + timeout;
```

Notes:
- `NormalPriority` shares the `default` clause — unknown priority silently falls through to normal (5000 ms).
- `NoPriority` is NOT a case. If you schedule with `NoPriority` you fall through to normal.
- `ImmediatePriority` uses `-1` — `startTime - 1` makes the task "already expired" the moment it's queued.
- `IdlePriority` uses `maxSigned31BitInt` ≈ 12.43 days (see §6).
- Cases are intentionally not in numeric order — `Idle` is hoisted above `Low`/`Normal` to handle the special case before the fall-throughs.

The `startTime` itself is computed above (lines 332-344): `getCurrentTime()` plus an optional `options.delay`. Sequence: `currentTime → startTime → expirationTime = startTime + timeout`. Tasks with `startTime > currentTime` go on `timerQueue`; others go to `taskQueue` (lines 385-413).

Min-heap sort key differs per queue:
- Delayed (`timerQueue`): `sortIndex = startTime` (line 387).
- Active (`taskQueue`): `sortIndex = expirationTime` (line 401).

**This is how priority becomes ordering**: higher-priority tasks have shorter timeouts → smaller `expirationTime` → they sit at the top of the heap.

## 4. Semantics of `expirationTime`

`expirationTime = startTime + timeout` is the load-bearing expression of the whole priority system.

1. **Non-immediate priorities**: `expirationTime` is the time after which the task is "overdue." Until that point, workLoop may yield to host (via `shouldYieldToHost()`); after that, workLoop will NOT yield. See `workLoop` line 194:

   ```js
   if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
     break;
   }
   ```

   And line 207:

   ```js
   const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
   ...
   const continuationCallback = callback(didUserCallbackTimeout);
   ```

   The callback is told whether it's been "starved."

2. **`ImmediatePriority`**: `timeout === -1`, so `expirationTime = startTime - 1`. The yield-check `currentTask.expirationTime > currentTime` is false from the first iteration — never yields. `didUserCallbackTimeout` is also true on first call. Effectively hogs the workLoop until `null` returned.

3. **`IdlePriority`**: ~12.43 days out, so yield-check almost always wins. Idle tasks run only when nothing else has work — but they *will* eventually expire if they sit ~12 days. Upper bound on starvation.

4. **Heap ordering = urgency**: smaller `expirationTime` → closer to heap root → runs sooner. Priority system is "subtract a smaller or larger number from a deadline" — there's no separate priority field used for ordering.

## 5. `currentPriorityLevel` and the priority-context API

Module-level variable (`Scheduler.js:86`):
```js
var currentPriorityLevel: PriorityLevel = NormalPriority;
```

Read/written by:
- `unstable_getCurrentPriorityLevel()` (lines 433-435) — returns it.
- `workLoop` (line 205) — sets it to the popped task's priority before invoking the callback.
- `flushWork` (lines 158, 179) — saves and restores it.

### `unstable_runWithPriority(priorityLevel, eventHandler)` — lines 260-283

```js
function unstable_runWithPriority<T>(
  priorityLevel: PriorityLevel,
  eventHandler: () => T,
): T {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}
```

Save/swap/restore with input validation — any non-valid priority coerced to `NormalPriority`.

### `unstable_next(eventHandler)` — lines 285-308

```js
function unstable_next<T>(eventHandler: () => T): T {
  var priorityLevel: PriorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      priorityLevel = NormalPriority;  // Cap at Normal
      break;
    default:
      priorityLevel = currentPriorityLevel;  // Low/Idle pass through
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}
```

"Demote to Normal, but never promote" helper.

### `unstable_wrapCallback(callback)` — lines 310-325

```js
function unstable_wrapCallback<T: (...Array<mixed>) => mixed>(callback: T): T {
  var parentPriorityLevel = currentPriorityLevel;
  return function () {
    var previousPriorityLevel = currentPriorityLevel;
    currentPriorityLevel = parentPriorityLevel;
    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
    }
  };
}
```

Captures priority at wrap-time into closure; later invocations temporarily restore it. Comment: "This is a fork of runWithPriority, inlined for performance."

## 6. `maxSigned31BitInt = 1073741823` — how many days?

`1073741823 = 2^30 - 1`. The comment says `Math.pow(2, 30) - 1`. It is NOT `2^31 - 1`. The "31 bit" in the name refers to V8 SMI tag layout on 32-bit systems (one bit for tag, leaving 31, of which one is the sign).

Day calculation:
```
1,073,741,823 ms / (1000 * 60 * 60 * 24)
= 1,073,741,823 / 86,400,000
≈ 12.4259 days
```

**The idle priority "never times out" sentinel is actually ~12.43 days, NOT ~24.86 days.** Anyone quoting 24.86 days is implicitly using `2^31 - 1 = 2,147,483,647`, which is wrong — the actual constant is `2^30 - 1`.

## 7. React reconciler call sites for `unstable_scheduleCallback`

The reconciler imports the scheduler through a wrapper at `packages/react-reconciler/src/Scheduler.js`. Call sites use `*SchedulerPriority` aliases.

| File | Line | Priority | Purpose |
|---|---|---|---|
| `ReactFiberRootScheduler.js` | 487 | `UserBlockingSchedulerPriority` | `DiscreteEventPriority`/`ContinuousEventPriority` — user input |
| `ReactFiberRootScheduler.js` | 490 | `NormalSchedulerPriority` | `DefaultEventPriority` — standard render |
| `ReactFiberRootScheduler.js` | 493 | `IdleSchedulerPriority` | `IdleEventPriority` — idle-lane work |
| `ReactFiberRootScheduler.js` | 496 | `NormalSchedulerPriority` | Default fallback |
| `ReactFiberRootScheduler.js` | 500-503 | (chosen above) | Main `scheduleCallback(priority, performWorkOnRootViaSchedulerTask)` |
| `ReactFiberRootScheduler.js` | 680-683 | `ImmediateSchedulerPriority` | Safari workaround (microtask in Render/Commit) |
| `ReactFiberRootScheduler.js` | 690-693 | `ImmediateSchedulerPriority` | Fallback when `supportsMicrotasks` false |
| `ReactFiberWorkLoop.js` | 3784 | `NormalSchedulerPriority` | `flushPassiveEffects` (legacy path) |
| `ReactFiberWorkLoop.js` | 4401 | `IdleSchedulerPriority` | `schedulePostPaintCallback` — `processTransitionCallbacks` |
| `ReactFiberWorkLoop.js` | 4808 | `IdleSchedulerPriority` | Second copy of transition callbacks |
| `ReactFiberCacheComponent.js` | 114 | `NormalPriority` | `cache.controller.abort()` on refCount=0 |

### Priorities NOT used in production reconciler
- **`LowPriority`** — re-exported but no reconciler call site uses it. Only tests reference it.
- **`NoPriority`** — purely internal; never passed to `scheduleCallback`.

### Sync work bypasses Scheduler

Comment in `ReactFiberRootScheduler.js:482-484`:
> "Scheduler does have an 'ImmediatePriority', but now that we use microtasks for sync work we no longer use that. Any sync work that reaches this path is meant to be time sliced."

Sync work goes through `performSyncWorkOnRoot` directly without touching the Scheduler. The only remaining uses of `ImmediateSchedulerPriority` are the two non-microtask fallbacks.

### Effective mapping in practice

| Scheduler priority | Used? | What triggers |
|---|---|---|
| `ImmediatePriority` | Rarely | Only microtask-unavailable fallback |
| `UserBlockingPriority` | Very common | User input (discrete/continuous events) |
| `NormalPriority` | Very common | Default render; passive-effect flush; cache abort |
| `LowPriority` | **No** | (Exported but unused) |
| `IdlePriority` | Yes | Idle lanes; post-paint transition callbacks |

## 8. Three things to flag

1. **`IDLE_PRIORITY_TIMEOUT` is 12.43 days, not 24.86 days.** The code uses `2^30 - 1 = 1,073,741,823` ms.
2. **The screaming-snake-case constants only exist in `SchedulerMock.js` today.** Production uses lowercase `userBlockingPriorityTimeout` etc. from `SchedulerFeatureFlags.js`, with `-1` and `maxSigned31BitInt` inlined.
3. **`LowPriority` is dead in the production reconciler.** Defined, re-exported, has its own switch arm — but no production reconciler code path passes it.
