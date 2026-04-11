# 02 — SchedulerMinHeap and Its Usage

**Files explored:**
- `/home/john/kanban/data/repos/react/packages/scheduler/src/SchedulerMinHeap.js`
- `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/Scheduler.js`
- `/home/john/kanban/data/repos/react/packages/scheduler/src/forks/SchedulerMock.js`

The min-heap module is imported in exactly two places — both forks of the scheduler:

```
data/repos/react/packages/scheduler/src/forks/Scheduler.js:24:    import {push, pop, peek} from '../SchedulerMinHeap';
data/repos/react/packages/scheduler/src/forks/SchedulerMock.js:16:  import {push, pop, peek} from '../SchedulerMinHeap';
```

No other file in `packages/scheduler/` imports the heap.

---

## 1. Full API: `push`, `pop`, `peek`

`SchedulerMinHeap.js` is a tiny, self-contained binary heap stored as a flat `Array<T>`. The Flow type for elements is just:

```js
// SchedulerMinHeap.js:10-15
type Heap<T: Node> = Array<T>;
type Node = {
  id: number,
  sortIndex: number,
  ...
};
```

The heap is **min-ordered by `compare`** (smaller `sortIndex` first, then smaller `id`). Index `0` is always the minimum.

### `push` — append + sift up — `SchedulerMinHeap.js:17-21`

```js
export function push<T: Node>(heap: Heap<T>, node: T): void {
  const index = heap.length;
  heap.push(node);
  siftUp(heap, node, index);
}
```

The new node is appended to the end of the backing array, then bubbled up toward the root.

### `peek` — read root — `SchedulerMinHeap.js:23-25`

```js
export function peek<T: Node>(heap: Heap<T>): T | null {
  return heap.length === 0 ? null : heap[0];
}
```

Returns `null` for an empty heap. Pure constant-time array index lookup. Does not mutate.

### `pop` — extract minimum — `SchedulerMinHeap.js:27-40`

```js
export function pop<T: Node>(heap: Heap<T>): T | null {
  if (heap.length === 0) {
    return null;
  }
  const first = heap[0];
  const last = heap.pop();
  if (last !== first) {
    heap[0] = last;
    siftDown(heap, last, 0);
  }
  return first;
}
```

Notes:
- Saves the root (`first`), uses native `Array.pop()` to remove the **last** element.
- If the heap had only one element, `last === first` and we just return — no sift-down needed.
- Otherwise the last element is moved to index `0` and sifted down.

### `siftUp` — `SchedulerMinHeap.js:42-57`

```js
function siftUp<T: Node>(heap: Heap<T>, node: T, i: number): void {
  let index = i;
  while (index > 0) {
    const parentIndex = (index - 1) >>> 1;
    const parent = heap[parentIndex];
    if (compare(parent, node) > 0) {
      heap[parentIndex] = node;
      heap[index] = parent;
      index = parentIndex;
    } else {
      return;
    }
  }
}
```

Standard parent index `(i - 1) >>> 1` (unsigned shift, faster than `Math.floor((i-1)/2)`).

### `siftDown` — `SchedulerMinHeap.js:59-89`

```js
function siftDown<T: Node>(heap: Heap<T>, node: T, i: number): void {
  let index = i;
  const length = heap.length;
  const halfLength = length >>> 1;
  while (index < halfLength) {
    const leftIndex = (index + 1) * 2 - 1;
    const left = heap[leftIndex];
    const rightIndex = leftIndex + 1;
    const right = heap[rightIndex];

    if (compare(left, node) < 0) {
      if (rightIndex < length && compare(right, left) < 0) {
        heap[index] = right;
        heap[rightIndex] = node;
        index = rightIndex;
      } else {
        heap[index] = left;
        heap[leftIndex] = node;
        index = leftIndex;
      }
    } else if (rightIndex < length && compare(right, node) < 0) {
      heap[index] = right;
      heap[rightIndex] = node;
      index = rightIndex;
    } else {
      return;
    }
  }
}
```

Subtleties:
- The loop condition `index < halfLength` is the standard "do I have at least one child?" check.
- `leftIndex = (index + 1) * 2 - 1` is just `2 * index + 1` rewritten.
- The `compare(right, left) < 0` tiebreaker is **strict** — when the children compare equal, the algorithm prefers the **left** child.

---

## 2. The `compare` function — `SchedulerMinHeap.js:91-95`

```js
function compare(a: Node, b: Node) {
  const diff = a.sortIndex - b.sortIndex;
  return diff !== 0 ? diff : a.id - b.id;
}
```

