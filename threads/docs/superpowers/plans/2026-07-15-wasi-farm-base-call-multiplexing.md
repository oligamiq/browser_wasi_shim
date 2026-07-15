# WASIFarm Base Call Multiplexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WASIFarm's single base-call mailbox with a bounded, generation-tagged multiplexed transport so concurrent and reentrant `unknown_fn` calls complete safely on one farm.

**Architecture:** Generalize the existing per-fd SharedArrayBuffer request pattern into one reserved system slot plus a fixed pool of user slots. Each caller owns one slot and generation, the Park dispatches handlers without awaiting them inline, and a concurrent free-list allocator gives interleaved requests explicit payload ownership. The library remains v2-only while preserving synchronous public methods and every existing destroy-series API.

**Tech Stack:** TypeScript, SharedArrayBuffer, Atomics, Web Workers, Bun test runner, Vite, Biome, `@bjorn3/browser_wasi_shim`

## Global Constraints

- Farm and references must use the same v2 package version; do not add a v1 compatibility path.
- Preserve public method names `set_park_fds_map`, `call_unknown_fn`, `destroy_park`, `destroy_park_all`, `destroy_with_park`, and `destroy`.
- Every new or changed public class, option, method, and returned transport type must have a DocComment describing affected resources, blocking, idempotency, ownership, errors, and Worker/Park agent requirements.
- Keep public base-call methods synchronous; synchronous callers fail fast when all user slots are occupied.
- Default user slots: 128. Accepted `max_base_calls_limit`: integer values from 1 through 1024. Reserve one additional system slot.
- Operation codes remain `0 = set fd map`, `1 = destroy Park`, and `2 = call unknown function`.
- All cross-agent slot metadata uses `Atomics.store`/`Atomics.load`; plain typed-array metadata assignment is forbidden.
- Permit concurrent `unknown_fn` handlers and out-of-order completion.
- Do not apply a handler-concurrency limit lower than the user-slot count.
- Generation values are 1 through `0x7fffffff`; retire a slot instead of wrapping.
- Arbitrary user Promises are not forcibly cancelled and farm destruction must not wait for them.
- No existing destroy-series function may be removed, renamed, or converted into a deprecated alias.
- Do not publish npm packages or create a release without a separate explicit user request.

## Design-To-Test Matrix

| Design requirement | Required test task |
| --- | --- |
| Attach without resetting allocator/sender | Task 1 `attachment.test.ts` |
| Interleaved payload ownership and reclamation | Task 2 `base_call_allocator.test.ts` |
| Reverse-order response correlation | Task 3 `base_call.test.ts` |
| Wait-before-notify and notify-before-wait | Task 3 `base_call.test.ts` |
| Fail-fast synchronous capacity | Task 3 `base_call.test.ts` |
| Generation reuse and stale completion | Task 3 `base_call.test.ts` |
| Serialized error, codec error, invalid request, OOM | Task 3 `base_call.test.ts` |
| Destroy during writing, ready, and running | Task 3 `base_call.test.ts` |
| Duplicate owner/wire destroy and listener shutdown | Tasks 3-4 |
| Ordered, duplicate-free fd-map registration | Task 4 `farm_base_call.test.ts` |
| Existing destroy-series method scope | Task 4 `farm_base_call.test.ts` |
| Reentrant same-farm Animal construction | Task 4 `base_call_worker.test.ts` |
| Sequential Animals, callback isolation, late completion | Task 5 Worker tests |
| Existing-farm WebShell integration and raw status | Task 6 E2E tests |

---

### Task 1: Preserve Shared State During Attachment

**Files:**
- Modify: `src/shared_array_buffer/allocator.ts:55-84`
- Modify: `src/shared_array_buffer/sender.ts:47-91`
- Modify: `src/shared_array_buffer/fd_close_sender.ts:29-82`
- Create: `src/shared_array_buffer/attachment.test.ts`

**Interfaces:**
- Produces: `AllocatorUseArrayBuffer.init_self(object)` that attaches without resetting headers.
- Produces: `FdCloseSenderUseArrayBuffer.init_self(object)` that attaches without resetting queued notifications.
- Produces: `FdCloseSenderUseArrayBuffer.get_object(): FdCloseSenderUseArrayBufferObject`.
- Consumes: Existing `AllocatorUseArrayBufferObject` and `FdCloseSenderUseArrayBufferObject` structured-clone shapes.

- [ ] **Step 1: Write failing attachment tests**

Create `src/shared_array_buffer/attachment.test.ts` with tests that mutate live shared headers before attachment:

```ts
import assert from "node:assert";
import test from "node:test";
import { AllocatorUseArrayBuffer } from "./allocator.ts";
import { FdCloseSenderUseArrayBuffer } from "./fd_close_sender.ts";

test("allocator attachment does not reset live allocation metadata", () => {
  const owner = new AllocatorUseArrayBuffer(new SharedArrayBuffer(1024));
  const descriptor = new SharedArrayBuffer(8);
  const [pointer, length] = owner.block_write(
    new Uint8Array([1, 2, 3]),
    descriptor,
    0,
  );
  const before = Array.from(new Int32Array(owner.share_arrays_memory, 0, 3));

  const attached = AllocatorUseArrayBuffer.init_self(owner.get_object());

  assert.deepStrictEqual(
    Array.from(new Int32Array(owner.share_arrays_memory, 0, 3)),
    before,
  );
  assert.deepStrictEqual(
    Array.from(new Uint8Array(attached.get_memory(pointer, length))),
    [1, 2, 3],
  );
  owner.free(pointer, length);
});

test("fd-close sender attachment preserves queued notifications", async () => {
  const owner = new FdCloseSenderUseArrayBuffer();
  await owner.send([7], 42);

  const attached = FdCloseSenderUseArrayBuffer.init_self(owner.get_object());

  assert.deepStrictEqual(attached.get(7), [42]);
});

test("oversized bump allocation releases its lock and active count", () => {
  const allocator = new AllocatorUseArrayBuffer(new SharedArrayBuffer(64));
  const descriptor = new SharedArrayBuffer(8);
  assert.throws(
    () => allocator.block_write(new Uint8Array(128), descriptor, 0),
    /bigger than memory/,
  );
  assert.deepStrictEqual(
    allocator.block_write(new Uint8Array([1]), descriptor, 0)[1],
    1,
  );
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `bun test src/shared_array_buffer/attachment.test.ts`

Expected: both tests fail because `init_self()` invokes constructors that store `0, 0, 12` into live headers.

- [ ] **Step 3: Separate create and attach paths**

Add an internal initialization flag without changing the existing one-argument constructor behavior:

```ts
constructor(
  share_arrays_memory: SharedArrayBuffer = new SharedArrayBuffer(10 * 1024 * 1024),
  initialize = true,
) {
  this.share_arrays_memory = share_arrays_memory;
  if (initialize) {
    const view = new Int32Array(this.share_arrays_memory);
    Atomics.store(view, 0, 0);
    Atomics.store(view, 1, 0);
    Atomics.store(view, 2, 12);
  }
}

