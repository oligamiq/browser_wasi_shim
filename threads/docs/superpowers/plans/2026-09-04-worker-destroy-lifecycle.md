# Worker Destroy Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the worker teardown protocol with one atomic lifecycle that rejects new work, settles in-flight operations, terminates every owned Worker exactly once, supports observable asynchronous completion, and makes `kill_animal()` terminate only its selected Animal.

**Architecture:** A new `worker_lifecycle.ts` module owns the packed lifecycle control word, requester-last handshake, terminal waits, and typed teardown failures. Spawn requests use allocator-backed status blocks so the coordinator releases the global command lock before child readiness; the coordinator races command activity against the out-of-band lifecycle signal and performs all registry cleanup from one teardown path.

**Tech Stack:** TypeScript 5.9, SharedArrayBuffer, Atomics, browser Web Workers, Node worker wrappers, Bun tests, SWC/spack worker generation, Biome.

## Global Constraints

- Preserve `WASIFarm.destroy()` as Park-only teardown.
- Preserve `WASIFarmAnimal.destroy()` and `DestroyerHandle.destroy()` as synchronous runtime-wide teardown initiation.
- Name the new asynchronous API `async_destroy()` to match `async_start_on_thread()`.
- Use `CONTROL` bits 0-1 for lifecycle and bits 2-31 for requester code.
- Encode external requester as `0` and managed `animal_id` as `animal_id + 1`.
- Restrict generated Animal IDs to `0..2^30-2` without reusing a live or pending ID.
- Never hold the worker-background command lock while waiting for Worker load, `ready`, WebAssembly instantiation, or teardown.
- Use the existing allocator for request status blocks; do not introduce a fixed-size request table.
- Keep Park and BaseCall state machines unchanged.
- Use event/state-based waits. The only internal deadline is the specified 1,000 ms managed-requester close fallback.
- Treat `worker.ts` as source and regenerate `worker_blob.ts` and `worker_background_worker_minify.js`; do not edit generated files manually.
- Every task that changes `worker.ts` runs `npm run worker` before real-Worker tests and stages both generated source files in the same commit.
- Preserve unrelated worktree changes and stage only files named by the active task.

---

### Task 1: Add the Atomic Worker Lifecycle Primitive

**Files:**
- Create: `src/shared_array_buffer/worker_lifecycle.ts`
- Create: `src/shared_array_buffer/worker_lifecycle.test.ts`

**Interfaces:**
- Consumes: `SharedArrayBuffer`, `Atomics.waitAsync()`.
- Produces: `DESTROY_STATUS_BYTES`, `WorkerLifecycle`, `RequesterStatus`, `WorkerDestroyFailureCode`, `WorkerDestroyError`, `createDestroyStatus()`, `beginDestroy()`, `readLifecycle()`, `readRequesterAnimalId()`, `wakeDestroyWaiters()`, `markDestroyed()`, `markDestroyFailed()`, `waitForDestroyTerminal()`, `waitForRequesterDrained()`, and `markRequesterClosing()`.

- [ ] **Step 1: Write the failing packing and election tests**

Create `src/shared_array_buffer/worker_lifecycle.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  beginDestroy,
  createDestroyStatus,
  DESTROY_REQUESTER_STATUS,
  markDestroyed,
  markDestroyFailed,
  markRequesterClosing,
  readLifecycle,
  readRequesterAnimalId,
  RequesterStatus,
  wakeDestroyWaiters,
  waitForDestroyTerminal,
  waitForRequesterDrained,
  WorkerDestroyError,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "./worker_lifecycle.ts";

describe("worker destroy control", () => {
  test("publishes lifecycle and managed requester in one election", () => {
    const status = createDestroyStatus();
    const view = new Int32Array(status);

    expect(beginDestroy(view, 41)).toBe(true);
    expect(readLifecycle(view)).toBe(WorkerLifecycle.Destroying);
    expect(readRequesterAnimalId(view)).toBe(41);
  });

  test("allows only one destroy winner", () => {
    const view = new Int32Array(createDestroyStatus());

    expect(beginDestroy(view, 7)).toBe(true);
    expect(beginDestroy(view, 8)).toBe(false);
    expect(readRequesterAnimalId(view)).toBe(7);
  });

  test("uses an unbound requester code for controller destroy", () => {
    const view = new Int32Array(createDestroyStatus());

    expect(beginDestroy(view)).toBe(true);
    expect(readRequesterAnimalId(view)).toBeUndefined();
  });

  test("rejects an animal id that cannot fit in CONTROL", () => {
    const view = new Int32Array(createDestroyStatus());

    expect(() => beginDestroy(view, 2 ** 30 - 1)).toThrow(RangeError);
  });

  test("settles all terminal waiters", async () => {
    const view = new Int32Array(createDestroyStatus());
    beginDestroy(view);
    const first = waitForDestroyTerminal(view);
    const second = waitForDestroyTerminal(view);
    markDestroyed(view);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  test("reports a stable terminal failure", async () => {
    const view = new Int32Array(createDestroyStatus());
    beginDestroy(view);
    const completion = waitForDestroyTerminal(view);
    markDestroyFailed(view, WorkerDestroyFailureCode.CoordinatorRuntime);
    await expect(completion).rejects.toBeInstanceOf(WorkerDestroyError);
  });

  test("coordinates requester drained and closing states", async () => {
    const view = new Int32Array(createDestroyStatus());
    beginDestroy(view, 4);
    const drained = waitForRequesterDrained(view);
    Atomics.store(
      view,
      DESTROY_REQUESTER_STATUS,
      RequesterStatus.RequesterDrained,
    );
    wakeDestroyWaiters(view);
    await drained;
    markRequesterClosing(view);
    expect(Atomics.load(view, DESTROY_REQUESTER_STATUS)).toBe(
      RequesterStatus.Closing,
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test src/shared_array_buffer/worker_lifecycle.test.ts`

Expected: FAIL because `./worker_lifecycle.ts` does not exist.

- [ ] **Step 3: Implement the lifecycle module**

Create `src/shared_array_buffer/worker_lifecycle.ts`:

```ts
export const DESTROY_STATUS_BYTES = 16;
export const DESTROY_CONTROL = 0;
export const DESTROY_REQUESTER_STATUS = 1;
export const DESTROY_FAILURE_CODE = 2;
export const DESTROY_WAKE_EPOCH = 3;

const LIFECYCLE_MASK = 0b11;
const REQUESTER_SHIFT = 2;
const MAX_ANIMAL_ID = 2 ** 30 - 2;

export enum WorkerLifecycle {
  Running = 0,
  Destroying = 1,
  Destroyed = 2,
  Failed = 3,
}

export enum RequesterStatus {
  None = 0,
  RequesterDrained = 1,
  Closing = 2,
}

export enum WorkerDestroyFailureCode {
  None = 0,
  CoordinatorBootstrap = 1,
  CoordinatorRuntime = 2,
  WorkerBootstrap = 3,
  Protocol = 4,
}

export class WorkerDestroyError extends Error {
  constructor(readonly code: WorkerDestroyFailureCode) {
    super(`worker destroy failed: ${WorkerDestroyFailureCode[code]}`);
    this.name = "WorkerDestroyError";
  }
}

export function createDestroyStatus(): SharedArrayBuffer {
  return new SharedArrayBuffer(DESTROY_STATUS_BYTES);
}

function requesterCode(animalId?: number): number {
  if (animalId === undefined) return 0;
  if (!Number.isInteger(animalId) || animalId < 0 || animalId > MAX_ANIMAL_ID) {
    throw new RangeError(`animal_id must be in 0..${MAX_ANIMAL_ID}`);
  }
  return animalId + 1;
}

function encodeControl(lifecycle: WorkerLifecycle, animalId?: number): number {
  return (requesterCode(animalId) << REQUESTER_SHIFT) | lifecycle;
}

export function readLifecycle(view: Int32Array): WorkerLifecycle {
  return Atomics.load(view, DESTROY_CONTROL) & LIFECYCLE_MASK;
}

export function readRequesterAnimalId(view: Int32Array): number | undefined {
  const code = Atomics.load(view, DESTROY_CONTROL) >>> REQUESTER_SHIFT;
  return code === 0 ? undefined : code - 1;
}

export function beginDestroy(view: Int32Array, animalId?: number): boolean {
  const control = encodeControl(WorkerLifecycle.Destroying, animalId);
  const won =
    Atomics.compareExchange(
      view,
      DESTROY_CONTROL,
      WorkerLifecycle.Running,
      control,
    ) === WorkerLifecycle.Running;
  if (won) wakeDestroyWaiters(view);
  return won;
}

export function wakeDestroyWaiters(view: Int32Array): void {
  Atomics.add(view, DESTROY_WAKE_EPOCH, 1);
  Atomics.notify(view, DESTROY_WAKE_EPOCH);
}

function finishDestroy(view: Int32Array, next: WorkerLifecycle): void {
  for (;;) {
    const control = Atomics.load(view, DESTROY_CONTROL);
    const lifecycle = control & LIFECYCLE_MASK;
    if (lifecycle === next) return;
    if (lifecycle !== WorkerLifecycle.Destroying) {
      throw new WorkerDestroyError(WorkerDestroyFailureCode.Protocol);
    }
    const replacement = (control & ~LIFECYCLE_MASK) | next;
    if (
      Atomics.compareExchange(view, DESTROY_CONTROL, control, replacement) ===
      control
    ) {
      wakeDestroyWaiters(view);
      return;
    }
  }
}

export function markDestroyed(view: Int32Array): void {
  finishDestroy(view, WorkerLifecycle.Destroyed);
}

export function markDestroyFailed(
  view: Int32Array,
  code: WorkerDestroyFailureCode,
): void {
  const lifecycle = readLifecycle(view);
  if (
    lifecycle === WorkerLifecycle.Destroyed ||
    lifecycle === WorkerLifecycle.Failed
  ) {
    return;
  }
  Atomics.compareExchange(
    view,
    DESTROY_FAILURE_CODE,
    WorkerDestroyFailureCode.None,
    code,
  );
  finishDestroy(view, WorkerLifecycle.Failed);
}

async function waitForWake(view: Int32Array, expectedEpoch: number): Promise<void> {
  const { value } = Atomics.waitAsync(
    view,
    DESTROY_WAKE_EPOCH,
    expectedEpoch,
  );
  const result = value instanceof Promise ? await value : value;
  if (result === "timed-out") throw new Error("atomic wait timed out");
}

export async function waitForDestroyTerminal(view: Int32Array): Promise<void> {
  for (;;) {
    const lifecycle = readLifecycle(view);
    if (lifecycle === WorkerLifecycle.Destroyed) return;
    if (lifecycle === WorkerLifecycle.Failed) {
      throw new WorkerDestroyError(
        Atomics.load(view, DESTROY_FAILURE_CODE) as WorkerDestroyFailureCode,
      );
    }
    const epoch = Atomics.load(view, DESTROY_WAKE_EPOCH);
    if (readLifecycle(view) === lifecycle) await waitForWake(view, epoch);
  }
}

export async function waitForRequesterDrained(view: Int32Array): Promise<void> {
  while (Atomics.load(view, DESTROY_REQUESTER_STATUS) === RequesterStatus.None) {
    const lifecycle = readLifecycle(view);
    if (lifecycle === WorkerLifecycle.Failed) {
      throw new WorkerDestroyError(
        Atomics.load(view, DESTROY_FAILURE_CODE) as WorkerDestroyFailureCode,
      );
    }
    if (lifecycle === WorkerLifecycle.Destroyed) return;
    const epoch = Atomics.load(view, DESTROY_WAKE_EPOCH);
    if (
      Atomics.load(view, DESTROY_REQUESTER_STATUS) === RequesterStatus.None &&
      readLifecycle(view) === lifecycle
    ) {
      await waitForWake(view, epoch);
    }
  }
}

export function markRequesterClosing(view: Int32Array): void {
  Atomics.store(
    view,
    DESTROY_REQUESTER_STATUS,
    RequesterStatus.Closing,
  );
  Atomics.notify(view, DESTROY_REQUESTER_STATUS);
  wakeDestroyWaiters(view);
}
```

- [ ] **Step 4: Confirm the implementation satisfies the prewritten terminal tests**

The tests written before implementation in Step 1 include the following
terminal-wait assertion. Do not add a new behavior at this step; use this code
only to confirm the implementation matches the expected contract:

```ts
test("settles all terminal waiters", async () => {
  const view = new Int32Array(createDestroyStatus());
  beginDestroy(view);
  const first = waitForDestroyTerminal(view);
  const second = waitForDestroyTerminal(view);
  markDestroyed(view);
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
});

test("reports a stable terminal failure", async () => {
  const view = new Int32Array(createDestroyStatus());
  beginDestroy(view);
  const completion = waitForDestroyTerminal(view);
  markDestroyFailed(view, WorkerDestroyFailureCode.CoordinatorRuntime);

  await expect(completion).rejects.toBeInstanceOf(WorkerDestroyError);
});

test("coordinates requester drained and closing states", async () => {
  const view = new Int32Array(createDestroyStatus());
  beginDestroy(view, 4);
  const drained = waitForRequesterDrained(view);
  Atomics.store(
    view,
    DESTROY_REQUESTER_STATUS,
    RequesterStatus.RequesterDrained,
  );
  wakeDestroyWaiters(view);

  await drained;
  markRequesterClosing(view);
  expect(Atomics.load(view, DESTROY_REQUESTER_STATUS)).toBe(
    RequesterStatus.Closing,
  );
});
```

- [ ] **Step 5: Run tests and commit**

After the test command succeeds, commit only Task 1 files:

```bash
git status --short
git diff -- src/shared_array_buffer/worker_lifecycle.ts src/shared_array_buffer/worker_lifecycle.test.ts
git add src/shared_array_buffer/worker_lifecycle.ts src/shared_array_buffer/worker_lifecycle.test.ts
git commit -m "feat(threads): add worker destroy lifecycle"
```

Run: `bun test src/shared_array_buffer/worker_lifecycle.test.ts`

Expected: PASS with all lifecycle tests passing.

Run:

```bash
git status --short
```

---

### Task 2: Carry Lifecycle State Through the Worker Protocol

**Files:**
- Create: `src/shared_array_buffer/worker_background/worker_export.test.ts`
- Modify: `src/shared_array_buffer/worker_background/worker_export.ts:6-26`
- Modify: `src/shared_array_buffer/worker_background/worker_background_ref.ts:15-57`
- Modify: `src/shared_array_buffer/thread_spawn.ts:31-159`
- Modify: `src/shared_array_buffer/worker_background/worker.ts:14-78`
- Generated: `src/shared_array_buffer/worker_background/worker_blob.ts`
- Generated: `src/shared_array_buffer/worker_background/worker_background_worker_minify.js`

**Interfaces:**
- Consumes: `createDestroyStatus()` and the existing `WorkerBackgroundRefObject` clone protocol.
- Produces: `WorkerBackgroundRefObject.destroy_status` and `WorkerBackgroundRef.get_object()`; the same buffer is held by `ThreadSpawner`, `WorkerBackgroundRef`, and `WorkerBackground`.

- [ ] **Step 1: Write the failing protocol-object test**

Create `src/shared_array_buffer/worker_background/worker_export.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createDestroyStatus } from "../worker_lifecycle.ts";
import { WorkerBackgroundRefObjectConstructor } from "./worker_export.ts";

test("shares destroy lifecycle with the coordinator reference", () => {
  const destroyStatus = createDestroyStatus();
  const object = WorkerBackgroundRefObjectConstructor(destroyStatus);

  expect(object.destroy_status).toBe(destroyStatus);
  expect(object.signature_input.byteLength).toBe(32);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test src/shared_array_buffer/worker_background/worker_export.test.ts`

