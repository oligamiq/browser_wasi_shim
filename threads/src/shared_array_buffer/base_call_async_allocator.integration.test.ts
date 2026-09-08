import assert from "node:assert/strict";
import test from "node:test";
import { encodeStrictJsonValue } from "../codec/index.ts";
import {
  BaseCallOpcode,
  BaseCallParkUseArrayBuffer,
  BaseCallRefUseArrayBuffer,
  type BaseCallTransportObject,
  baseCallTestHooks,
} from "./base_call.ts";
import { BaseCallAllocatorUseArrayBuffer } from "./base_call_allocator.ts";

const BASE = 12;
const FREE = 0;
const READY = 2;
const RUNNING = 3;
const DONE = 4;
const ERROR = 5;
const CANCELLED = 6;
const identity = { slotIndex: 1, generation: 1 };

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    assert(performance.now() < deadline, "condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function contention(object: BaseCallTransportObject) {
  const words = new Int32Array(object.allocator.share_arrays_memory);
  const originalWait = Atomics.wait;
  let blockingWaits = 0;
  Atomics.wait = ((
    view: Int32Array,
    index: number,
    value: number,
    timeout?: number,
  ) => {
    if (view.buffer === words.buffer) {
      blockingWaits++;
      throw new TypeError("Atomics.wait forbidden on browser main thread");
    }
    return originalWait(view, index, value, timeout);
  }) as typeof Atomics.wait;
  const unlock = () => {
    Atomics.store(words, 0, 0);
    Atomics.notify(words, 0);
  };
  return {
    words,
    lock: () => assert.equal(Atomics.compareExchange(words, 0, 0, 1), 0),
    unlock,
    assertNonblocking: () => assert.equal(blockingWaits, 0),
    restore: () => {
      unlock();
      Atomics.wait = originalWait;
    },
  };
}

async function reclaimed(object: BaseCallTransportObject): Promise<void> {
  const words = new Int32Array(object.allocator.share_arrays_memory);
  await until(() => Atomics.load(words, 1) === 0);
  const allocator = BaseCallAllocatorUseArrayBuffer.init_self(object.allocator);
  const payload = new Uint8Array(words.byteLength - Atomics.load(words, 6));
  const allocation = await allocator.async_write(payload);
  assert.equal(allocation[1], payload.byteLength);
  await allocator.async_free(...allocation);
  assert.equal(Atomics.load(words, 1), 0);
  assert.equal(Atomics.load(new Int32Array(object.slots), BASE), FREE);
}

function parkAllocator(park: BaseCallParkUseArrayBuffer) {
  return (park as unknown as { allocator: BaseCallAllocatorUseArrayBuffer })
    .allocator;
}

// Hold the real allocator lock between copy and free in either implementation.
function lockAfterRead(
  allocator: BaseCallAllocatorUseArrayBuffer,
  afterRead: () => void,
): void {
  const read = allocator.get_memory.bind(allocator);
  const asyncRead = allocator.async_get_memory.bind(allocator);
  allocator.get_memory = (...args) => {
    const result = read(...args);
    afterRead();
    return result;
  };
  allocator.async_get_memory = async (...args) => {
    const result = await asyncRead(...args);
    afterRead();
    return result;
  };
}

for (const stage of ["read", "free"] as const) {
  for (const cancel of [false, true]) {
    test(`main-thread request ${stage} contention${cancel ? " with cancellation" : ""}`, async () => {
      let handled = 0;
      const park = new BaseCallParkUseArrayBuffer(
        (_opcode, payload) => {
          handled++;
          return payload;
        },
        { maxBaseCalls: 1, allocatorBytes: 1024 },
      );
      const object = park.get_object();
      const slots = new Int32Array(object.slots);
      const ref = BaseCallRefUseArrayBuffer.init_self(object);
      const call = ref.async_call(
        BaseCallOpcode.CallUnknownFn,
        new Uint8Array([7]),
      );
      const outcome = call.then(
        (value) => value,
        (error) => error,
      );
      await until(() => Atomics.load(slots, BASE) === READY);
      const lock = contention(object);
      let held = false;
      const hold = () => {
        lock.lock();
        held = true;
      };
      if (stage === "read") hold();
      else lockAfterRead(parkAllocator(park), hold);
      try {
        park.listen();
        await until(() => held);
        assert.equal(Atomics.load(slots, BASE), RUNNING);
        assert.equal(handled, 0);
        if (cancel) {
          park.destroy();
          assert.equal(Atomics.load(slots, BASE), CANCELLED);
          const reason = await outcome;
          assert(reason instanceof Error);
          assert.equal(reason.name, "BaseCallDestroyedError");
          assert.equal(Atomics.load(slots, BASE), FREE);
          // A cancelled caller clears metadata before the Park resumes its read/free.
          assert.equal(Atomics.load(slots, BASE + 4), 0);
        }
        lock.unlock();
        if (!cancel) assert.deepEqual(await outcome, new Uint8Array([7]));
        await reclaimed(object);
        assert.equal(handled, cancel ? 0 : 1);
        lock.assertNonblocking();
      } finally {
        lock.restore();
        park.destroy();
        await outcome;
      }
    });
  }
}