static init_self(sl: AllocatorUseArrayBufferObject): AllocatorUseArrayBuffer {
  return new AllocatorUseArrayBuffer(sl.share_arrays_memory, false);
}
```

Apply the same explicit `initialize` distinction to `ToRefSenderUseArrayBuffer` and pass `false` from `FdCloseSenderUseArrayBuffer.init_self()`.

Add this public serialization method to `FdCloseSenderUseArrayBuffer`:

```ts
/** Returns the plain structured-clone state without mutating shared memory. */
get_object(): FdCloseSenderUseArrayBufferObject {
  return super.get_object();
}
```

Add the protected `get_object()` implementation to `ToRefSenderUseArrayBuffer`
so it returns `data_size` and `share_arrays_memory`.

Add or update DocComments for each changed constructor and `init_self()` to state that normal construction initializes memory while attachment preserves it.

- [ ] **Step 4: Guarantee lock release on existing write/send errors**

Wrap `async_write`, `block_write`, `async_send`, and `get_data` critical sections in `try/finally`:

```ts
await this.async_lock();
try {
  return this.write_inner(data, memory, ret_ptr);
} finally {
  this.release_lock();
}
```

When existing bump allocation exceeds memory after incrementing active users, decrement the count before throwing. The failing assertion was already added in Step 1.

- [ ] **Step 5: Run focused and regression checks**

Run: `bun test src/shared_array_buffer/attachment.test.ts src/codec/codec.test.ts`

Expected: all attachment and codec tests pass, 0 fail.

Run: `npx biome check src/shared_array_buffer/allocator.ts src/shared_array_buffer/sender.ts src/shared_array_buffer/fd_close_sender.ts src/shared_array_buffer/attachment.test.ts`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared_array_buffer/allocator.ts src/shared_array_buffer/sender.ts \
  src/shared_array_buffer/fd_close_sender.ts \
  src/shared_array_buffer/attachment.test.ts
git commit -m "fix(threads): preserve attached shared state"
```

---

### Task 2: Add The Concurrent Base Payload Allocator

**Files:**
- Create: `src/shared_array_buffer/base_call_allocator.ts`
- Create: `src/shared_array_buffer/base_call_allocator.test.ts`
- Create: `src/shared_array_buffer/test_workers/base_call_allocator_worker.ts`
- Modify: `src/shared_array_buffer/index.ts`

**Interfaces:**
- Produces: `BaseCallAllocatorUseArrayBuffer`.
- Produces: `BaseCallAllocatorUseArrayBufferObject = { share_arrays_memory: SharedArrayBuffer }`, matching the approved cloneable allocator naming.
- Produces methods:
  - `block_write(data: Uint8Array): [pointer: number, length: number]`
  - `async_write(data: Uint8Array): Promise<[pointer: number, length: number]>`
  - `get_memory(pointer: number, length: number): ArrayBuffer`
  - `free(pointer: number, length: number): void`
  - `get_object(): BaseCallAllocatorUseArrayBufferObject`
  - `static init_self(object): BaseCallAllocatorUseArrayBuffer`
- Consumes: SharedArrayBuffer and the existing blocking/async wait-and-CAS lock pattern.

- [ ] **Step 1: Write allocator behavior tests**

Cover exact block reuse, interleaved lifetime, split/coalesce, attachment, duplicate free, bad range, OOM recovery, and async/blocking contention:

```ts
test("free list reuses and coalesces interleaved allocations", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(256);
  const a = allocator.block_write(new Uint8Array(32).fill(1));
  const b = allocator.block_write(new Uint8Array(32).fill(2));
  const c = allocator.block_write(new Uint8Array(32).fill(3));

  allocator.free(...b);
  const reused = allocator.block_write(new Uint8Array(16).fill(4));
  assert.strictEqual(reused[0], b[0]);

  allocator.free(...a);
  allocator.free(...reused);
  allocator.free(...c);
  const merged = allocator.block_write(new Uint8Array(120).fill(5));
  assert.strictEqual(merged[1], 120);
});

test("attachment cannot reset a live free list", () => {
  const owner = new BaseCallAllocatorUseArrayBuffer(256);
  const allocation = owner.block_write(new Uint8Array([9, 8, 7]));
  const attached = BaseCallAllocatorUseArrayBuffer.init_self(owner.get_object());
  assert.deepStrictEqual(
    Array.from(new Uint8Array(attached.get_memory(...allocation))),
    [9, 8, 7],
  );
  attached.free(...allocation);
});

test("zero-length allocation is canonical and allocation-free", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(256);
  assert.deepStrictEqual(allocator.block_write(new Uint8Array()), [0, 0]);
  assert.strictEqual(allocator.get_memory(0, 0).byteLength, 0);
  allocator.free(0, 0);
});

test("out of memory does not poison later allocations", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(128);
  assert.throws(
    () => allocator.block_write(new Uint8Array(256)),
    /out of memory/,
  );
  const allocation = allocator.block_write(new Uint8Array([1]));
  assert.deepStrictEqual(
    Array.from(new Uint8Array(allocator.get_memory(...allocation))),
    [1],
  );
  allocator.free(...allocation);
});

test("invalid and duplicate frees are rejected", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(256);
  const allocation = allocator.block_write(new Uint8Array([1, 2]));
  assert.throws(() => allocator.free(allocation[0], 1), /length/);
  allocator.free(...allocation);
  assert.throws(() => allocator.free(...allocation), /already free/);
  assert.throws(() => allocator.get_memory(255, 8), /range/);
});
```

The allocator Worker fixture uses this body:

```ts
import {
  BaseCallAllocatorUseArrayBuffer,
  type BaseCallAllocatorUseArrayBufferObject,
} from "../base_call_allocator.ts";

self.onmessage = (event: MessageEvent<BaseCallAllocatorUseArrayBufferObject>) => {
  const allocator = BaseCallAllocatorUseArrayBuffer.init_self(event.data);
  self.postMessage({ state: "attempting" });
  try {
    const allocation = allocator.block_write(new Uint8Array([7]));
    allocator.free(...allocation);
    self.postMessage({ state: "done" });
  } catch (error) {
    self.postMessage({ state: "error", error: String(error) });
  }
};
```

The test stores `1` directly into the documented allocator lock word, starts
the Worker with a `.href` URL, waits for `attempting`, verifies no terminal
message arrives during a 20 ms interval, stores `0`, notifies the lock, and
requires `done` within 1 second. It terminates the Worker in `finally`. This
uses the documented SAB layout and adds no production test hook.

- [ ] **Step 2: Run allocator tests to verify RED**

Run: `bun test src/shared_array_buffer/base_call_allocator.test.ts`

Expected: FAIL because `base_call_allocator.ts` does not exist.

- [ ] **Step 3: Implement the bounded free-list layout**

Use this exact metadata layout:

```ts
const HEADER_BYTES = 16;
const BLOCK_HEADER_BYTES = 16;
const MAGIC = 0x42434132;

// allocator header i32 words
const LOCK = 0;
const FIRST_BLOCK = 1;
const ACTIVE_BLOCKS = 2;
const ALLOCATOR_MAGIC = 3;

// block header i32 words, relative to block offset
const BLOCK_SIZE = 0;
const BLOCK_NEXT = 1;
const BLOCK_FREE = 2;
const BLOCK_REQUESTED = 3;
```