Expected: FAIL because the constructor does not accept or return
`destroy_status` and `signature_input` is currently 24 bytes.

- [ ] **Step 3: Extend the cloneable protocol object**

Change `worker_export.ts` to:

```ts
export type WorkerBackgroundRefObject = {
  allocator: AllocatorUseArrayBufferObject;
  lock: SharedArrayBuffer;
  signature_input: SharedArrayBuffer;
  destroy_status: SharedArrayBuffer;
};

export const WorkerBackgroundRefObjectConstructor = (
  destroyStatus: SharedArrayBuffer,
): WorkerBackgroundRefObject => ({
  allocator: {
    share_arrays_memory: new SharedArrayBuffer(10 * 1024),
  },
  lock: new SharedArrayBuffer(24),
  signature_input: new SharedArrayBuffer(32),
  destroy_status: destroyStatus,
});
```

The two added signature words are fixed as:

```ts
export const SIGNATURE_REQUEST_STATUS_PTR = 6;
export const SIGNATURE_REQUEST_STATUS_LEN = 7;
```

- [ ] **Step 4: Thread the buffer through every reconstruction path**

In `ThreadSpawner`, initialize `this.destroy_status` before creating the
background reference object:

```ts
this.destroy_status =
  worker_background_ref_object?.destroy_status ??
  destroy_status ??
  createDestroyStatus();
this.worker_background_ref_object =
  worker_background_ref_object ??
  WorkerBackgroundRefObjectConstructor(this.destroy_status);
this.worker_background_ref = WorkerBackgroundRef.init_self(
  this.worker_background_ref_object,
);
```

In `WorkerBackgroundRef`, retain the shared control block:

```ts
private destroy_status: SharedArrayBuffer;

constructor(
  allocator: AllocatorUseArrayBuffer,
  lock: SharedArrayBuffer,
  signature_input: SharedArrayBuffer,
  destroy_status: SharedArrayBuffer,
) {
  this.allocator = allocator;
  this.lock = lock;
  this.signature_input = signature_input;
  this.destroy_status = destroy_status;
}
```

Update `WorkerBackgroundRef.init_self()` to pass
`sl.destroy_status`. Update `WorkerBackground.ref()` and `init_self()` so the
coordinator receives the same buffer directly from
`WorkerBackgroundRefObject`, rather than reaching through generic
`override_object.sl_object`.

Add the inverse serialization method used by transferable destroy handles:

```ts
get_object(): WorkerBackgroundRefObject {
  return {
    allocator: this.allocator.get_object(),
    lock: this.lock,
    signature_input: this.signature_input,
    destroy_status: this.destroy_status,
  };
}
```

- [ ] **Step 5: Verify clone behavior and type checking**

Run:

```bash
npm run worker
bun test src/shared_array_buffer/worker_background/worker_export.test.ts
npx tsc --noEmit
```

Expected: the focused test passes and TypeScript reports no errors.

- [ ] **Step 6: Commit the protocol change**

```bash
git status --short
git diff -- src/shared_array_buffer/worker_background/worker_export.ts src/shared_array_buffer/worker_background/worker_export.test.ts src/shared_array_buffer/worker_background/worker_background_ref.ts src/shared_array_buffer/thread_spawn.ts src/shared_array_buffer/worker_background/worker.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
git add src/shared_array_buffer/worker_background/worker_export.ts src/shared_array_buffer/worker_background/worker_export.test.ts src/shared_array_buffer/worker_background/worker_background_ref.ts src/shared_array_buffer/thread_spawn.ts src/shared_array_buffer/worker_background/worker.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
git commit -m "refactor(threads): share worker lifecycle control"
```

Run:

```bash
git status --short
```

---

### Task 3: Replace DestroyerHandle's Broken Listener

**Files:**
- Create: `src/destroyer_handle.test.ts`
- Modify: `src/destroyer_handle.ts:6-95`
- Modify: `src/index.ts:11-22`
- Modify: `src/shared_array_buffer/worker_background/worker_background_ref.ts`

**Interfaces:**
- Consumes: lifecycle election and wait functions from Task 1.
- Produces: reusable `DestroyerHandle.destroy()`, public `DestroyerHandle.async_destroy()`, and optional local managed-requester binding that is not serialized by `get_object()`. A winning handle wakes the coordinator through `WorkerBackgroundRef.notify_destroy()` without acquiring its command lock.

- [ ] **Step 1: Write delayed, repeated, asynchronous, and failure tests**

Create `src/destroyer_handle.test.ts` using a structurally cast
`WorkerBackgroundRef`, because destroy no longer submits coordinator opcode 5:

```ts
import { describe, expect, test } from "bun:test";
import { DestroyerHandle } from "./destroyer_handle.ts";
import type { WorkerBackgroundRef } from "./shared_array_buffer/worker_background/index.ts";
import {
  createDestroyStatus,
  markDestroyed,
  markDestroyFailed,
  readLifecycle,
  WorkerDestroyError,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "./shared_array_buffer/worker_lifecycle.ts";

const unusedSender = {
  notify_destroy: () => undefined,
} as unknown as WorkerBackgroundRef;

describe("DestroyerHandle", () => {
  test("remains usable after a task delay", async () => {
    const status = createDestroyStatus();
    const handle = new DestroyerHandle(unusedSender, status);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    handle.destroy();

    expect(readLifecycle(new Int32Array(status))).toBe(
      WorkerLifecycle.Destroying,
    );
  });

  test("repeated destroy is idempotent", () => {
    const status = createDestroyStatus();
    const handle = new DestroyerHandle(unusedSender, status);

    handle.destroy();
    handle.destroy();

    expect(readLifecycle(new Int32Array(status))).toBe(
      WorkerLifecycle.Destroying,
    );
  });

  test("async_destroy waits for successful terminal state", async () => {
    const status = createDestroyStatus();
    const view = new Int32Array(status);
    const handle = new DestroyerHandle(unusedSender, status);
    const completion = handle.async_destroy();
    markDestroyed(view);

    await expect(completion).resolves.toBeUndefined();
  });

  test("async_destroy reports a stable failure category", async () => {
    const status = createDestroyStatus();
    const view = new Int32Array(status);
    const handle = new DestroyerHandle(unusedSender, status);
    const completion = handle.async_destroy();
    markDestroyFailed(view, WorkerDestroyFailureCode.CoordinatorRuntime);

    await expect(completion).rejects.toBeInstanceOf(WorkerDestroyError);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test src/destroyer_handle.test.ts`

Expected: FAIL because `async_destroy()` and the lifecycle-based implementation
do not exist; the delayed test also exposes the current premature cleanup.

- [ ] **Step 3: Replace listener cleanup with lifecycle election**

Remove `listen_holder`, `listen()`, and the unsafe null-cast `cleanup()`.
Implement the class around immutable capability data:

```ts
export class DestroyerHandle {
  private requester_shutdown?: Promise<void>;

  constructor(
    private readonly sender: WorkerBackgroundRef,
    private readonly destroy_status: SharedArrayBuffer,
    private readonly requester_animal_id?: number,
  ) {}

  static init_self(obj: DestroyerHandleObject): DestroyerHandle {
    return new DestroyerHandle(
      WorkerBackgroundRef.init_self(obj.sender),
      obj.destroy_status,
    );
  }

  static init_bound(
    obj: DestroyerHandleObject,
    requesterAnimalId: number,
  ): DestroyerHandle {
    return new DestroyerHandle(
      WorkerBackgroundRef.init_self(obj.sender),
      obj.destroy_status,
      requesterAnimalId,
    );
  }

  get_object(): DestroyerHandleObject {
    return {
      sender: this.sender.get_object(),
      destroy_status: this.destroy_status,
    };
  }

  destroy(): void {
    const view = new Int32Array(this.destroy_status);
    if (
      beginDestroy(
        view,
        this.requester_animal_id,
      )
    ) {
      this.sender.notify_destroy();
      if (this.requester_animal_id !== undefined) {
        void this.schedule_requester_shutdown(view).catch(() => undefined);
      }
    }
  }

  async async_destroy(): Promise<void> {
    const view = new Int32Array(this.destroy_status);
    const won = beginDestroy(view, this.requester_animal_id);
    if (won) this.sender.notify_destroy();
    const isElectedRequester =
      this.requester_animal_id !== undefined &&
      readRequesterAnimalId(view) === this.requester_animal_id;
    if (isElectedRequester) {
      await this.schedule_requester_shutdown(view);
      return;
    }
    await waitForDestroyTerminal(view);
  }

  private schedule_requester_shutdown(view: Int32Array): Promise<void> {
    this.requester_shutdown ??= (async () => {
      await waitForRequesterDrained(view);
      setTimeout(() => {
        markRequesterClosing(view);
        const close = Reflect.get(globalThis, "close");
        if (typeof close === "function") close.call(globalThis);
      }, 0);
    })();
    return this.requester_shutdown;
  }
}
```

Change the serialized type to use data rather than a cloned class instance:

```ts
export interface DestroyerHandleObject {
  sender: WorkerBackgroundRefObject;
  destroy_status: SharedArrayBuffer;
}
```

`sender` remains serialized for public object compatibility but is not used to
send opcode 5 through the global command lock. Add this exact wake-only method
to `WorkerBackgroundRef`:

```ts
notify_destroy(): void {
  Atomics.notify(new Int32Array(this.lock), 1);
}
```

It deliberately does not write the command flag or signature buffer. The
coordinator wakes from its existing `lock[1]` wait and checks lifecycle before
reading an opcode.

- [ ] **Step 4: Export the typed public destroy error**

Add to `src/index.ts`:

```ts
export type { DestroyerHandleObject } from "./destroyer_handle.ts";
export {
  WorkerDestroyError,
  WorkerDestroyFailureCode,
} from "./shared_array_buffer/worker_lifecycle.ts";
```

- [ ] **Step 5: Run tests and commit**

After the test command succeeds, commit only Task 3 files:

```bash
git status --short
git diff -- src/destroyer_handle.ts src/destroyer_handle.test.ts src/index.ts src/shared_array_buffer/worker_background/worker_background_ref.ts
git add src/destroyer_handle.ts src/destroyer_handle.test.ts src/index.ts src/shared_array_buffer/worker_background/worker_background_ref.ts
git commit -m "fix(threads): make destroy handles durable"
```

Run:

```bash
bun test src/destroyer_handle.test.ts src/shared_array_buffer/worker_lifecycle.test.ts
npx tsc --noEmit
```

Expected: both test files pass and TypeScript reports no errors.

Run:

```bash
git status --short
```

---

### Task 4: Give Every Worker Operation a Terminal Request Block

**Files:**
- Create: `src/shared_array_buffer/worker_request.ts`
- Create: `src/shared_array_buffer/worker_request.test.ts`
- Modify: `src/shared_array_buffer/worker_background/worker_background_ref.ts:106-170`
- Modify: `src/shared_array_buffer/worker_background/worker.ts:25-32,139-413`
- Generated: `src/shared_array_buffer/worker_background/worker_blob.ts`
- Generated: `src/shared_array_buffer/worker_background/worker_background_worker_minify.js`

**Interfaces:**
- Consumes: `AllocatorUseArrayBuffer`, signature words 6 and 7 from Task 2.
- Produces: allocator-backed `[state, failureCode, workerId]` blocks and exactly-once request completion.

- [ ] **Step 1: Write the failing request-state tests**

Create `src/shared_array_buffer/worker_request.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  completeWorkerRequest,
  WorkerRequestFailure,
  WorkerRequestState,
} from "./worker_request.ts";

test("only one worker request terminal result wins", () => {
  const view = new Int32Array(new SharedArrayBuffer(12));

  expect(
    completeWorkerRequest(
      view,
      WorkerRequestState.Ready,
      WorkerRequestFailure.None,
      9,
    ),
  ).toBe(true);
  expect(
    completeWorkerRequest(
      view,
      WorkerRequestState.Cancelled,
      WorkerRequestFailure.Destroyed,
    ),
  ).toBe(false);
  expect(Atomics.load(view, 2)).toBe(9);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test src/shared_array_buffer/worker_request.test.ts`

Expected: FAIL because `worker_request.ts` does not exist.

- [ ] **Step 3: Implement request state publication**

Create `src/shared_array_buffer/worker_request.ts`:

```ts
import { wakeDestroyWaiters } from "./worker_lifecycle.ts";

export const WORKER_REQUEST_BYTES = 12;
export const WORKER_REQUEST_STATE = 0;
export const WORKER_REQUEST_FAILURE = 1;
export const WORKER_REQUEST_ID = 2;

export enum WorkerRequestState {
  Pending = 0,
  Completing = 1,
  Ready = 2,
  Failed = 3,
  Cancelled = 4,
}

export enum WorkerRequestFailure {
  None = 0,
  Destroyed = 1,
  ScriptLoad = 2,
  AnimalConstruction = 3,
  WasmInstantiation = 4,
  Protocol = 5,
}

export enum RuntimeCompletion {
  Waiting = 0,
  Error = 1,
  Exit = 2,
  Done = 3,
  Cancelled = 4,
}

export function completeWorkerRequest(
  view: Int32Array,
  state:
    | WorkerRequestState.Ready
    | WorkerRequestState.Failed
    | WorkerRequestState.Cancelled,
  failure: WorkerRequestFailure,
  workerId = 0,
  destroyView?: Int32Array,
): boolean {
  if (Atomics.compareExchange(
    view,
    WORKER_REQUEST_STATE,
    WorkerRequestState.Pending,
    WorkerRequestState.Completing,
  ) !== WorkerRequestState.Pending) {
    return false;
  }
  Atomics.store(view, WORKER_REQUEST_FAILURE, failure);
  Atomics.store(view, WORKER_REQUEST_ID, workerId);
  Atomics.store(view, WORKER_REQUEST_STATE, state);
  Atomics.notify(view, WORKER_REQUEST_STATE);
  if (destroyView !== undefined) {
    Atomics.notify(destroyView, DESTROY_REQUESTER_STATUS);
    wakeDestroyWaiters(destroyView);
  }
  return true;
}
```

- [ ] **Step 4: Allocate request blocks in `WorkerBackgroundRef`**

For opcode 1 and opcode 2, allocate 15 zeroed bytes through the existing
allocator, store its pointer and length in signature indices 6 and 7, submit
the command, wait only for coordinator command acknowledgement, and release the
command mutex. Then wait on the request block outside that mutex. Add these
allocation helpers to `WorkerBackgroundRef`:

```ts
private block_allocate_worker_request(): {
  allocationPtr: number;
  allocationLen: number;
  ptr: number;
  view: Int32Array;
} {
  const address = new SharedArrayBuffer(8);
  const [allocationPtr, allocationLen] = this.allocator.block_write(
    new Uint8Array(WORKER_REQUEST_BYTES + 3),
    address,
    0,
  );
  const ptr = (allocationPtr + 3) & ~3;
  return {
    allocationPtr,
    allocationLen,
    ptr,
    view: new Int32Array(this.allocator.share_arrays_memory, ptr, 3),
  };
}

private async async_allocate_worker_request(): Promise<{
  allocationPtr: number;
  allocationLen: number;
  ptr: number;
  view: Int32Array;
}> {
  const address = new SharedArrayBuffer(8);
  const [allocationPtr, allocationLen] = await this.allocator.async_write(
    new Uint8Array(WORKER_REQUEST_BYTES + 3),
    address,
    0,
  );
  const ptr = (allocationPtr + 3) & ~3;
  return {
    allocationPtr,
    allocationLen,
    ptr,
    view: new Int32Array(this.allocator.share_arrays_memory, ptr, 3),
  };
}
```