**Why two-level compare:**
- `sortIndex` is the **primary ordering key** and changes meaning depending on which queue the task is in.
- `id` is a monotonically increasing counter assigned at task creation (`taskIdCounter` at `Scheduler.js:83` — starts at `1`, post-incremented in `id: taskIdCounter++` at `Scheduler.js:374`). Older tasks have smaller ids, so when two tasks share the same `sortIndex`, the older one wins — this is the FIFO tiebreaker.

---

## 3. How `taskQueue` and `timerQueue` use the heap

Both queues are declared as plain arrays in `Scheduler.js:78-80`:

```js
var taskQueue: Array<Task> = [];
var timerQueue: Array<Task> = [];
```

They share the same heap implementation but **store different things in `sortIndex`**:

| Queue | Contains | `sortIndex` is | Meaning of root |
| --- | --- | --- | --- |
| `taskQueue` | Ready tasks (startTime already passed) | `expirationTime` | Most urgent / closest to deadline |
| `timerQueue` | Delayed tasks | `startTime` | Next task to become ready |

The `Task` type carries both timestamps so a task can transition from one queue to the other:

```js
// Scheduler.js:49-57
export opaque type Task = {
  id: number,
  callback: Callback | null,
  priorityLevel: PriorityLevel,
  startTime: number,
  expirationTime: number,
  sortIndex: number,
  isQueued?: boolean,
};
```

### How a task ends up in each queue — `Scheduler.js:373-413`

```js
var newTask: Task = {
  id: taskIdCounter++,
  callback,
  priorityLevel,
  startTime,
  expirationTime,
  sortIndex: -1,
};

if (startTime > currentTime) {
  // Delayed task.
  newTask.sortIndex = startTime;
  push(timerQueue, newTask);
  if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
    if (isHostTimeoutScheduled) {
      cancelHostTimeout();
    } else {
      isHostTimeoutScheduled = true;
    }
    requestHostTimeout(handleTimeout, startTime - currentTime);
  }
} else {
  newTask.sortIndex = expirationTime;
  push(taskQueue, newTask);
  ...
}
```

The `peek(taskQueue) === null && newTask === peek(timerQueue)` check is a clever heap idiom: "is this newly inserted timer now the earliest pending one?" using only `peek`.

### How a delayed task migrates — `advanceTimers` — `Scheduler.js:103-125`

```js
function advanceTimers(currentTime: number) {
  let timer = peek(timerQueue);
  while (timer !== null) {
    if (timer.callback === null) {
      // Timer was cancelled.
      pop(timerQueue);
    } else if (timer.startTime <= currentTime) {
      // Timer fired. Transfer to the task queue.
      pop(timerQueue);
      timer.sortIndex = timer.expirationTime;
      push(taskQueue, timer);
      ...
    } else {
      return;
    }
    timer = peek(timerQueue);
  }
}
```

`timer.sortIndex = timer.expirationTime` happens **after** `pop` removes the timer — the heap invariant of `timerQueue` is never violated because the mutation happens to a node that's no longer in any heap.

---

## 4. All call sites of `push`, `pop`, `peek`

| Line | Call | Purpose |
| --- | --- | --- |
| `Scheduler.js:105` | `peek(timerQueue)` | `advanceTimers` head |
| `Scheduler.js:109` | `pop(timerQueue)` | Drop a cancelled timer (lazy cleanup) |
| `Scheduler.js:112` | `pop(timerQueue)` | Remove fired timer to promote |
| `Scheduler.js:114` | `push(taskQueue, timer)` | Promote fired timer |
| `Scheduler.js:123` | `peek(timerQueue)` | Re-peek for next iteration |
| `Scheduler.js:132` | `peek(taskQueue)` | `handleTimeout` |
| `Scheduler.js:136` | `peek(timerQueue)` | `handleTimeout` next-timer |
| `Scheduler.js:191` | `peek(taskQueue)` | `workLoop` — get most urgent task |
| `Scheduler.js:232` | `peek(taskQueue)` | `workLoop` — confirm current is still root |
| `Scheduler.js:233` | `pop(taskQueue)` | `workLoop` — remove completed task |
| `Scheduler.js:238` | `pop(taskQueue)` | `workLoop` — drop cancelled task |
| `Scheduler.js:240` | `peek(taskQueue)` | `workLoop` — next iteration |
| `Scheduler.js:252` | `peek(timerQueue)` | `workLoop` — schedule host timeout |
| `Scheduler.js:388` | `push(timerQueue, newTask)` | `unstable_scheduleCallback` — delayed |
| `Scheduler.js:389` | `peek(taskQueue)` / `peek(timerQueue)` | "Is this the earliest?" check |
| `Scheduler.js:402` | `push(taskQueue, newTask)` | `unstable_scheduleCallback` — immediate |