Initialize one free block at offset 16. Store aligned payload capacity in `BLOCK_SIZE`, `0` in `BLOCK_NEXT`, `1` in `BLOCK_FREE`, and `0` in `BLOCK_REQUESTED`.

The constructor default is 10 MiB. Accepted sizes are integers divisible by 8
from 64 bytes through `0x7ffffff8`; other values throw before creating a
SharedArrayBuffer. A zero-length write returns `[0, 0]` without changing the
free list, `get_memory(0, 0)` returns an empty `ArrayBuffer`, and `free(0, 0)`
is a no-op. `ACTIVE_BLOCKS` increments exactly once
when a block becomes allocated and decrements exactly once on a valid free.

Implement first-fit scanning under the allocator lock. Return `blockOffset + BLOCK_HEADER_BYTES`. Split when the remainder can hold another block header plus eight payload bytes. On free, scan from `FIRST_BLOCK`, require an exact payload pointer and requested length, reject duplicate free, mark free, and coalesce adjacent free blocks.

Use `Atomics.store`/`load` for allocator and block metadata. For a block with
payload capacity `size`, split only when
`size - alignedRequest >= BLOCK_HEADER_BYTES + 8`; the allocated block keeps
`alignedRequest`, and the remainder starts at
`block + BLOCK_HEADER_BYTES + alignedRequest`. During free, merge with a free
next block, then scan from `FIRST_BLOCK` to find and merge a free previous
block. Copy payload bytes only while the allocator lock is held. Always release
the lock in `finally`.

- [ ] **Step 4: Implement safe create and attach APIs with DocComments**

Normal construction validates a byte length of at least 64 and divisible by 8. `init_self()` validates `MAGIC` but writes no shared metadata. `get_memory()` validates that the requested range belongs to a currently allocated block before returning a copy.

Add DocComments to the exported type, class, constructor, all public methods,
and `init_self()` with ownership and blocking behavior. The malformed size,
duplicate-free, wrong-length, out-of-range, split, coalesce, and two-agent
contention tests are written as part of Step 1 before this implementation.
Run the blocking contender in a Worker fixture so it never blocks the Park/test
agent that owns the asynchronous contender.

- [ ] **Step 5: Verify allocator tests and checks**

Run: `bun test src/shared_array_buffer/base_call_allocator.test.ts`

Expected: all allocator tests pass.

Run: `npx biome check src/shared_array_buffer/base_call_allocator.ts src/shared_array_buffer/base_call_allocator.test.ts && npx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared_array_buffer/base_call_allocator.ts \
  src/shared_array_buffer/base_call_allocator.test.ts \
  src/shared_array_buffer/test_workers/base_call_allocator_worker.ts \
  src/shared_array_buffer/index.ts
git commit -m "feat(threads): add concurrent base payload allocator"
```

---

### Task 3: Implement The V2 Slot Transport

**Files:**
- Create: `src/shared_array_buffer/base_call.ts`
- Create: `src/shared_array_buffer/base_call.test.ts`
- Modify: `src/shared_array_buffer/index.ts`

**Interfaces:**
- Consumes: `BaseCallAllocatorUseArrayBuffer` from Task 2.
- Produces:

```ts
export type BaseCallTransportObject = {
  version: 2;
  userSlotCount: number;
  control: SharedArrayBuffer;
  slots: SharedArrayBuffer;
  allocator: BaseCallAllocatorUseArrayBufferObject;
};

export class BaseCallCapacityError extends Error {}

export enum BaseCallTerminalError {
  Serialized = 1,
  OutOfMemory = 2,
  InvalidRequest = 3,
  Destroyed = 4,
  CodecError = 5,
}

export type BaseCallHandler = (
  opcode: BaseCallOpcode,
  payload: Uint8Array,
) => Promise<Uint8Array | undefined> | Uint8Array | undefined;

export class BaseCallRefUseArrayBuffer {
  static init_self(object: BaseCallTransportObject): BaseCallRefUseArrayBuffer;
  block_call(opcode: BaseCallOpcode, payload: Uint8Array): Uint8Array | undefined;
  async_call(opcode: BaseCallOpcode, payload: Uint8Array): Promise<Uint8Array | undefined>;
}

export class BaseCallParkUseArrayBuffer {
  constructor(handler: BaseCallHandler, options?: {
    maxBaseCalls?: number;
    allocatorBytes?: number;
    onBeginDestroy?: () => void;
  });
  get_object(): BaseCallTransportObject;
  listen(): void;
  destroy(): void;
}
```

All exported types, enums, errors, classes, constructors, and methods in this
interface receive DocComments in this task. The comments state blocking,
ownership, capacity, cancellation, and agent requirements.

- [ ] **Step 1: Write state-machine tests before implementation**

Test concurrent reverse-order completion, fail-fast capacity, slot reuse, remote errors, unknown opcode, notify-before-wait, destruction, and stale generation:

```ts
test("concurrent calls remain correlated when handlers finish in reverse order", async () => {
  const resolvers = new Map<number, (value: Uint8Array) => void>();
  const park = new BaseCallParkUseArrayBuffer(
    (_opcode, payload) => new Promise((resolve) => resolvers.set(payload[0], resolve)),
    { maxBaseCalls: 2, allocatorBytes: 4096 },
  );
  park.listen();
  const ref = BaseCallRefUseArrayBuffer.init_self(structuredClone(park.get_object()));

  const first = ref.async_call(BaseCallOpcode.CallUnknownFn, new Uint8Array([1]));
  const second = ref.async_call(BaseCallOpcode.CallUnknownFn, new Uint8Array([2]));
  await waitUntil(() => resolvers.size === 2, 1_000);
  resolvers.get(2)?.(new Uint8Array([22]));
  resolvers.get(1)?.(new Uint8Array([11]));

  assert.deepStrictEqual(Array.from((await first) ?? []), [11]);
  assert.deepStrictEqual(Array.from((await second) ?? []), [22]);
  park.destroy();
});
```

Define this helper in the test file:

```ts
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
```

Wrap every test that starts a Park in `try/finally` and call `park.destroy()`
in the `finally` block.

Add named tests for:

- `wait-before-notify completes`
- `notify-before-wait completes`
- `capacity fails fast and a later call succeeds`
- `stale generation cannot publish after actual slot reuse`
- `serialized callback error wakes only its caller`
- `allocator OOM publishes an allocation-free terminal error`
- `unsupported result publishes CodecError`
- `circular error cause becomes a bounded serialized error`
- `invalid operation publishes InvalidRequest`
- `destroy cancels writing, ready, and running slots`
- `duplicate owner and wire destroy are idempotent`
- `malformed transport objects are rejected without mutation`

- [ ] **Step 2: Run transport tests to verify RED**

Run: `bun test src/shared_array_buffer/base_call.test.ts`

Expected: FAIL because `base_call.ts` does not exist.