for (const fails of [false, true]) {
  test(`main-thread ${fails ? "error" : "result"} allocation contention`, async () => {
    let held = false;
    const park = new BaseCallParkUseArrayBuffer(
      () => {
        lock.lock();
        held = true;
        if (fails) throw new TypeError("remote failure");
        return new Uint8Array([9]);
      },
      { maxBaseCalls: 1, allocatorBytes: 4096 },
    );
    const object = park.get_object();
    const lock = contention(object);
    const ref = BaseCallRefUseArrayBuffer.init_self(object);
    park.listen();
    const call = ref.async_call(
      BaseCallOpcode.CallUnknownFn,
      new Uint8Array([1]),
    );
    const outcome = call.then(
      (value) => value,
      (error) => error,
    );
    try {
      await until(() => held);
      lock.unlock();
      const result = await outcome;
      if (fails) {
        assert(result instanceof TypeError);
        assert.equal(result.message, "remote failure");
      } else assert.deepEqual(result, new Uint8Array([9]));
      await reclaimed(object);
      lock.assertNonblocking();
    } finally {
      lock.restore();
      park.destroy();
      await outcome;
    }
  });
}

for (const state of [DONE, ERROR]) {
  for (const stage of ["read", "free", "free failure"] as const) {
    test(`main-thread terminal ${state} ${stage} retains ownership until cleanup`, async () => {
      const park = new BaseCallParkUseArrayBuffer(() => undefined, {
        maxBaseCalls: 1,
        allocatorBytes: 4096,
      });
      const object = park.get_object();
      const slots = new Int32Array(object.slots);
      const ref = BaseCallRefUseArrayBuffer.init_self(object);
      const internal = ref as unknown as {
        allocator: BaseCallAllocatorUseArrayBuffer;
        waitForTerminalAsync(
          slotIdentity: typeof identity,
          opcode: BaseCallOpcode,
        ): Promise<Uint8Array | undefined>;
      };
      const payload =
        state === DONE
          ? new Uint8Array([8])
          : encodeStrictJsonValue({
              name: "TypeError",
              message: "terminal failure",
            });
      const allocation = internal.allocator.block_write(payload);
      Atomics.store(slots, BASE + 1, 1);
      Atomics.store(slots, BASE + 3, 1);
      Atomics.store(slots, BASE + (state === DONE ? 6 : 8), allocation[0]);
      Atomics.store(slots, BASE + (state === DONE ? 7 : 9), allocation[1]);
      Atomics.store(slots, BASE, state);
      const lock = contention(object);
      let held = false;
      const hold = () => {
        lock.lock();
        held = true;
      };
      if (stage === "read") hold();
      else if (stage === "free") lockAfterRead(internal.allocator, hold);
      else {
        const free = internal.allocator.free.bind(internal.allocator);
        const asyncFree = internal.allocator.async_free.bind(
          internal.allocator,
        );
        internal.allocator.free = (...args) => {
          free(...args);
          throw new Error("free failed");
        };
        internal.allocator.async_free = async (...args) => {
          await asyncFree(...args);
          throw new Error("free failed");
        };
      }
      const call = internal.waitForTerminalAsync(
        identity,
        BaseCallOpcode.CallUnknownFn,
      );
      const outcome = call.then(
        (value) => value,
        (error) => error,
      );
      try {
        if (stage !== "free failure") {
          await until(() => held);
          assert.equal(Atomics.load(slots, BASE), state);
          park.destroy();
          assert.equal(Atomics.load(slots, BASE), state);
          lock.unlock();
        }
        const result = await outcome;
        if (stage === "free failure") {
          assert(result instanceof Error);
          assert.equal(result.message, "free failed");
        } else if (state === ERROR) {
          assert(result instanceof TypeError);
          assert.equal(result.message, "terminal failure");
        } else assert.deepEqual(result, new Uint8Array([8]));
        await reclaimed(object);
        lock.assertNonblocking();
      } finally {
        lock.restore();
        park.destroy();
        await outcome;
      }
    });
  }
}