**The heap is never iterated.** Every interaction is `push`/`peek`/`pop`. The "confirm root, then pop" pattern at lines 232-234 is the only safe way to remove a known node — and relies on the node still being the minimum.

---

## 5. Lazy cancellation

`unstable_cancelCallback` — `Scheduler.js:418-431`:

```js
function unstable_cancelCallback(task: Task) {
  if (enableProfiling) {
    if (task.isQueued) {
      const currentTime = getCurrentTime();
      markTaskCanceled(task, currentTime);
      task.isQueued = false;
    }
  }
  // Null out the callback to indicate the task has been canceled. (Can't
  // remove from the queue because you can't remove arbitrary nodes from an
  // array based heap, only the first one.)
  task.callback = null;
}
```

The heap API only supports `pop` of the **root**. There is no `removeAt(i)` because that would require knowing the node's index and a re-heapify. So cancellation is a tombstone: set `task.callback = null` and leave the corpse.

### Cleanup in `workLoop` for `taskQueue` — `Scheduler.js:200-239`

```js
const callback = currentTask.callback;
if (typeof callback === 'function') {
  ...                                  // run the callback
} else {
  pop(taskQueue);                      // <-- Scheduler.js:238
}
currentTask = peek(taskQueue);
```

### Cleanup in `advanceTimers` for `timerQueue` — `Scheduler.js:103-125`

```js
let timer = peek(timerQueue);
while (timer !== null) {
  if (timer.callback === null) {
    pop(timerQueue);                   // <-- Scheduler.js:109
  } ...
}
```

### Why this is correct

1. **Heap invariant preserved.** Setting `callback = null` does not change `sortIndex` or `id`.
2. **Tombstones can starve only the root.** A cancelled node at the root is dropped immediately; deeper ones wait until they bubble up.
3. **Guarded pop on completion.** Before the "finished task" pop, workLoop does `if (currentTask === peek(taskQueue)) pop(taskQueue)`. The guard exists because the user callback may have scheduled an even more urgent task, in which case `currentTask` is no longer at the root. Leaving it (with `callback = null`) is fine — lazy cleanup will catch it.
4. **O(1) cancellation.** The cost is amortized into the next consumer.
5. **Memory pressure tradeoff.** Pathological "schedule then cancel" without draining can grow either heap unboundedly. Not an issue in practice.

---

## 6. Time complexity

| Operation | Time |
| --- | --- |
| `peek` | O(1) |
| `push` | O(log n) |
| `pop` | O(log n) |
| `unstable_cancelCallback` | O(1) |
| `advanceTimers` reaping k timers | O(k log n) |
| `unstable_scheduleCallback` | O(log n) |

The key practical property: the hot-path `peek` is O(1), so `workLoop` can cheaply check "is there work?" without disturbing the heap.

---

## 7. Tiebreaker behavior — same `sortIndex`

```js
// Scheduler.js:82-83
var taskIdCounter = 1;

// Scheduler.js:374
id: taskIdCounter++,
```

Every newly scheduled task gets a strictly larger id than every existing task. So among tasks with equal `sortIndex`, the one inserted first has the smaller id and compares less — **FIFO ordering among ties**.

Finer points:
- **"FIFO-ish"** across different priorities: higher-priority tasks have shorter timeouts → smaller `expirationTime` → they win regardless of insertion order. Id tiebreaker only kicks in when `sortIndex` is literally equal.
- **FIFO preserved across queues.** A timer that became ready at `t` and was created before another non-delayed task at the same time will have a smaller id.
- **Determinism.** Without the id tiebreaker, `siftUp`/`siftDown` behavior would be nondeterministic for equal-sortIndex nodes.

---

## Bonus: Why two queues

Splitting tasks into `timerQueue` (sorted by `startTime`) and `taskQueue` (sorted by `expirationTime`) lets the scheduler answer the two questions it actually cares about, each in O(1) via `peek`:

1. *"What's the most urgent thing I should run right now?"* → `peek(taskQueue)`.
2. *"How long until something currently delayed becomes ready?"* → `peek(timerQueue).startTime - currentTime`.

The `Task` object is the same shape in both queues — only `sortIndex` is rewritten when a task migrates.