Acquire the allocator block before the command mutex. In a `finally`, call
`this.allocator.free(allocationPtr, allocationLen)` after the request reaches a
terminal state or global lifecycle makes the operation fail. After acquiring the command mutex,
copy `ptr` and `WORKER_REQUEST_BYTES` into signature words
`SIGNATURE_REQUEST_STATUS_PTR` and `SIGNATURE_REQUEST_STATUS_LEN`; never let an
allocator call write directly into the shared signature buffer before the
command mutex is owned.

The three extra allocation bytes guarantee that `ptr` can be rounded up to a
four-byte boundary without changing the shared allocator. The `finally` block
must free `allocationPtr` and `allocationLen`, not the aligned inner pointer.

Use one shared decoder for blocking and asynchronous callers:

```ts
private read_worker_request(view: Int32Array): WorkerRef {
  const state = Atomics.load(view, WORKER_REQUEST_STATE);
  if (state === WorkerRequestState.Ready) {
    return new WorkerRef(Atomics.load(view, WORKER_REQUEST_ID));
  }
  const failure = Atomics.load(view, WORKER_REQUEST_FAILURE);
  throw new Error(
    `worker request failed: ${WorkerRequestFailure[failure as WorkerRequestFailure]}`,
  );
}
```

Both wait variants free the allocator block in `finally` after observing a
terminal state. They recheck `readLifecycle()` before registration and after
acquiring the command mutex; if it is not `Running`, they release allocations
and throw `WorkerDestroyError` without publishing the command.

The wait loop treats both `Pending` and `Completing` as non-terminal. It captures
the current `destroy_status[WAKE_EPOCH]`, re-reads both lifecycle and request
state, and waits on that exact epoch only if both are still non-terminal. Every
request completion increments and notifies `WAKE_EPOCH`. Global failure does
the same, so a coordinator crash cannot strand a caller waiting on a request
address that the failed coordinator no longer knows, and completion between
the recheck and wait produces `not-equal` rather than a missed wake.

Implement the blocking form with this state/epoch/state ordering; the
asynchronous form uses the same loop with `Atomics.waitAsync()`:

```ts
private block_wait_worker_request(requestView: Int32Array): WorkerRef {
  const destroyView = new Int32Array(this.destroy_status);
  for (;;) {
    const state = Atomics.load(requestView, WORKER_REQUEST_STATE);
    if (
      state === WorkerRequestState.Ready ||
      state === WorkerRequestState.Failed ||
      state === WorkerRequestState.Cancelled
    ) {
      return this.read_worker_request(requestView);
    }
    const lifecycle = readLifecycle(destroyView);
    if (lifecycle === WorkerLifecycle.Failed) {
      throw new WorkerDestroyError(
        Atomics.load(
          destroyView,
          DESTROY_FAILURE_CODE,
        ) as WorkerDestroyFailureCode,
      );
    }
    if (lifecycle === WorkerLifecycle.Destroyed) {
      throw new WorkerDestroyError(WorkerDestroyFailureCode.Protocol);
    }
    const epoch = Atomics.load(destroyView, DESTROY_WAKE_EPOCH);
    if (
      Atomics.load(requestView, WORKER_REQUEST_STATE) === state &&
      Atomics.load(destroyView, DESTROY_WAKE_EPOCH) === epoch
    ) {
      Atomics.wait(destroyView, DESTROY_WAKE_EPOCH, epoch);
    }
  }
}
```

The asynchronous form replaces the final wait with:

```ts
const { value } = Atomics.waitAsync(
  destroyView,
  DESTROY_WAKE_EPOCH,
  epoch,
);
if (value instanceof Promise) await value;
```

- [ ] **Step 5: Store request metadata in coordinator worker records**

Replace the raw Worker registry element with:

```ts
type WorkerRecord = {
  worker: Worker;
  request_view?: Int32Array;
  worker_id: number;
  animal_id?: number;
};

private workers: Array<WorkerRecord | undefined> = [undefined];
private start_worker?: WorkerRecord;
private animal_workers = new Map<number, WorkerRecord>();
```

Opcode 1 creates the Worker and handlers, records the request block, and exits
the switch without awaiting `ready`. `ready` calls
`completeWorkerRequest()` with `Ready` and clears `record.request_view` before
the caller frees the allocator block. `error` and `messageerror` call
`completeWorkerRequest()` with `Failed` only while `request_view` is present. A
completion that loses to cancellation terminates the captured Worker and never
restores a registry entry.

Use this shape for the ready path:

```ts
const publish_ready = (record: WorkerRecord, animalId: number): void => {
  const requestView = record.request_view;
  record.request_view = undefined;
  const accepted =
    requestView !== undefined &&
    readLifecycle(new Int32Array(this.destroy_status)) ===
      WorkerLifecycle.Running &&
    completeWorkerRequest(
      requestView,
      WorkerRequestState.Ready,
      WorkerRequestFailure.None,
      record.worker_id,
      new Int32Array(this.destroy_status),
    );
  if (!accepted) {
    this.workers[record.worker_id] = undefined;
    record.worker.terminate();
    return;
  }
  this.pending_animal_workers.delete(animalId);
  record.animal_id = animalId;
  this.animal_workers.set(animalId, record);
  this.worker_animals.set(record.worker_id, animalId);
};
```

The failure path captures `record.worker` before clearing either registry,
publishes `Failed` when `request_view` is still present, then elects global
teardown with an external requester code and wakes `lock[1]`.

```ts
const publish_failure = (
  record: WorkerRecord,
  failure: WorkerRequestFailure,
): void => {
  const requestView = record.request_view;
  record.request_view = undefined;
  if (requestView !== undefined) {
    completeWorkerRequest(
      requestView,
      WorkerRequestState.Failed,
      failure,
      record.worker_id,
      new Int32Array(this.destroy_status),
    );
  }
  this.fail_runtime(WorkerDestroyFailureCode.WorkerBootstrap);
};
```

`fail_runtime()` records one global failure category, elects teardown if it is
still `Running`, and invokes the same memoized coordinator teardown directly.
It leaves the failed record in the registry until teardown captures and
terminates it.

Opcode 2 follows the same registration protocol and completes its request once
the start Worker and handlers are installed. Its later done/error status still
uses the existing runtime completion area at `lock` byte offset 12.

- [ ] **Step 6: Cancel the runtime completion waiter on destroy**

Use the `RuntimeCompletion` enum from `worker_request.ts` for the existing
completion area:

```ts
Atomics.store(notifyView, 0, RuntimeCompletion.Cancelled);
Atomics.notify(notifyView, 0);
```

`async_wait_done_or_error()` and `block_wait_done_or_error()` throw
`WorkerDestroyError` when they observe `Cancelled`. The coordinator teardown
path stores `Cancelled` and notifies `notify_view[0]` before terminating the
start Worker.

- [ ] **Step 7: Run request and existing worker tests**

Run:

```bash
npm run worker
bun test src/shared_array_buffer/worker_request.test.ts src/shared_array_buffer/base_call_worker.test.ts
npx tsc --noEmit
```

Expected: request tests and existing real-Worker BaseCall tests pass; TypeScript
reports no errors.

- [ ] **Step 8: Commit request lifecycle changes**

```bash
git status --short
git diff -- src/shared_array_buffer/worker_request.ts src/shared_array_buffer/worker_request.test.ts src/shared_array_buffer/worker_background/worker_background_ref.ts src/shared_array_buffer/worker_background/worker.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
git add src/shared_array_buffer/worker_request.ts src/shared_array_buffer/worker_request.test.ts src/shared_array_buffer/worker_background/worker_background_ref.ts src/shared_array_buffer/worker_background/worker.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
git commit -m "fix(threads): settle worker spawn requests"
```