- [ ] **Step 3: Define exact control, slot, opcode, and state constants**

Implement the design values:

```ts
export enum BaseCallOpcode {
  SetParkFdsMap = 0,
  DestroyPark = 1,
  CallUnknownFn = 2,
}

enum TransportLifecycle { Active = 0, Destroying = 1, Destroyed = 2 }
enum SlotState {
  Free = 0,
  Writing = 1,
  Ready = 2,
  Running = 3,
  Done = 4,
  Error = 5,
  Cancelled = 6,
  Retired = 7,
}

const CONTROL_WORDS = 8;
const SLOT_WORDS = 12;
const SYSTEM_SLOT = 0;
const MAX_GENERATION = 0x7fffffff;
```

Validate `maxBaseCalls` as an integer from 1 through 1024. Allocate one system slot plus that many user slots.

Use `BaseCallTerminalError` in slot flags. A serialized callback error uses its
pointer and length. `OutOfMemory`, `InvalidRequest`, `Destroyed`, and
`CodecError` use zero
pointer/length and are reconstructed by the caller without allocating another
payload. Runtime operation values other than 0, 1, and 2 are published through
a user slot and answered with `InvalidRequest`.

`BaseCallRefUseArrayBuffer.init_self()` validates, without writing shared
memory: object version 2; SharedArrayBuffer instances; integer user slot count
1..1024; 32-byte control size; exact slot byte length
`(userSlotCount + 1) * SLOT_WORDS * 4`; matching protocol/count control words;
active/destroying/destroyed lifecycle value; and valid allocator magic. Add one
malformed-object assertion per rule.

- [ ] **Step 4: Implement caller publication and terminal cleanup**

Use a local, non-shared scan hint. Claim a user slot with CAS, advance generation or retire it, allocate request bytes, write every metadata field with `Atomics.store`, and publish with `compareExchange(Writing, Ready)`. Increment and notify request epoch.

`block_call()` throws `BaseCallCapacityError` immediately if no user slot is free. `async_call()` waits on the free-slot epoch only when called explicitly. Both validate generation while waiting, deserialize remote errors, free terminal payloads in `finally`, return the slot to free, and notify the free-slot epoch.

The async free-slot wait captures its epoch before rescanning:

```ts
while (true) {
  const observedFreeEpoch = Atomics.load(control, FREE_SLOT_EPOCH);
  const claimed = tryClaimUserSlot();
  if (claimed !== undefined) return claimed;
  const waiter = Atomics.waitAsync(control, FREE_SLOT_EPOCH, observedFreeEpoch);
  if (waiter.value instanceof Promise) await waiter.value;
}
```

A synchronous system-slot caller uses the same capture/rescan sequence with
`Atomics.wait` inside a retry loop. It throws `Destroyed` if lifecycle leaves
active while waiting.

Every slot waiter follows this exact lost-wakeup-safe loop:

```ts
while (true) {
  const state = Atomics.load(slot, SLOT_STATE);
  const terminal = readTerminalState(state);
  if (terminal !== undefined) return terminal;
  Atomics.wait(slot, SLOT_STATE, state);
}
```

The asynchronous variant uses `Atomics.waitAsync` on the same observed state.

Route runtime opcodes 0 and 1 through the reserved system slot. Route every
other runtime value through a user slot: opcode 2 dispatches `CallUnknownFn`,
and all other values receive `InvalidRequest`.

- [ ] **Step 5: Implement non-blocking Park dispatch and errors**

The dispatcher drains ready slots, claims each with CAS, copies and frees request payloads, and starts `handleSlot()` without awaiting it. It uses this exact
lost-wakeup-safe intake sequence:

```ts
const observedEpoch = Atomics.load(control, REQUEST_EPOCH);
if (scanAndClaimReadySlots()) continue;
const waiter = Atomics.waitAsync(control, REQUEST_EPOCH, observedEpoch);
if (waiter.value instanceof Promise) await waiter.value;
```

Normalize handler errors before strict encoding:

```ts
function boundedErrorString(value: unknown): string {
  try {
    return String(value).slice(0, 65_536);
  } catch {
    return "unprintable error value";
  }
}

function readErrorField(error: Error, key: "name" | "message" | "stack" | "cause"): unknown {
  try {
    return Reflect.get(error, key);
  } catch {
    return `unreadable ${key}`;
  }
}

function normalizeRemoteError(value: unknown): Record<string, string> {
  if (!(value instanceof Error)) {
    return { name: "Error", message: boundedErrorString(value) };
  }
  const normalized: Record<string, string> = {
    name: boundedErrorString(readErrorField(value, "name")),
    message: boundedErrorString(readErrorField(value, "message")),
  };
  const stack = readErrorField(value, "stack");
  const cause = readErrorField(value, "cause");
  if (stack !== undefined) normalized.stack = boundedErrorString(stack);
  if (cause !== undefined) normalized.cause = boundedErrorString(cause);
  return normalized;
}
```

Encode the normal result and normalized error in separate `try` blocks. If
normalization or either strict-codec operation fails, publish allocation-free
`CodecError`.
Malformed request decoding publishes `InvalidRequest`. In all success/error
paths, validate generation and `Running` state before terminal CAS. Free a
newly allocated result if publication loses a cancellation or stale-generation
race. If allocation itself fails, publish `Error` with
`BaseCallTerminalError.OutOfMemory` and zero payload fields.

After one complete slot scan, yield with
`await new Promise((resolve) => setTimeout(resolve, 0))` before scanning again.
A macrotask yield allows I/O, rendering, timers, and Worker messages to run;
`queueMicrotask` is not used because continuous microtasks can starve the event
loop.

- [ ] **Step 6: Implement transport destruction**

Implement one internal
`beginDestroy(origin?: { slotIndex: number; generation: number }): void`.
The owner-side `destroy()` calls it without an origin. Opcode 1 calls it with
the validated running system slot as origin.

The first lifecycle CAS winner cancels every writing, ready, and running slot
except the matching origin. For each slot, reload state and retry until stable:
CAS `Writing -> Cancelled`; CAS `Ready -> Running`, free the Park-owned request,
then store `Cancelled`; or CAS `Running -> Cancelled`. A failed CAS restarts
that slot's loop. Writing payloads remain caller-owned and running handlers
become late completions. It then
publishes `Destroyed`, notifies every slot and both epochs, and finally
publishes `Done` only to a still-matching origin. A losing owner destroy returns
idempotently. A losing wire destroy is cancelled/woken with `Destroyed`, and
`WASIFarmRef.destroy_park()` treats that exact terminal result as successful
idempotent completion rather than throwing.

For wire destruction, asynchronously wait for the origin system slot to change
from `Done` to `Free` using its observed state before stopping the base intake
listener. Owner destruction stops intake after notifications. In both paths,
also invoke every existing fd-listener terminator. Do not wait for user
handlers; late handlers validate, free, and discard their results.

`beginDestroy` invokes `options.onBeginDestroy?.()` exactly once immediately
after the winning lifecycle CAS and before cancellation publication. The outer
`WASIFarmParkUseArrayBuffer` passes a callback that stops only its fd listeners;
it does not call transport `destroy()` recursively.

