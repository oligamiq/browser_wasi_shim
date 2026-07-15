import assert from "node:assert";
import test from "node:test";
import {
  BaseCallCapacityError,
  BaseCallOpcode,
  BaseCallParkUseArrayBuffer,
  BaseCallRefUseArrayBuffer,
  type BaseCallTransportObject,
} from "./base_call.ts";
import { BaseCallAllocatorUseArrayBuffer } from "./base_call_allocator.ts";
import * as sharedArrayBuffer from "./index.ts";

const CONTROL_LIFECYCLE = 1;
const CONTROL_REQUEST_EPOCH = 2;
const CONTROL_FREE_SLOT_EPOCH = 3;
const SLOT_WORDS = 12;
const SLOT_STATE = 0;
const SLOT_GENERATION = 1;
const SLOT_OPCODE = 2;
const SLOT_FLAGS = 3;
const SLOT_REQUEST_POINTER = 4;
const SLOT_REQUEST_LENGTH = 5;
const SLOT_RESPONSE_POINTER = 6;
const SLOT_RESPONSE_LENGTH = 7;

const ACTIVE = 0;
const DESTROYED = 2;
const FREE = 0;
const WRITING = 1;
const READY = 2;
const RUNNING = 3;
const CANCELLED = 6;
const RETIRED = 7;