test("main-thread publish rollback during destroy waits for async free", async () => {
  const park = new BaseCallParkUseArrayBuffer(() => undefined, {
    maxBaseCalls: 1,
    allocatorBytes: 1024,
  });
  const object = park.get_object();
  const lock = contention(object);
  const ref = BaseCallRefUseArrayBuffer.init_self(object);
  let held = false;
  baseCallTestHooks.beforeRequestPublication = () => {
    baseCallTestHooks.beforeRequestPublication = undefined;
    lock.lock();
    park.destroy();
    held = true;
  };
  const call = ref.async_call(
    BaseCallOpcode.CallUnknownFn,
    new Uint8Array([1]),
  );
  const outcome = call.then(
    (value) => value,
    (error) => error,
  );
  try {
    await until(() => held);
    assert.equal(Atomics.load(new Int32Array(object.control), 1), 2);
    lock.unlock();
    const reason = await outcome;
    assert(reason instanceof Error);
    assert.equal(reason.name, "BaseCallDestroyedError");
    await reclaimed(object);
    lock.assertNonblocking();
  } finally {
    baseCallTestHooks.beforeRequestPublication = undefined;
    lock.restore();
    park.destroy();
    await outcome;
  }
});

test("main-thread Ready destroy cancels synchronously and frees captured request later", async () => {
  const park = new BaseCallParkUseArrayBuffer(() => undefined, {
    maxBaseCalls: 1,
    allocatorBytes: 1024,
  });
  const object = park.get_object();
  const slots = new Int32Array(object.slots);
  const ref = BaseCallRefUseArrayBuffer.init_self(object);
  const call = ref.async_call(
    BaseCallOpcode.CallUnknownFn,
    new Uint8Array([1]),
  );
  const outcome = call.then(
    (value) => value,
    (error) => error,
  );
  await until(() => Atomics.load(slots, BASE) === READY);
  const lock = contention(object);
  try {
    lock.lock();
    assert.equal(park.destroy(), undefined);
    assert.equal(Atomics.load(new Int32Array(object.control), 1), 2);
    assert.equal(Atomics.load(slots, BASE), CANCELLED);
    const reason = await outcome;
    assert(reason instanceof Error);
    assert.equal(reason.name, "BaseCallDestroyedError");
    assert.equal(Atomics.load(slots, BASE), FREE);
    assert.equal(Atomics.load(slots, BASE + 4), 0);
    assert.equal(Atomics.load(lock.words, 1), 1);
    lock.unlock();
    await reclaimed(object);
    lock.assertNonblocking();
  } finally {
    lock.restore();
    park.destroy();
    await outcome;
  }
});

for (const fails of [false, true]) {
  test(`main-thread late ${fails ? "error" : "result"} cleanup does not overwrite reused slot`, async () => {
    const park = new BaseCallParkUseArrayBuffer(
      () => {
        if (fails) throw new TypeError("late failure");
        return new Uint8Array([9]);
      },
      { maxBaseCalls: 1, allocatorBytes: 4096 },
    );
    const object = park.get_object();
    const slots = new Int32Array(object.slots);
    Atomics.store(slots, BASE + 1, 1);
    Atomics.store(slots, BASE, RUNNING);
    const allocator = parkAllocator(park);
    const lock = contention(object);
    let held = false;
    let lateAllocation: [number, number] | undefined;
    const afterWrite = (allocation: [number, number]) => {
      lateAllocation = allocation;
      lock.lock();
      held = true;
      Atomics.store(slots, BASE, CANCELLED);
      // Model the caller releasing and another caller claiming this slot.
      Atomics.store(slots, BASE + 1, 2);
      Atomics.store(slots, BASE + 6, 123);
      Atomics.store(slots, BASE, RUNNING);
      return allocation;
    };
    const write = allocator.block_write.bind(allocator);
    const asyncWrite = allocator.async_write.bind(allocator);
    allocator.block_write = (data) => afterWrite(write(data));
    allocator.async_write = async (data) => afterWrite(await asyncWrite(data));
    const handling = (
      park as unknown as {
        handleSlot(
          slotIdentity: typeof identity,
          opcode: BaseCallOpcode,
          payload: Uint8Array,
        ): Promise<void>;
      }
    ).handleSlot(identity, BaseCallOpcode.CallUnknownFn, new Uint8Array());
    const outcome = handling.then(
      () => undefined,
      (error) => error,
    );
    try {
      await until(() => held);
      lock.unlock();
      assert.equal(await outcome, undefined);
      assert.equal(Atomics.load(slots, BASE + 1), 2);
      assert.equal(Atomics.load(slots, BASE + 6), 123);
      assert.equal(Atomics.load(slots, BASE), RUNNING);
      assert(lateAllocation);
      const freedAllocation = lateAllocation;
      assert.throws(
        () => allocator.get_memory(...freedAllocation),
        /freed|not found/,
      );
      Atomics.store(slots, BASE, FREE);
      await reclaimed(object);
      lock.assertNonblocking();
    } finally {
      lock.restore();
      park.destroy();
      await outcome;
    }
  });
}