- [ ] **Step 7: Run focused tests and static checks**

Run: `bun test src/shared_array_buffer/base_call.test.ts src/shared_array_buffer/base_call_allocator.test.ts`

Expected: all tests pass, including reverse completion, capacity, generation, errors, and destruction.

Run: `npx biome check src/shared_array_buffer/base_call.ts src/shared_array_buffer/base_call.test.ts && npx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/shared_array_buffer/base_call.ts \
  src/shared_array_buffer/base_call.test.ts \
  src/shared_array_buffer/index.ts
git commit -m "feat(threads): multiplex WASIFarm base calls"
```

---

### Task 4: Integrate V2 With WASIFarm, Park, And Ref

**Files:**
- Modify: `src/farm.ts:12-136`
- Modify: `src/index.ts:7-12`
- Modify: `src/park.ts:9-51`
- Modify: `src/ref.ts:4-207`
- Modify: `src/shared_array_buffer/park.ts:20-375`
- Modify: `src/shared_array_buffer/ref.ts:18-219`
- Modify: `src/animals.ts:388-439`
- Modify: `src/destroyer_handle.ts:3-91`
- Create: `src/shared_array_buffer/farm_base_call.test.ts`
- Create: `src/shared_array_buffer/test_workers/base_call_outer_worker.ts`
- Create: `src/shared_array_buffer/test_workers/base_call_inner_worker.ts`
- Create: `src/shared_array_buffer/base_call_worker.test.ts`

**Interfaces:**
- Consumes: `BaseCallTransportObject`, `BaseCallRefUseArrayBuffer`, and `BaseCallParkUseArrayBuffer` from Task 3.
- Produces: `WASIFarm` constructor option `max_base_calls_limit?: number`.
- Produces: public idempotent `WASIFarm.destroy(): void`.
- Produces: public export `WASIFarmRefObject` from `src/index.ts`.
- Produces: public export `BaseCallCapacityError` from `src/index.ts` so callers
  can distinguish bounded local backpressure from remote callback errors.
- Preserves all existing destroy-series methods and operation codes.

The exact constructor propagation is:

```ts
new WASIFarm(stdin, stdout, stderr, fds, {
  allocator_size,
  max_fds_limit,
  max_base_calls_limit,
  unknown_fn,
});

new WASIFarmParkUseArrayBuffer(
  fds,
  stdin,
  stdout,
  stderr,
  defaultAllowFds,
  allocator_size,
  max_fds_limit,
  unknown_fn,
  max_base_calls_limit,
);
```

- [ ] **Step 1: Write public and actual-Worker tests against v1**

In `farm_base_call.test.ts`, add constructor range, owner-side destroy,
post-destroy `get_ref`, and retained destroy-series scope tests.

Use this helper so the tests instantiate the real public farm:

```ts
import {
  File,
  OpenFile,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "../farm.ts";

function createTestFarm(
  unknown_fn?: (arg: unknown) => Promise<unknown> | unknown,
  max_base_calls_limit = 4,
): WASIFarm {
  return new WASIFarm(
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    [new PreopenDirectory("/", new Map())],
    { unknown_fn, max_base_calls_limit },
  );
}
```

Create the outer and inner Worker fixtures with this exact contract:

```ts
type WorkerRequest = { wasiRef: WASIFarmRefObject };
type WorkerResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };
```

Each Worker reconstructs `new WASIFarmAnimal(wasiRef, [], [])`, invokes
`call_unknown_fn(0, { kind: "outer" | "inner" })`, posts `WorkerResult`, and
catches errors into `{ ok: false, error: String(error) }`.

Add `runWorker` to `base_call_worker.test.ts`:

```ts
function runWorker(
  worker: Worker,
  request: WorkerRequest,
  timeoutMs = 5_000,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
  const timer = setTimeout(
      () => reject(new Error(`Worker timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message));
    };
    worker.onmessageerror = () => {
      clearTimeout(timer);
      reject(new Error("Worker message could not be decoded"));
    };
    worker.postMessage(request);
  });
}
```

Construct Worker URLs with
`new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href`
and the corresponding inner URL. The `.href` string avoids runtime-specific
URL cloning differences.

Add the original deadlock regression: the outer `unknown_fn` handler starts the
inner Worker with the same `farm.get_ref()`, awaits `runWorker(inner, ...)`, and
returns only after the inner call reports `inner-ok`. Always terminate both
Workers and call `farm.destroy()` in `finally`.

- [ ] **Step 2: Run the integration test to verify RED**

Run: `bun test src/shared_array_buffer/farm_base_call.test.ts src/shared_array_buffer/base_call_worker.test.ts --timeout 5000`

Expected: the Worker test fails by timeout because the outer v1 call owns the
base mailbox while the inner Animal waits in `set_park_fds_map`; the public
farm test fails because option validation and `WASIFarm.destroy()` do not yet
exist. Record both RED results before replacing v1.

- [ ] **Step 3: Replace the v1 base mailbox in Park and Ref**

Change the abstract serialized type to cloneable data rather than a runtime
`FdCloseSender` interface:

```ts
export type WASIFarmRefObject<FdCloseReceiverObject = unknown> = {
  stdin: number | undefined;
  stdout: number | undefined;
  stderr: number | undefined;
  fd_close_receiver: FdCloseReceiverObject;
  default_fds: Array<number>;
};
```

Change the cloneable ref shape to include:

```ts
export type WASIFarmRefUseArrayBufferObject =
  WASIFarmRefObject<FdCloseSenderUseArrayBufferObject> & {
  allocator: AllocatorUseArrayBufferObject;
  baseCall: BaseCallTransportObject;
  lock_fds: SharedArrayBuffer;
  fds_len_and_num: SharedArrayBuffer;
  fd_func_sig: SharedArrayBuffer;
  fd_close_receiver: FdCloseSenderUseArrayBufferObject;
};
```

Keep `WASIFarmPark.get_ref(): WASIFarmRefObject` using the default `unknown`
parameter. The concrete return type is assignable to it. Add this compile-time
and runtime assertion:

```ts
const concrete = farm.get_ref();
const publicRef: WASIFarmRefObject = structuredClone(concrete);
assert.deepStrictEqual(publicRef.default_fds, concrete.default_fds);
```

Remove `base_func_util` and all v1 lock/call/wait helpers. Implement the three public base methods by encoding their current payloads and calling the v2 ref:

- `set_park_fds_map`: payload bytes are the native little-endian byte view of
  `Uint32Array([this.id, ...fds])`.
- `destroy_park`: empty payload on system opcode 1.
- `call_unknown_fn`: strict-codec bytes on user opcode 2.

The Park handler decodes these payloads, commits fd mappings synchronously without the fixed one-second sleep, deduplicates IDs, invokes `unknown_fn` concurrently, and returns strict-codec bytes or `undefined`.

Construct `BaseCallParkUseArrayBuffer` with
`onBeginDestroy: () => this.stopFdListeners()`. `stopFdListeners()` invokes and
clears only `listen_fds_terminator` entries. The base transport owns and stops
its own intake listener, so neither callback calls the other's `destroy()`.

Convert fd-map words to bytes before `block_call`:

```ts
const words = new Uint32Array([this.id, ...fds]);
const payload = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
this.baseCall.block_call(BaseCallOpcode.SetParkFdsMap, payload);
```

Export `type WASIFarmRefObject` and `BaseCallCapacityError` from `src/index.ts`
so Worker fixtures and downstream packages do not depend on private
declarations. Keep transport classes, opcodes, and terminal status enums
internal to `src/shared_array_buffer`.

- [ ] **Step 4: Add owner-side farm destruction**

Add `abstract destroy(): void` to `WASIFarmPark`. Implement `WASIFarm.destroy()` as:

```ts
/**
 * Destroys this farm and its exclusively owned Park.
 *
 * The operation is idempotent. It rejects new base calls, wakes blocked
 * callers, and does not wait for unresolved user callbacks. It does not
 * terminate external Workers that merely hold a farm reference.
 */