async function waitUntil(
  predicate: () => boolean,
  timeoutMilliseconds = 1_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(
        `condition was not met within ${timeoutMilliseconds} milliseconds`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function within<T>(
  promise: Promise<T>,
  timeoutMilliseconds = 100,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("operation timed out")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function slotOffset(slotIndex: number): number {
  return slotIndex * SLOT_WORDS;
}

function terminalMessage(reason: unknown): string {
  return reason instanceof Error
    ? `${reason.name}: ${reason.message}`
    : String(reason);
}

test("exports the v2 base call transport", () => {
  assert.strictEqual(
    typeof (sharedArrayBuffer as Record<string, unknown>)
      .BaseCallParkUseArrayBuffer,
    "function",
  );
  assert.strictEqual(
    typeof (sharedArrayBuffer as Record<string, unknown>)
      .BaseCallRefUseArrayBuffer,
    "function",
  );
  assert.strictEqual(
    typeof (sharedArrayBuffer as Record<string, unknown>).BaseCallCapacityError,
    "function",
  );
});

test("creates the exact v2 control and slot layouts", () => {
  const park = new BaseCallParkUseArrayBuffer(() => undefined, {
    maxBaseCalls: 2,
    allocatorBytes: 64,
  });
  try {
    const object = park.get_object();
    assert.strictEqual(object.version, 2);
    assert.strictEqual(object.userSlotCount, 2);
    assert.strictEqual(object.control.byteLength, 8 * 4);
    assert.strictEqual(object.slots.byteLength, 3 * 12 * 4);
    assert.deepStrictEqual(Array.from(new Int32Array(object.control)), [
      2,
      ACTIVE,
      0,
      0,
      0,
      2,
      0,
      0,
    ]);
    assert.deepStrictEqual(
      Array.from(new Int32Array(object.slots)),
      new Array(36).fill(0),
    );
  } finally {
    park.destroy();
  }
});

test("rejects invalid base call capacities", () => {
  for (const maxBaseCalls of [0, 1025, 1.5, Number.NaN]) {
    assert.throws(
      () => new BaseCallParkUseArrayBuffer(() => undefined, { maxBaseCalls }),
      RangeError,
    );
  }
});

test("concurrent calls remain correlated when handlers finish in reverse order", async () => {
  const resolvers = new Map<number, (value: Uint8Array) => void>();
  const park = new BaseCallParkUseArrayBuffer(
    (_opcode, payload) =>
      new Promise((resolve) => resolvers.set(payload[0], resolve)),
    { maxBaseCalls: 2, allocatorBytes: 4096 },
  );
  park.listen();
  const ref = BaseCallRefUseArrayBuffer.init_self(park.get_object());

  try {
    const first = ref.async_call(
      BaseCallOpcode.CallUnknownFn,
      new Uint8Array([1]),
    );
    const second = ref.async_call(
      BaseCallOpcode.CallUnknownFn,
      new Uint8Array([2]),
    );
    await waitUntil(() => resolvers.size === 2);
    resolvers.get(2)?.(new Uint8Array([22]));
    resolvers.get(1)?.(new Uint8Array([11]));

    assert.deepStrictEqual(Array.from((await first) ?? []), [11]);
    assert.deepStrictEqual(Array.from((await second) ?? []), [22]);
  } finally {
    park.destroy();
  }
});

test("wait-before-notify completes", async () => {
  const park = new BaseCallParkUseArrayBuffer((_opcode, payload) => payload, {
    maxBaseCalls: 1,
    allocatorBytes: 128,
  });
  park.listen();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const ref = BaseCallRefUseArrayBuffer.init_self(park.get_object());

  try {
    assert.deepStrictEqual(
      Array.from(
        (await ref.async_call(
          BaseCallOpcode.CallUnknownFn,
          new Uint8Array([7]),
        )) ?? [],
      ),
      [7],
    );
  } finally {
    park.destroy();
  }
});

test("notify-before-wait completes", async () => {
  const park = new BaseCallParkUseArrayBuffer((_opcode, payload) => payload, {
    maxBaseCalls: 1,
    allocatorBytes: 128,
  });
  const ref = BaseCallRefUseArrayBuffer.init_self(park.get_object());
  const call = ref.async_call(
    BaseCallOpcode.CallUnknownFn,
    new Uint8Array([8]),
  );
  const control = new Int32Array(park.get_object().control);
  await waitUntil(() => Atomics.load(control, CONTROL_REQUEST_EPOCH) === 1);
  park.listen();

  try {
    assert.deepStrictEqual(Array.from((await call) ?? []), [8]);
  } finally {
    park.destroy();
  }
});

test("capacity fails fast and a later call succeeds", async () => {
  const park = new BaseCallParkUseArrayBuffer((_opcode, payload) => payload, {
    maxBaseCalls: 1,
    allocatorBytes: 128,
  });
  const object = park.get_object();
  const slots = new Int32Array(object.slots);
  const userState = slotOffset(1) + SLOT_STATE;
  Atomics.store(slots, userState, WRITING);
  const ref = BaseCallRefUseArrayBuffer.init_self(object);

  assert.throws(
    () => ref.block_call(BaseCallOpcode.CallUnknownFn, new Uint8Array([1])),
    BaseCallCapacityError,
  );

  Atomics.store(slots, userState, FREE);
  Atomics.add(new Int32Array(object.control), CONTROL_FREE_SLOT_EPOCH, 1);
  Atomics.notify(new Int32Array(object.control), CONTROL_FREE_SLOT_EPOCH);
  park.listen();
  try {
    assert.deepStrictEqual(
      Array.from(
        (await ref.async_call(
          BaseCallOpcode.CallUnknownFn,
          new Uint8Array([2]),
        )) ?? [],
      ),
      [2],
    );
  } finally {
    park.destroy();
  }
});

test("retires a slot instead of wrapping its generation", () => {
  const park = new BaseCallParkUseArrayBuffer(() => undefined, {
    maxBaseCalls: 1,
    allocatorBytes: 64,
  });
  const object = park.get_object();
  const slots = new Int32Array(object.slots);
  const base = slotOffset(1);
  Atomics.store(slots, base + SLOT_GENERATION, 0x7fffffff);
  const ref = BaseCallRefUseArrayBuffer.init_self(object);

  assert.throws(
    () => ref.block_call(BaseCallOpcode.CallUnknownFn, new Uint8Array()),
    BaseCallCapacityError,
  );
  assert.strictEqual(Atomics.load(slots, base + SLOT_STATE), RETIRED);
  park.destroy();
});

test("stale generation cannot publish after actual slot reuse", async () => {
  const resolvers: Array<(value: Uint8Array) => void> = [];
  const park = new BaseCallParkUseArrayBuffer(
    () => new Promise((resolve) => resolvers.push(resolve)),
    { maxBaseCalls: 1, allocatorBytes: 128 },
  );
  park.listen();
  const object = park.get_object();
  const slots = new Int32Array(object.slots);
  const stateIndex = slotOffset(1) + SLOT_STATE;
  const generationIndex = slotOffset(1) + SLOT_GENERATION;
  const ref = BaseCallRefUseArrayBuffer.init_self(object);

  try {
    const first = ref.async_call(
      BaseCallOpcode.CallUnknownFn,
      new Uint8Array([1]),
    );
    await waitUntil(() => resolvers.length === 1);
    assert.strictEqual(Atomics.load(slots, generationIndex), 1);
    assert.strictEqual(
      Atomics.compareExchange(slots, stateIndex, RUNNING, CANCELLED),
      RUNNING,
    );
    Atomics.notify(slots, stateIndex);
    await assert.rejects(first, /Destroyed/i);
    await waitUntil(() => Atomics.load(slots, stateIndex) === FREE);

    const second = ref.async_call(
      BaseCallOpcode.CallUnknownFn,
      new Uint8Array([2]),
    );
    await waitUntil(() => resolvers.length === 2);
    assert.strictEqual(Atomics.load(slots, generationIndex), 2);
    resolvers[0](new Uint8Array([99]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(Atomics.load(slots, generationIndex), 2);
    assert.strictEqual(Atomics.load(slots, stateIndex), RUNNING);
    assert.strictEqual(
      Atomics.load(slots, slotOffset(1) + SLOT_RESPONSE_POINTER),
      0,
    );
    assert.strictEqual(
      Atomics.load(slots, slotOffset(1) + SLOT_RESPONSE_LENGTH),
      0,
    );
    resolvers[1](new Uint8Array([22]));
    assert.deepStrictEqual(Array.from((await second) ?? []), [22]);
  } finally {
    park.destroy();
  }
});

test("serialized callback error wakes only its caller", async () => {
  const park = new BaseCallParkUseArrayBuffer(
    (_opcode, payload) => {
      if (payload[0] === 1) {
        const error = new TypeError("only first failed");
        error.cause = "callback cause";
        throw error;
      }
      return new Uint8Array([22]);
    },
    { maxBaseCalls: 2, allocatorBytes: 1024 },
  );
  park.listen();
  const ref = BaseCallRefUseArrayBuffer.init_self(park.get_object());

  try {
    const failed = ref.async_call(
      BaseCallOpcode.CallUnknownFn,
      new Uint8Array([1]),
    );
    const succeeded = ref.async_call(
      BaseCallOpcode.CallUnknownFn,
      new Uint8Array([2]),
    );
    await assert.rejects(failed, (reason: unknown) => {
      assert(reason instanceof TypeError);
      assert.strictEqual(reason.message, "only first failed");
      assert.strictEqual(reason.cause, "callback cause");
      return true;
    });
    assert.deepStrictEqual(Array.from((await succeeded) ?? []), [22]);
  } finally {
    park.destroy();
  }
});

test("unsupported result publishes CodecError", async () => {
  const park = new BaseCallParkUseArrayBuffer((() => "not bytes") as never, {
    maxBaseCalls: 1,
    allocatorBytes: 128,
  });
  park.listen();
  const ref = BaseCallRefUseArrayBuffer.init_self(park.get_object());

  try {
    await assert.rejects(
      ref.async_call(BaseCallOpcode.CallUnknownFn, new Uint8Array()),
      (reason) => /CodecError/i.test(terminalMessage(reason)),
    );
  } finally {
    park.destroy();
  }
});

test("circular error cause becomes a bounded serialized error", async () => {
  const park = new BaseCallParkUseArrayBuffer(
    () => {
      const error = new Error("circular");
      error.cause = error;
      throw error;
    },
    { maxBaseCalls: 1, allocatorBytes: 1024 },
  );
  park.listen();
  const ref = BaseCallRefUseArrayBuffer.init_self(park.get_object());

  try {
    await assert.rejects(
      ref.async_call(BaseCallOpcode.CallUnknownFn, new Uint8Array()),
      (reason: unknown) => {
        assert(reason instanceof Error);
        assert.strictEqual(reason.message, "circular");
        assert.notStrictEqual(reason.cause, reason);
        assert(String(reason.cause).length <= 65_536);
        return true;
      },
    );
  } finally {
    park.destroy();
  }
});

test("allocator OOM publishes an allocation-free terminal error", async () => {
  const park = new BaseCallParkUseArrayBuffer(() => new Uint8Array(33), {
    maxBaseCalls: 1,
    allocatorBytes: 64,
  });
  park.listen();
  const object = park.get_object();
  const allocatorWords = new Int32Array(object.allocator.share_arrays_memory);
  const ref = BaseCallRefUseArrayBuffer.init_self(object);

  try {
    await assert.rejects(
      ref.async_call(BaseCallOpcode.CallUnknownFn, new Uint8Array([1])),
      (reason) => /OutOfMemory/i.test(terminalMessage(reason)),
    );
    assert.strictEqual(Atomics.load(allocatorWords, 2), 0);
  } finally {
    park.destroy();
  }
});

test("invalid runtime opcode publishes InvalidRequest", async () => {
  let handled = false;
  const park = new BaseCallParkUseArrayBuffer(
    () => {
      handled = true;
      return undefined;
    },
    { maxBaseCalls: 1, allocatorBytes: 128 },
  );
  park.listen();
  const ref = BaseCallRefUseArrayBuffer.init_self(park.get_object());

  try {
    await assert.rejects(
      ref.async_call(99 as BaseCallOpcode, new Uint8Array()),
      (reason) => /InvalidRequest/i.test(terminalMessage(reason)),
    );
    assert.strictEqual(handled, false);
  } finally {
    park.destroy();
  }
});

test("dispatcher rejects opcodes published through the wrong slot class", async () => {
  for (const [slotIndex, opcode] of [
    [1, BaseCallOpcode.SetParkFdsMap],
    [0, BaseCallOpcode.CallUnknownFn],
  ] as const) {
    let handled = false;
    const park = new BaseCallParkUseArrayBuffer(
      () => {
        handled = true;
        return undefined;
      },
      { maxBaseCalls: 1, allocatorBytes: 64 },
    );
    const object = park.get_object();
    const slots = new Int32Array(object.slots);
    const base = slotOffset(slotIndex);
    Atomics.store(slots, base + SLOT_GENERATION, 1);
    Atomics.store(slots, base + SLOT_OPCODE, opcode);
    Atomics.store(slots, base + SLOT_STATE, READY);
    park.listen();

    try {
      await waitUntil(() => Atomics.load(slots, base + SLOT_STATE) === 5);
      assert.strictEqual(Atomics.load(slots, base + SLOT_FLAGS), 3);
      assert.strictEqual(handled, false);
    } finally {
      park.destroy();
    }
  }
});

test("publication rechecks lifecycle after a destroy scan misses its claim", async () => {
  const park = new BaseCallParkUseArrayBuffer(() => undefined, {
    maxBaseCalls: 1,
    allocatorBytes: 64,
  });
  const object = park.get_object();
  const control = new Int32Array(object.control);
  const slots = new Int32Array(object.slots);
  const allocatorWords = new Int32Array(object.allocator.share_arrays_memory);
  const stateIndex = slotOffset(1) + SLOT_STATE;
  const ref = BaseCallRefUseArrayBuffer.init_self(object);
  Atomics.store(allocatorWords, 0, 1);
  const call = ref.async_call(
    BaseCallOpcode.CallUnknownFn,
    new Uint8Array([1]),
  );

  try {
    await waitUntil(() => Atomics.load(slots, stateIndex) === WRITING);
    Atomics.store(control, CONTROL_LIFECYCLE, DESTROYED);
    Atomics.store(allocatorWords, 0, 0);
    Atomics.notify(allocatorWords, 0);

    await assert.rejects(within(call), /Destroyed/i);
    assert.strictEqual(Atomics.load(slots, stateIndex), FREE);
    assert.strictEqual(Atomics.load(allocatorWords, 2), 0);
  } finally {
    if (Atomics.load(slots, stateIndex) !== FREE) {
      Atomics.store(slots, stateIndex, CANCELLED);
      Atomics.notify(slots, stateIndex);
      await call.catch(() => undefined);
    }
    Atomics.store(allocatorWords, 0, 0);
    Atomics.notify(allocatorWords, 0);
    park.destroy();
  }
});

test("malformed transport objects are rejected without mutation", () => {
  const createObject = () =>
    new BaseCallParkUseArrayBuffer(() => undefined, {
      maxBaseCalls: 1,
      allocatorBytes: 64,
    }).get_object();
  const malformed: Array<(object: BaseCallTransportObject) => unknown> = [
    (object) => ({ ...object, version: 1 }),
    (object) => ({ ...object, userSlotCount: 0 }),
    (object) => ({ ...object, control: new ArrayBuffer(32) }),
    (object) => ({ ...object, control: new SharedArrayBuffer(28) }),
    (object) => ({ ...object, slots: new ArrayBuffer(96) }),
    (object) => ({ ...object, slots: new SharedArrayBuffer(47) }),
    (object) => {
      Atomics.store(new Int32Array(object.control), 5, 2);
      return object;
    },
    (object) => {
      Atomics.store(new Int32Array(object.control), CONTROL_LIFECYCLE, 3);
      return object;
    },
    (object) => {
      Atomics.store(new Int32Array(object.allocator.share_arrays_memory), 3, 0);
      return object;
    },
  ];

  for (const mutate of malformed) {
    const valid = createObject();
    const candidate = mutate(valid) as BaseCallTransportObject;
    const controlBefore = Array.from(new Uint8Array(valid.control));
    const slotsBefore = Array.from(new Uint8Array(valid.slots));
    const allocatorBefore = Array.from(
      new Uint8Array(valid.allocator.share_arrays_memory),
    );

    assert.throws(() => BaseCallRefUseArrayBuffer.init_self(candidate));
    assert.deepStrictEqual(
      Array.from(new Uint8Array(valid.control)),
      controlBefore,
    );
    assert.deepStrictEqual(
      Array.from(new Uint8Array(valid.slots)),
      slotsBefore,
    );
    assert.deepStrictEqual(
      Array.from(new Uint8Array(valid.allocator.share_arrays_memory)),
      allocatorBefore,
    );
  }
});

test("destroy cancels writing and ready slots and frees owned requests", () => {
  for (const state of [WRITING, READY]) {
    let beganDestroy = 0;
    const park = new BaseCallParkUseArrayBuffer(() => undefined, {
      maxBaseCalls: 1,
      allocatorBytes: 128,
      onBeginDestroy: () => beganDestroy++,
    });
    const object = park.get_object();
    const slots = new Int32Array(object.slots);
    const base = slotOffset(1);
    Atomics.store(slots, base + SLOT_GENERATION, 1);
    Atomics.store(slots, base + SLOT_OPCODE, BaseCallOpcode.CallUnknownFn);
    if (state === READY) {
      const allocator = BaseCallAllocatorUseArrayBuffer.init_self(
        object.allocator,
      );
      const [pointer, length] = allocator.block_write(new Uint8Array([1]));
      Atomics.store(slots, base + SLOT_REQUEST_POINTER, pointer);
      Atomics.store(slots, base + SLOT_REQUEST_LENGTH, length);
    }
    Atomics.store(slots, base + SLOT_STATE, state);

    park.destroy();

    assert.strictEqual(Atomics.load(slots, base + SLOT_STATE), CANCELLED);
    assert.strictEqual(
      Atomics.load(new Int32Array(object.control), 1),
      DESTROYED,
    );
    assert.strictEqual(beganDestroy, 1);
    assert.strictEqual(
      Atomics.load(new Int32Array(object.allocator.share_arrays_memory), 2),
      state === WRITING ? 0 : 0,
    );
  }
});

test("destroy cancels running calls and discards late completion", async () => {
  let resolveHandler: ((value: Uint8Array) => void) | undefined;
  let beganDestroy = 0;
  const park = new BaseCallParkUseArrayBuffer(
    () =>
      new Promise((resolve) => {
        resolveHandler = resolve;
      }),
    {
      maxBaseCalls: 1,
      allocatorBytes: 128,
      onBeginDestroy: () => beganDestroy++,
    },
  );
  park.listen();
  const object = park.get_object();
  const slots = new Int32Array(object.slots);
  const stateIndex = slotOffset(1) + SLOT_STATE;
  const ref = BaseCallRefUseArrayBuffer.init_self(object);
  const call = ref.async_call(
    BaseCallOpcode.CallUnknownFn,
    new Uint8Array([1]),
  );

  await waitUntil(() => Atomics.load(slots, stateIndex) === RUNNING);
  park.destroy();
  await assert.rejects(call, /Destroyed/i);
  resolveHandler?.(new Uint8Array([9]));
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.strictEqual(beganDestroy, 1);
  assert.strictEqual(Atomics.load(slots, stateIndex), FREE);
  assert.strictEqual(
    Atomics.load(new Int32Array(object.allocator.share_arrays_memory), 2),
    0,
  );
});

test("duplicate owner and wire destroy are idempotent with one origin ack", async () => {
  let beganDestroy = 0;
  const park = new BaseCallParkUseArrayBuffer(() => undefined, {
    maxBaseCalls: 1,
    allocatorBytes: 128,
    onBeginDestroy: () => beganDestroy++,
  });
  park.listen();
  const object = park.get_object();
  const slots = new Int32Array(object.slots);
  const ref = BaseCallRefUseArrayBuffer.init_self(object);

  assert.strictEqual(
    await ref.async_call(BaseCallOpcode.DestroyPark, new Uint8Array()),
    undefined,
  );
  assert.strictEqual(
    Atomics.load(new Int32Array(object.control), 1),
    DESTROYED,
  );
  assert.strictEqual(Atomics.load(slots, SLOT_STATE), FREE);
  assert.strictEqual(beganDestroy, 1);

  assert.strictEqual(
    await ref.async_call(BaseCallOpcode.DestroyPark, new Uint8Array()),
    undefined,
  );
  park.destroy();
  park.destroy();
  assert.strictEqual(beganDestroy, 1);
});

test("calls after destruction report Destroyed rather than capacity", async () => {
  const park = new BaseCallParkUseArrayBuffer(() => undefined, {
    maxBaseCalls: 1,
    allocatorBytes: 64,
  });
  const ref = BaseCallRefUseArrayBuffer.init_self(park.get_object());
  park.destroy();

  assert.throws(
    () => ref.block_call(BaseCallOpcode.CallUnknownFn, new Uint8Array()),
    /Destroyed/i,
  );
  await assert.rejects(
    ref.async_call(BaseCallOpcode.CallUnknownFn, new Uint8Array()),
    /Destroyed/i,
  );
});