Run:

```bash
git status --short
```

---

### Task 5: Make Coordinator Teardown Out-of-Band and Complete

**Files:**
- Create: `src/shared_array_buffer/worker_destroy.test.ts`
- Create: `src/shared_array_buffer/test_workers/failing_worker_background.ts`
- Create: `src/shared_array_buffer/test_workers/noop_worker.ts`
- Modify: `src/shared_array_buffer/worker_background/worker.ts:80-111,414-467`
- Modify: `src/shared_array_buffer/thread_spawn.ts:64-181,334-370`
- Modify: `src/shared_array_buffer/worker_background/worker_background_ref.ts:329-356`
- Generated: `src/shared_array_buffer/worker_background/worker_blob.ts`
- Generated: `src/shared_array_buffer/worker_background/worker_background_worker_minify.js`

**Interfaces:**
- Consumes: packed lifecycle from Task 1 and Worker records from Task 4.
- Produces: command-lock-independent teardown; coordinator bootstrap rejection; owner-side `destroy()` and `async_destroy()` finalization.

- [ ] **Step 1: Write failing coordinator-bootstrap and owner-finalization tests**

Create a background fixture that fails before ready:

```ts
throw new Error("coordinator bootstrap failed");
```

Create `test_workers/noop_worker.ts` so a successful coordinator can construct
a child without application dependencies:

```ts
globalThis.onmessage = () => {
  globalThis.postMessage({ msg: "ready", animal_id: 0 });
};
```

In `worker_destroy.test.ts`, construct `ThreadSpawner` with that fixture URL and
assert `wait_worker_background_worker()` rejects instead of remaining pending.
Add a second test using the normal coordinator URL that calls `destroy()`, then
`async_destroy()`, and verifies the lifecycle reaches `Destroyed` and a later
spawn/start call throws `WorkerDestroyError`.

```ts
test("coordinator bootstrap failure rejects readiness", async () => {
  const spawner = createTestThreadSpawner(
    new URL(
      "./test_workers/failing_worker_background.ts",
      import.meta.url,
    ).href,
  );

  await expect(spawner.wait_worker_background_worker()).rejects.toThrow(
    "CoordinatorBootstrap",
  );
});
```

Implement `createTestThreadSpawner()` in the test with the real constructor:

```ts
function createTestThreadSpawner(backgroundUrl: string): ThreadSpawner {
  return new ThreadSpawner(
    new URL("./test_workers/noop_worker.ts", import.meta.url).href,
    [],
    undefined,
    16_777_216,
    undefined,
    undefined,
    backgroundUrl,
  );
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test src/shared_array_buffer/worker_destroy.test.ts`

Expected: FAIL or time out because coordinator startup has no error rejection
and teardown does not reach a terminal lifecycle.

- [ ] **Step 3: Wake the existing command wait for lifecycle activity**

Keep one `Atomics.waitAsync()` on existing `lock[1]`; do not use
`Promise.race()` between two atomic addresses because the losing waiter cannot
be cancelled. A destroy winner calls `WorkerBackgroundRef.notify_destroy()`,
which notifies `lock[1]` without setting a command flag. After every wake,
`WorkerBackground.listen()` re-reads lifecycle before inspecting the command
flag. If lifecycle is not `Running`, it enters one memoized teardown path and
returns instead of resuming the infinite loop.

After Task 4, opcode 1 has no in-handler `await ready`, so coordinator command
processing always returns to this lifecycle check promptly.

- [ ] **Step 4: Implement the single coordinator teardown path**

Add a memoized method:

```ts
private teardown_promise?: Promise<void>;
private teardown_failure?: WorkerDestroyFailureCode;

private teardown(): Promise<void> {
  this.teardown_promise ??= this.teardown_inner();
  return this.teardown_promise;
}

private fail_runtime(code: WorkerDestroyFailureCode): void {
  this.teardown_failure ??= code;
  beginDestroy(new Int32Array(this.destroy_status));
  Atomics.notify(new Int32Array(this.lock), 1);
  void this.teardown();
}
```

`teardown_inner()` must perform this exact order:

```ts
private async teardown_inner(): Promise<void> {
  const destroyView = new Int32Array(this.destroy_status);
  const requesterId = readRequesterAnimalId(destroyView);
  const requester =
    requesterId === undefined ? undefined : this.animal_workers.get(requesterId);
  const records = this.workers.slice(1).filter(
    (record): record is WorkerRecord => record !== undefined,
  );
  const startWorker = this.start_worker;

  this.workers = [undefined];
  this.start_worker = undefined;
  this.animal_workers.clear();

  for (const record of records) {
    if (record.request_view !== undefined) {
      completeWorkerRequest(
        record.request_view,
        WorkerRequestState.Cancelled,
        WorkerRequestFailure.Destroyed,
      );
      record.request_view = undefined;
    }
    if (record !== requester) record.worker.terminate();
  }

  if (startWorker !== undefined) {
    if (startWorker.request_view !== undefined) {
      completeWorkerRequest(
        startWorker.request_view,
        WorkerRequestState.Cancelled,
        WorkerRequestFailure.Destroyed,
      );
      startWorker.request_view = undefined;
    }
    if (startWorker !== requester) startWorker.worker.terminate();
  }

  const notifyView = new Int32Array(this.lock, 12);
  Atomics.store(notifyView, 0, RuntimeCompletion.Cancelled);
  Atomics.notify(notifyView, 0);

  if (requester !== undefined) {
    Atomics.store(
      destroyView,
      DESTROY_REQUESTER_STATUS,
      RequesterStatus.RequesterDrained,
    );
    wakeDestroyWaiters(destroyView);
    await this.wait_for_requester_closing(destroyView);
    requester.worker.terminate();
  }

  if (this.teardown_failure === undefined) {
    markDestroyed(destroyView);
  } else {
    markDestroyFailed(destroyView, this.teardown_failure);
  }
  globalThis.close();
}
```

Inject these scheduler fields into `WorkerBackground` so tests can trigger the
safety deadline without sleeping:

```ts
private schedule_timeout: typeof setTimeout = setTimeout;
private cancel_timeout: typeof clearTimeout = clearTimeout;
```

Implement the requester wait as:

```ts
private async wait_for_requester_closing(view: Int32Array): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const closing = (async () => {
    while (
      Atomics.load(view, DESTROY_REQUESTER_STATUS) !== RequesterStatus.Closing
    ) {
      const observed = Atomics.load(view, DESTROY_REQUESTER_STATUS);
      const { value } = Atomics.waitAsync(
        view,
        DESTROY_REQUESTER_STATUS,
        observed,
      );
      if (value instanceof Promise) await value;
    }
  })();
  const deadline = new Promise<void>((resolve) => {
    timeout = this.schedule_timeout(resolve, 1_000);
  });

  await Promise.race([closing, deadline]);
  if (timeout !== undefined) this.cancel_timeout(timeout);
}
```

The coordinator owns this one bounded losing waiter until it immediately closes
after teardown, so it cannot accumulate across listen-loop iterations.

When the excluded requester emits `error`, `messageerror`, or `exit`, its event
handler calls `markRequesterClosing(destroyView)` before returning. The
coordinator therefore proceeds immediately instead of waiting for the safety
deadline when the requester has already exited abnormally.

- [ ] **Step 5: Make bootstrap failures terminal**

In `ThreadSpawner`, construct the ready Promise with both resolve and reject,
install `onerror` and `onmessageerror` before `postMessage()`, and route either
failure through:

```ts
const failCoordinator = (error: unknown): void => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : String(error);
  const failure = new WorkerDestroyError(
    WorkerDestroyFailureCode.CoordinatorBootstrap,
  );
  failure.cause = new Error(message);
  beginDestroy(new Int32Array(this.destroy_status));
  markDestroyFailed(
    new Int32Array(this.destroy_status),
    WorkerDestroyFailureCode.CoordinatorBootstrap,
  );
  const coordinator = this.worker_background_worker;
  this.worker_background_worker = undefined;
  if (coordinator !== undefined) coordinator.terminate();
  rejectWorkerBackground(failure);
};
```

- [ ] **Step 6: Finalize the coordinator from `ThreadSpawner`**

Replace opcode-5 destruction with lifecycle election. Keep the coordinator
Worker strongly referenced until terminal state:

```ts
private destroy_promise?: Promise<void>;

destroy(requesterAnimalId?: number): void {
  if (!this.owns_worker_background_worker) {
    this.create_destroyer(requesterAnimalId).destroy();
    return;
  }
  const won = beginDestroy(
    new Int32Array(this.destroy_status),
    requesterAnimalId,
  );
  if (won) this.worker_background_ref.notify_destroy();
  if (this.owns_worker_background_worker) {
    this.destroy_promise ??= this.finish_destroy();
    void this.destroy_promise.catch(() => undefined);
  }
}

async async_destroy(requesterAnimalId?: number): Promise<void> {
  if (!this.owns_worker_background_worker) {
    await this.create_destroyer(requesterAnimalId).async_destroy();
    return;
  }
  this.destroy(requesterAnimalId);
  await this.destroy_promise;
}

private async finish_destroy(): Promise<void> {
  const coordinator = this.worker_background_worker;
  try {
    await waitForDestroyTerminal(new Int32Array(this.destroy_status));
  } finally {
    this.worker_background_worker = undefined;
    if (coordinator !== undefined) coordinator.terminate();
  }
}
```

For reconstructed `ThreadSpawner` instances that do not own the coordinator
Worker, `async_destroy(requesterAnimalId)` delegates to a bound
`DestroyerHandle.async_destroy()` so an elected managed requester waits for
`RequesterDrained` rather than global `Destroyed`. Only an owner-side spawner
creates `destroy_promise` and runs `finish_destroy()`.

Remove coordinator opcode 5 and `WorkerBackgroundRef.destroy()` command-lock
submission. If an internal compatibility method remains, it must call
`beginDestroy()` directly and never acquire `lock[0]`.

- [ ] **Step 7: Run focused and full source tests**

Run:

```bash
npm run worker
bun test src/shared_array_buffer/worker_destroy.test.ts
bun test src
npx tsc --noEmit
```

Expected: coordinator bootstrap rejects deterministically, destroy reaches a
terminal state, all source tests pass, and TypeScript reports no errors.

- [ ] **Step 8: Commit coordinator teardown**

```bash
git status --short
git diff -- src/shared_array_buffer/worker_destroy.test.ts src/shared_array_buffer/test_workers/failing_worker_background.ts src/shared_array_buffer/test_workers/noop_worker.ts src/shared_array_buffer/worker_background/worker.ts src/shared_array_buffer/thread_spawn.ts src/shared_array_buffer/worker_background/worker_background_ref.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
git add src/shared_array_buffer/worker_destroy.test.ts src/shared_array_buffer/test_workers/failing_worker_background.ts src/shared_array_buffer/test_workers/noop_worker.ts src/shared_array_buffer/worker_background/worker.ts src/shared_array_buffer/thread_spawn.ts src/shared_array_buffer/worker_background/worker_background_ref.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
git commit -m "fix(threads): terminate worker coordinator safely"
```

Run:

```bash
git status --short
```

---

### Task 6: Expose Animal APIs and Repair Individual Termination

**Files:**
- Create: `src/shared_array_buffer/test_workers/destroy_handle_worker.ts`
- Modify: `src/animals.ts:34-51,389-420,470-472,533-563`
- Modify: `src/shared_array_buffer/thread_spawn.ts:216-224,350-370,446-525`
- Modify: `src/shared_array_buffer/worker_background/worker.ts:139-208,437-451`
- Modify: `src/shared_array_buffer/worker_destroy.test.ts`
- Generated: `src/shared_array_buffer/worker_background/worker_blob.ts`
- Generated: `src/shared_array_buffer/worker_background/worker_background_worker_minify.js`

**Interfaces:**
- Consumes: `DestroyerHandle.init_bound()`, `ThreadSpawner.async_destroy()`, and `WorkerRecord`.
- Produces: `WASIFarmAnimal.init_destroyer()`, `WASIFarmAnimal.async_destroy()`, bounded unique Animal IDs, standard ready messages with `animal_id`, and direct idempotent `kill_animal()`.

- [ ] **Step 1: Write failing public API and real-Worker tests**

Add compile/runtime tests that establish:

```ts
const handle = animal.init_destroyer(transferredHandle);
const completion: Promise<void> = animal.async_destroy();
expect(handle).toBeInstanceOf(DestroyerHandle);
expect(completion).toBeInstanceOf(Promise);
```

Add real-Worker scenarios to `worker_destroy.test.ts` for:

- a transferred handle used after a task delay;
- `destroy()` followed by `async_destroy()` joining the same elected teardown;
- managed `async_destroy()` receiving `RequesterDrained`, resolving, then
  publishing `Closing` from its scheduled close task;
- two live Animals where `kill_animal(firstId)` stops only the first;
- repeated `kill_animal(firstId)` remaining a no-op;
- error/exit sender termination without loss of its Worker reference.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test src/shared_array_buffer/worker_destroy.test.ts`

Expected: FAIL because `init_destroyer()`, `async_destroy()`, requester-last
handling, ready IDs, and direct individual termination are absent.

- [ ] **Step 3: Bind handles only in managed Animal contexts**

Add a readonly ownership flag to `ThreadSpawner`, set to `true` only when that
instance creates the coordinator Worker. A reconstructed `ThreadSpawner` sets
it to `false`.

```ts
is_managed_worker_context(): boolean {
  return !this.owns_worker_background_worker;
}

create_destroyer(animalId?: number): DestroyerHandle {
  const requester = this.is_managed_worker_context() ? animalId : undefined;
  return new DestroyerHandle(
    this.worker_background_ref,
    this.destroy_status,
    requester,
  );
}
```

In `WASIFarmAnimal`:

```ts
// Import DestroyerHandle as a value and DestroyerHandleObject as a type.
create_destroyer(): DestroyerHandle {
  if (!this.thread_spawner) {
    throw new Error("You should enable thread_spawn to use create_destroyer");
  }
  return this.thread_spawner.create_destroyer(this.animal_id);
}

init_destroyer(obj: DestroyerHandleObject): DestroyerHandle {
  if (!this.thread_spawner || this.animal_id === undefined) {
    throw new Error("thread spawner is not available");
  }
  return this.thread_spawner.is_managed_worker_context()
    ? DestroyerHandle.init_bound(obj, this.animal_id)
    : DestroyerHandle.init_self(obj);
}

async async_destroy(): Promise<void> {
  const spawner = this.thread_spawner;
  if (spawner !== undefined) {
    const requester = spawner.is_managed_worker_context()
      ? this.animal_id
      : undefined;
    await spawner.async_destroy(requester);
  }
  this.inst = undefined;
  this.wasi_farm_refs = [];
  this.thread_spawner = undefined;
}
```

Update synchronous `destroy()` to call `spawner.destroy(requester)` before
clearing `inst` and Farm references. Keep the terminal `thread_spawner` field so
a later owner-side `async_destroy()` can join its memoized completion; clear the
field only after asynchronous completion. The spawner's memoized finalizer
retains the owner coordinator until terminal state. Every other spawner method
checks lifecycle and rejects work after synchronous destroy.

- [ ] **Step 4: Bound Animal ID generation and publish ready IDs**

Move managed Animal ID allocation into the coordinator. Maintain
`next_animal_id` plus a `free_animal_ids` stack; allocate before creating a
Worker, register the ID with the pending `WorkerRecord`, and pass it in the
worker bootstrap payload. Return an ID to the free stack only after that record
has been removed from both worker registries. This permits safe reuse without
ever colliding with a live or pending Worker and avoids permanent exhaustion in
long-running processes.

Use these coordinator helpers:

```ts
private next_animal_id = 0;
private free_animal_ids: number[] = [];