destroy(): void {
  this.park?.destroy();
  this.park = null;
}
```

Keep `get_ref()` rejecting after destruction.

- [ ] **Step 5: Complete required DocComments without renaming APIs**

Write or update DocComments for:

- `WASIFarm` constructor and `max_base_calls_limit`.
- `WASIFarm.destroy()`.
- `WASIFarmPark.destroy()`.
- `WASIFarmRef.set_park_fds_map`, `destroy_park`, and `call_unknown_fn`.
- `WASIFarmAnimal.destroy`, `destroy_park`, `destroy_park_all`, and `destroy_with_park`.
- `DestroyerHandle.destroy()`.
- Every new v2 cloneable object type.

Each comment must explicitly state the affected object, blocking behavior, idempotency, and whether Animals/Parks are also destroyed.

- [ ] **Step 6: Run library integration and regression tests**

Run: `bun test src/shared_array_buffer/farm_base_call.test.ts src/shared_array_buffer/base_call_worker.test.ts src/shared_array_buffer/*.test.ts src/codec/codec.test.ts --timeout 5000`

Expected: all tests pass.

Run: `npm run check`

Expected: Biome and TypeScript exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/farm.ts src/index.ts src/park.ts src/ref.ts src/animals.ts \
  src/destroyer_handle.ts src/shared_array_buffer/park.ts \
  src/shared_array_buffer/ref.ts \
  src/shared_array_buffer/farm_base_call.test.ts \
  src/shared_array_buffer/base_call_worker.test.ts \
  src/shared_array_buffer/test_workers
git commit -m "feat(threads): integrate multiplexed farm calls"
```

---

### Task 5: Complete Worker Coverage And Package Metadata

**Files:**
- Modify: `src/shared_array_buffer/test_workers/base_call_outer_worker.ts`
- Modify: `src/shared_array_buffer/test_workers/base_call_inner_worker.ts`
- Modify: `src/shared_array_buffer/base_call_worker.test.ts`
- Modify: `package.json:5-13`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: public `WASIFarm`, `WASIFarmAnimal`, `WASIFarm.get_ref()`, and `WASIFarm.destroy()` from Task 4.
- Consumes: the actual-Worker reentrant regression created RED-first in Task 4.
- Produces package script: `"test": "bun test src"`.

- [ ] **Step 1: Add sequential, error, and destroy Worker cases**

Add tests that:

- Run two Animals sequentially against one farm.
- Complete two unknown callbacks in reverse order.
- Propagate a callback throw to only its caller.
- Destroy the farm while calls are running, wake callers, then ignore late callback completion.
- Terminate a caller Worker while it owns a base slot, confirm the slot remains
  occupied, call `farm.destroy()`, and confirm all transport slots are
  cancelled or free with no retained response payload.

Capacity is covered deterministically by Task 3's transport test without
starting 129 operating-system Workers.

- [ ] **Step 2: Run the expanded Worker tests**

Run: `bun test src/shared_array_buffer/base_call_worker.test.ts --timeout 5000`

Expected: the reentrant, sequential, reverse-order, callback-error, and destroy
cases all pass. Each test uses `runWorker` from Task 4 and terminates every
Worker/farm in `finally`.

- [ ] **Step 3: Add the test script and public documentation**

Add `"test": "bun test src"` to `package.json`.

Because the reference wire format is intentionally v2-only, update the package
version without creating a tag or publishing:

```bash
npm version 0.4.0 --no-git-tag-version
```

Expected: `package.json` and `package-lock.json` both report version `0.4.0`.

Update `README.md` to document:

- Concurrent/out-of-order `unknown_fn` behavior.
- `max_base_calls_limit` default and range.
- Fail-fast capacity semantics.
- Worker/Park agent requirement.
- `WASIFarm.destroy()` and retained destroy-series meanings.

- [ ] **Step 4: Run the complete library verification**

Run: `npm test`

Expected: all tests pass with no timeout.

Run: `npm run check && npm run build`

Expected: Biome, TypeScript, worker bundle, Vite build, declaration generation, and post-build processing exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/shared_array_buffer/test_workers \
  src/shared_array_buffer/base_call_worker.test.ts package.json \
  package-lock.json README.md
git commit -m "test(threads): cover reentrant farm calls"
```

---

### Task 6: Replace The WebShell Isolated-Farm Workaround

**Repositories:**
- Library source: `/home/oligami/projects/browser_wasi_shim/threads`
- rubrc worktree: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi`

**Files:**
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/lib/src/child_process_bridge.ts`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/page/src/xterm.tsx`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/scripts/vfs_debug_shell_worker.ts`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/scripts/vfs_debug_cargo_run_test.ts`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/scripts/vfs_debug_cargo_add_test.ts`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/scripts/vfs_debug_cargo_info_test.ts`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/scripts/vfs_debug_cargo_pipe_test.ts`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/scripts/vfs_child_process_bridge_test.ts`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/docs/superpowers/specs/2026-07-13-cargo-run-wasi-execution-design.md`

**Interfaces:**
- Consumes: v2 `WASIFarm.get_ref()` and multiplexed base calls from Tasks 3-5.
- Restores: one existing farm shared by parent VFS and child Animals.
- Removes: per-child `WASIFarm`, private `park` access, and per-request farm disposal.

- [ ] **Step 1: Build and install a local package for downstream tests**

From the library repository:

```bash
npm run build
npm pack --pack-destination /tmp/opencode
```

Expected: `/tmp/opencode/oligami-browser_wasi_shim-threads-0.4.0.tgz` is created. Do not publish it.

Install it independently in every rubrc package-resolution context without
saving dependency metadata or lockfiles:

```bash
npm install --no-save --package-lock=false \
  /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.0.tgz
npm install --prefix lib --no-save --package-lock=false \
  /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.0.tgz
npm install --prefix page --no-save --package-lock=false \
  /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.0.tgz
npm install --prefix page/src/worker_process/vfs_bindings \
  --no-save --package-lock=false \
  /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.0.tgz
```

Read each physical installation directly because the still-unpublished
manifests intentionally require incompatible 0.3.x ranges:

```bash
node -p "require('./node_modules/@oligami/browser_wasi_shim-threads/package.json').version"
node -p "require('./lib/node_modules/@oligami/browser_wasi_shim-threads/package.json').version"
node -p "require('./page/node_modules/@oligami/browser_wasi_shim-threads/package.json').version"
node -p "require('./page/src/worker_process/vfs_bindings/node_modules/@oligami/browser_wasi_shim-threads/package.json').version"
```

Expected: every command prints `0.4.0`.
Keep any pre-existing root `package-lock.json` change unstaged and out of
commits.

- [ ] **Step 2: Add failing assertions for the final architecture**

Extend child bridge tests to assert:

- `getWasiRef()` is called lazily and its ref is passed directly to each child Worker.
- No child `WASIFarm` is constructed.
- No private `park` field or `destroy()` callback is used.
- Two sequential children reuse the same parent farm.
- Host-retained runner error bytes never exceed 64 KiB.

Extend the Cargo run E2E with a second project/command that exits 7 and assert the complete command-return metadata reports 7.

Run: `deno test --no-lock --node-modules-dir=manual -A scripts/vfs_child_process_bridge_test.ts`

Expected: FAIL because commit `28ce101` still constructs isolated child sessions.

- [ ] **Step 3: Restore the existing-farm bridge API**

Replace session creation with:

```ts
export type ChildProcessBridgeOptions = {
  getWasiRef: () => unknown;
  workerUrl: string | URL;
  filesystemRoot: Directory;
  uploadTimeoutMs: number;
  executionTimeoutMs: number;
  createWorker?: (url: string | URL, options: WorkerOptions) => ChildWorker;
  timers?: ChildProcessTimers;
};
```

This keeps the existing worker URL, filesystem snapshot root, timeout values,
fake-worker signature, and deterministic timer injection unchanged. Replace
only `createWasiSession` with `getWasiRef`, and delete
`ChildProcessWasiSession` plus `createChildProcessWasiSession`.

At run time, post `options.getWasiRef()` to the child Worker. Remove isolated farm construction, copied descriptor wrappers, private `park` casts, listener-promise handling, and session disposal. Continue terminating the request Worker in every terminal path.

Encode runner errors once and truncate retained bytes to 64 KiB before storing completed metadata.

- [ ] **Step 4: Restore browser and Deno routing to the parent farm**

In `xterm.tsx`, construct the bridge with:

```ts
const childProcessBridge = createChildProcessBridge({
  getWasiRef: () => farm.get_ref(),
  workerUrl: new URL(
    "./worker_process/vfs_bindings/child_process_worker.ts",
    import.meta.url,
  ),
  filesystemRoot: root_dir.dir,
  uploadTimeoutMs: 30000,
  executionTimeoutMs: 120000,
});
```

Use the corresponding existing farm and root in each Deno harness. Do not create a second farm or a fresh root wrapper for child execution.

- [ ] **Step 5: Tighten prompt and raw-status assertions**

Change the debug shell driver so command completion requires this order:

1. `[vfs-debug] command:return` for the active command.
2. A subsequent shell prompt at the end of buffered output.

Do not treat an arbitrary interior `" $ "` substring as completion.

Assert the nonzero test target returns exact status 7 through Cargo/VFS/host, not merely that its output appears.

- [ ] **Step 6: Update the WebShell design amendment**

Document that the library now multiplexes base calls on one farm, which removes the listener deadlock without an isolated farm. State that stdio, fd mapping, allocator ownership, and the filesystem root are all provided by the existing farm ref. Remove the isolated-farm/private-destroy concern from the design.

- [ ] **Step 7: Run WebShell E2E and regressions**

Run:

```bash
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_run_test.ts
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_add_test.ts
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_info_test.ts
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_pipe_test.ts
deno test --no-lock --node-modules-dir=manual -A scripts/vfs_child_process_bridge_test.ts \
  scripts/vfs_child_process_import_test.ts \
  scripts/vfs_http_bridge_test.ts \
  scripts/vfs_http_import_test.ts \
  scripts/vfs_build_script_test.ts
cargo test -p vfs --lib
```

Expected: all commands pass; Cargo run covers status 0 and exact status 7, argument propagation, shared filesystem changes, command return, and prompt return.

- [ ] **Step 8: Commit only downstream source and tests**

This commit is a local-integration commit and is not mergeable until Task 8
updates all dependency constraints and lockfiles after an explicitly authorized
0.4.0 publication. Do not commit the local package installation,
`package-lock.json`, or temporary Cargo Wasm artifact.

```bash
git add lib/src/child_process_bridge.ts page/src/xterm.tsx \
  scripts/vfs_debug_shell_worker.ts scripts/vfs_debug_cargo_run_test.ts \
  scripts/vfs_debug_cargo_add_test.ts scripts/vfs_debug_cargo_info_test.ts \
  scripts/vfs_debug_cargo_pipe_test.ts \
  scripts/vfs_child_process_bridge_test.ts \
  docs/superpowers/specs/2026-07-13-cargo-run-wasi-execution-design.md
git commit -m "fix(vfs): reuse multiplexed WASI farm"
```

---

### Task 7: Final Artifact And Cross-Repository Verification

**Files:**
- Modify generated library files under `dist/` only through `npm run build`.
- Modify generated rubrc VFS bindings/artifacts only through existing build scripts.
- Verify both repository worktrees contain no accidental package-lock or scratch-file commits.

**Interfaces:**
- Consumes: completed library and rubrc integration.
- Produces: validated package artifacts and final verification evidence.

- [ ] **Step 1: Run clean library verification**

Run from the library repository:

```bash
npm test
npm run check
npm run build
npm pack --dry-run
git diff --check
```

Expected: all tests/checks pass; package dry-run includes `dist` and `src`; no private rubrc files appear.

- [ ] **Step 2: Verify generated declarations expose documented APIs**

Assert `dist/index.d.ts` contains:

- `max_base_calls_limit?: number`
- `WASIFarm.destroy(): void`
- Existing destroy-series methods
- exported `WASIFarmRefObject` and `BaseCallCapacityError`
- DocComments for those exports, all changed public methods, and the
  `max_base_calls_limit` option

Run: `npx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 3: Rebuild rubrc VFS and Cargo artifacts**

Verify `/home/oligami/projects/cargo/.worktrees/cargo-run-wasi-spawn`
is at `b4fb942df23088db30ca2ac80590ec933212380b`, then run there:

```bash
WASI_SDK_PATH=/opt/wasi-sdk \
WASI_SYSROOT=/opt/wasi-sdk/share/wasi-sysroot \
CC_wasm32_wasip1_threads=/opt/wasi-sdk/bin/clang \
CXX_wasm32_wasip1_threads=/opt/wasi-sdk/bin/clang++ \
AR_wasm32_wasip1_threads=/opt/wasi-sdk/bin/llvm-ar \
CFLAGS_wasm32_wasip1_threads='--target=wasm32-wasip1-threads --sysroot=/opt/wasi-sdk/share/wasi-sysroot -pthread' \
CXXFLAGS_wasm32_wasip1_threads='--target=wasm32-wasip1-threads --sysroot=/opt/wasi-sdk/share/wasi-sysroot -pthread' \
RUSTFLAGS='-Cpanic=unwind -Cllvm-args=-wasm-use-legacy-eh=false' \
cargo +nightly build -r --bin cargo --target wasm32-wasip1-threads -Zbuild-std

wasm-opt -Oz \
  target/wasm32-wasip1-threads/release/cargo.wasm \
  -o /home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/crates/vfs/cargo_opt.wasm
```

Run in the rubrc worktree:

```bash
sha256sum crates/vfs/cargo_opt.wasm
bun run vfs:build
wasm-tools validate dist/vfs.core.wasm
wasm-tools validate page/src/worker_process/vfs_bindings/vfs.core.wasm
cmp -s dist/vfs.core.wasm page/src/worker_process/vfs_bindings/vfs.core.wasm
cmp -s crates/vfs/wit/vfs-host.wit crates/vfs-rustc-twice/wit/vfs-host.wit
sha256sum dist/vfs.core.wasm page/src/worker_process/vfs_bindings/vfs.core.wasm
```

Expected: the Cargo build and VFS build succeed, both Wasm validations and
both byte comparisons exit 0, and the two VFS core SHA-256 values are equal.

`bun run vfs:build` recreates the generated-bindings package and runs its
normal install against the still-unpublished `^0.3` constraint. Reinstall the
local v2 tarball there immediately afterward:

```bash
npm install --prefix page/src/worker_process/vfs_bindings \
  --no-save --package-lock=false \
  /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.0.tgz
node -p "require('./node_modules/@oligami/browser_wasi_shim-threads/package.json').version"
node -p "require('./lib/node_modules/@oligami/browser_wasi_shim-threads/package.json').version"
node -p "require('./page/node_modules/@oligami/browser_wasi_shim-threads/package.json').version"
node -p "require('./page/src/worker_process/vfs_bindings/node_modules/@oligami/browser_wasi_shim-threads/package.json').version"
```

Expected: all four contexts resolve 0.4.0 before any final E2E starts.

Do not hand-edit generated JavaScript or Wasm.

- [ ] **Step 4: Run final downstream verification from freshly rebuilt artifacts**

Run in the Cargo worktree:

```bash
cargo test -p cargo-util wasi_exec_replace_uses_streaming_spawn_without_changing_output_mode
cargo test -p cargo-util write_atomic
rustfmt --edition 2024 --check crates/cargo-util/src/process_builder.rs
git diff --check
```

Run in the rubrc worktree:

```bash
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_run_test.ts
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_add_test.ts
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_info_test.ts
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_pipe_test.ts
deno test --no-lock --node-modules-dir=manual -A \
  scripts/vfs_child_process_import_test.ts \
  scripts/vfs_child_process_bridge_test.ts \
  scripts/vfs_http_bridge_test.ts \
  scripts/vfs_http_import_test.ts \
  scripts/vfs_build_script_test.ts
cargo test -p vfs --lib
cargo fmt -p vfs -- --check
git diff --check
```

Expected: all pass from the rebuilt artifacts without isolated farm creation or private Park access.

- [ ] **Step 5: Review version and publication boundary**

The wire format is v2-only and therefore requires a `0.4.0` library release before rubrc can replace its registry dependency constraints and lockfiles. Do not publish or create that release in this plan. Run `git rev-parse HEAD` and
`sha256sum /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.0.tgz`, then record
both values in the task report so publication can be requested separately.

- [ ] **Step 6: Commit the tracked rubrc generated artifacts**

The library `dist/` directory is not tracked and must not be committed. In
rubrc, stage only the tracked generated files
`crates/vfs/cargo_opt.wasm` and
`page/src/worker_process/vfs_bindings/vfs.js` after confirming both came from
the successful build in Steps 3-4. Never stage temporary root
`package-lock.json` changes or `/tmp/opencode` outputs.

```bash
git add crates/vfs/cargo_opt.wasm \
  page/src/worker_process/vfs_bindings/vfs.js
git commit -m "build(vfs): update Cargo run artifacts"
```

After committing, run `git status --short`. Expected: only the pre-existing
root `package-lock.json` modification remains. If another tracked generated
file changed, do not stage it until its generator output is explained and its
focused check passes.

---

### Task 8: Update Rubrc Dependencies After An Authorized 0.4.0 Publication

**Execution gate:** Do not execute this task until the user separately
authorizes publication and `npm view @oligami/browser_wasi_shim-threads@0.4.0 version`
prints `0.4.0`.

**Files:**
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/package.json`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/lib/package.json`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/page/package.json`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/page/src/worker_process/vfs_bindings/package.json`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/package-lock.json`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/bun.lockb`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/lib/package-lock.json`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/page/package-lock.json`
- Modify: `/home/oligami/projects/rubrc/.worktrees/cargo-run-wasi/page/src/worker_process/vfs_bindings/bun.lock`

**Interfaces:**
- Consumes: registry package `@oligami/browser_wasi_shim-threads@0.4.0`.
- Produces: a clean-installable, mergeable rubrc branch using v2 in every
  package-resolution context.

- [ ] **Step 1: Update every dependency constraint**

Set these exact values:

- Root `package.json`: `"@oligami/browser_wasi_shim-threads": "^0.4.0"`
- `lib/package.json`: `"@oligami/browser_wasi_shim-threads": "^0.4.0"`
- `page/package.json`: `"@oligami/browser_wasi_shim-threads": "^0.4.0"`
- Generated bindings `package.json`: `"@oligami/browser_wasi_shim-threads": "^0.4.0"`

- [ ] **Step 2: Regenerate all active lockfiles from the registry**

Run in the rubrc worktree:

```bash
npm install --package-lock-only
npm install --prefix lib --package-lock-only
npm install --prefix page --package-lock-only
bun install
bun install --cwd page/src/worker_process/vfs_bindings
```

Expected: all commands resolve 0.4.0 from the npm registry, not a local file.

- [ ] **Step 3: Verify every resolution context**

Run:

```bash
npm ls @oligami/browser_wasi_shim-threads
npm ls --prefix lib @oligami/browser_wasi_shim-threads
npm ls --prefix page @oligami/browser_wasi_shim-threads
npm ls --prefix page/src/worker_process/vfs_bindings \
  @oligami/browser_wasi_shim-threads
```

Expected: every listed package is version 0.4.0 and no 0.3.x copy remains.

- [ ] **Step 4: Run clean registry-backed downstream verification**

Run the complete rubrc command block from Task 7 Step 4 without the locally
packed tarball installed.

Expected: all E2Es, bridge tests, Rust tests, formatting, and diff checks pass.

- [ ] **Step 5: Commit dependency metadata**

```bash
git add package.json package-lock.json bun.lockb \
  lib/package.json lib/package-lock.json \
  page/package.json page/package-lock.json \
  page/src/worker_process/vfs_bindings/package.json \
  page/src/worker_process/vfs_bindings/bun.lock
git commit -m "chore: require multiplexed WASI farm"
```