private allocate_animal_id(): number {
  const reused = this.free_animal_ids.pop();
  if (reused !== undefined) return reused;
  if (this.next_animal_id > 2 ** 30 - 2) {
    throw new RangeError("no Animal IDs are available");
  }
  return this.next_animal_id++;
}

private release_animal_id(animalId: number): void {
  this.free_animal_ids.push(animalId);
}
```

Extend the internal `WASIFarmAnimal` constructor path with an optional assigned
ID. Root Animals keep their existing local ID only for diagnostics; spawned
Animals use the coordinator-assigned ID and do not increment the shared
counter. Include that assigned `animal_id` in every standard `ready`, `done`,
`error`, and `exit` message emitted by `thread_spawn_on_worker()`.

The coordinator updates both directions:

```ts
private animal_workers = new Map<number, WorkerRecord>();
private pending_animal_workers = new Map<number, WorkerRecord>();
private worker_animals = new Map<number, number>();
```

Registration occurs only if the request is still pending and global lifecycle
is `Running`. A late ready terminates the Worker.

- [ ] **Step 5: Make `kill_animal()` terminate the captured Worker**

Replace the ignored `postMessage({ msg: "kill_animal" })` path with:

```ts
private kill_animal(animalId: number): void {
  const record = this.animal_workers.get(animalId);
  if (record === undefined) return;

  this.animal_workers.delete(animalId);
  this.worker_animals.delete(record.worker_id);
  this.workers[record.worker_id] = undefined;
  this.release_animal_id(animalId);
  if (record.request_view !== undefined) {
    completeWorkerRequest(
      record.request_view,
      WorkerRequestState.Cancelled,
      WorkerRequestFailure.Destroyed,
      record.worker_id,
      new Int32Array(this.destroy_status),
    );
    record.request_view = undefined;
  }
  record.worker.terminate();
}
```

Coordinator opcode 4 invokes this method and immediately acknowledges the
command. An unknown or already-removed ID remains an idempotent no-op.

- [ ] **Step 6: Run public API and worker tests**

Run:

```bash
npm run worker
bun test src/shared_array_buffer/worker_destroy.test.ts src/destroyer_handle.test.ts
bun test src
npx tsc --noEmit
```

Expected: all focused scenarios, all source tests, and type checking pass.

- [ ] **Step 7: Commit Animal lifecycle APIs**

```bash
git status --short
git diff -- src/animals.ts src/shared_array_buffer/thread_spawn.ts src/shared_array_buffer/worker_background/worker.ts src/shared_array_buffer/worker_destroy.test.ts src/shared_array_buffer/test_workers/destroy_handle_worker.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
git add src/animals.ts src/shared_array_buffer/thread_spawn.ts src/shared_array_buffer/worker_background/worker.ts src/shared_array_buffer/worker_destroy.test.ts src/shared_array_buffer/test_workers/destroy_handle_worker.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
git commit -m "feat(threads): expose observable worker teardown"
```

Run:

```bash
git status --short
```

---

### Task 7: Normalize Node Self-Close, Regenerate Workers, and Document Contracts

**Files:**
- Modify: `examples/destroy_node/common.ts:22-37`
- Modify: `examples/wasi_multi_threads_channel_node/common.ts:1-19`
- Modify: `README.md:51-67`
- Modify: `architecture/destroy_flow.md:1-10`
- Generated: `src/shared_array_buffer/worker_background/worker_blob.ts`
- Generated: `src/shared_array_buffer/worker_background/worker_background_worker_minify.js`

**Interfaces:**
- Consumes: final coordinator and requester-last implementation.
- Produces: a Node-compatible worker-global `close()`, synchronized generated workers, and accurate public documentation.

- [ ] **Step 1: Add Node worker-global close support**

In both Node worker wrapper setup functions, install a worker-only close:

```ts
(globalThis as typeof globalThis & { close: () => void }).close = () => {
  process.exit(0);
};
```

Keep this inside the existing `!isMainThread` guard so it cannot exit the host
process from the main thread.

- [ ] **Step 2: Update public documentation**

Document the following exact contracts in `README.md`:

- `WASIFarm.destroy()` remains Park-only.
- `WASIFarmAnimal.destroy()` and `DestroyerHandle.destroy()` synchronously make
  the worker runtime reject new work and initiate runtime-wide teardown.
- `async_destroy()` observes logical teardown and issued termination operations;
  browser platforms do not provide a physical thread join.
- A managed requester resolves after all other Workers receive termination and
  its own close is scheduled.
- A transferred handle inside a managed worker must be reconstructed with
  `WASIFarmAnimal.init_destroyer()`.
- `kill_animal(animal_id)` affects only a published, registered Animal ID.

Prepend `architecture/destroy_flow.md` with:

```md
> [!WARNING]
> The worker teardown portions of this document are superseded by
> `docs/superpowers/specs/2026-09-04-worker-destroy-lifecycle-design.md`.
> Park and BaseCall behavior remains governed by
> `architecture/base_call_multiplexing_design.md`.
```

- [ ] **Step 3: Regenerate coordinator artifacts**

Run: `npm run worker`

Expected: spack creates `dist/workers/worker_background_worker.js`; the minifier
updates `dist/workers/worker_background_worker_minify.js`,
`src/shared_array_buffer/worker_background/worker_blob.ts`, and
`src/shared_array_buffer/worker_background/worker_background_worker_minify.js`.

- [ ] **Step 4: Verify generated-source consistency**

Save hashes, run generation again, and compare hashes:

```bash
sha256sum src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
npm run worker
sha256sum src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js
```

Expected: hashes printed before and after the second generation are identical.

- [ ] **Step 5: Run final verification**

Run:

```bash
bun test src
npm run check
npm run build
```

Expected: all Bun tests pass, Biome and TypeScript checks pass, the package build
completes, and `git diff --check` prints no whitespace errors.

- [ ] **Step 6: Review and commit only lifecycle deliverables**

```bash
git status --short
git diff -- README.md architecture/destroy_flow.md examples/destroy_node/common.ts examples/wasi_multi_threads_channel_node/common.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js docs/superpowers/specs/2026-09-04-worker-destroy-lifecycle-design.md docs/superpowers/plans/2026-09-04-worker-destroy-lifecycle.md
git add README.md architecture/destroy_flow.md examples/destroy_node/common.ts examples/wasi_multi_threads_channel_node/common.ts src/shared_array_buffer/worker_background/worker_blob.ts src/shared_array_buffer/worker_background/worker_background_worker_minify.js docs/superpowers/specs/2026-09-04-worker-destroy-lifecycle-design.md docs/superpowers/plans/2026-09-04-worker-destroy-lifecycle.md
git commit -m "docs(threads): document worker destroy lifecycle"
```

Run:

```bash
git status --short
```

---

## Final Review Gate

- [ ] Confirm every new operation checks `Running` before and after acquiring a registration lock.
- [ ] Confirm no coordinator path awaits Worker readiness while holding `lock[0]`.
- [ ] Confirm every pending request publishes exactly one terminal state and notifies its waiter.
- [ ] Confirm the error/exit sender is captured before any registry removal.
- [ ] Confirm `Destroyed` is the coordinator's final shared-state mutation before close.
- [ ] Confirm only the elected managed requester receives requester-last treatment.
- [ ] Confirm owner-side completion calls coordinator `terminate()` before dropping its reference.
- [ ] Confirm generated artifacts match `worker.ts`.
- [ ] Confirm unrelated dirty files are neither staged nor committed.
