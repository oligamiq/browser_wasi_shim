import assert from "node:assert";
import test from "node:test";
import * as sharedArrayBuffer from "./index.ts";
import { BaseCallAllocatorUseArrayBuffer } from "./base_call_allocator.ts";

type WorkerMessage =
  | { type: "attempting" | "done" }
  | { type: "error"; error: { name: string; message: string; stack?: string } };

function next_worker_message(
  worker: Worker,
  timeoutMilliseconds: number,
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(() => reject(new Error("timed out waiting for worker"))),
      timeoutMilliseconds,
    );
    const onMessage = (event: MessageEvent<WorkerMessage>) =>
      finish(() => resolve(event.data));
    const onError = (event: ErrorEvent) =>
      finish(() => reject(event.error ?? new Error(event.message)));
    const finish = (complete: () => void) => {
      clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      complete();
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

function expect_no_worker_message(
  worker: Worker,
  timeoutMilliseconds: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerMessage>) => {
      finish(() =>
        reject(new Error(`unexpected terminal message: ${event.data.type}`)),
      );
    };
    const onError = (event: ErrorEvent) =>
      finish(() => reject(event.error ?? new Error(event.message)));
    const timeout = setTimeout(() => {
      finish(resolve);
    }, timeoutMilliseconds);
    const finish = (complete: () => void) => {
      clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      complete();
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

test("exports the base call allocator", () => {
  assert.strictEqual(
    typeof (sharedArrayBuffer as Record<string, unknown>)
      .BaseCallAllocatorUseArrayBuffer,
    "function",
  );
});

test("rejects malformed allocator sizes", () => {
  for (const byteLength of [
    0,
    63,
    65,
    64.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0x80000000,
  ]) {
    assert.throws(
      () => new BaseCallAllocatorUseArrayBuffer(byteLength),
      RangeError,
    );
  }
});

test("initializes the allocator and fixed extent table", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const words = new Int32Array(allocator.share_arrays_memory);

  assert.deepStrictEqual(
    Array.from(words.slice(0, 12)),
    [0, 0, 0, 0x42434132, 1, 1, 48, 1, 48, 16, 0, 1],
  );
});

test("handles zero-length payloads without creating ownership", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);

  assert.deepStrictEqual(allocator.block_write(new Uint8Array()), [0, 0]);
  assert.strictEqual(allocator.get_memory(0, 0).byteLength, 0);
  assert.doesNotThrow(() => allocator.free(0, 0));
  assert.strictEqual(new Int32Array(allocator.share_arrays_memory)[1], 0);
});

test("aligns split extents and retains minimal remainders", () => {
  const split = new BaseCallAllocatorUseArrayBuffer(128);
  assert.deepStrictEqual(
    split.block_write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])),
    [96, 9],
  );
  const splitWords = new Int32Array(split.share_arrays_memory);
  assert.deepStrictEqual(
    Array.from(splitWords.slice(8, 16)),
    [96, 16, 9, 0, 112, 16, 0, 1],
  );

  const remainder = new BaseCallAllocatorUseArrayBuffer(80);
  assert.deepStrictEqual(remainder.block_write(new Uint8Array(8)), [64, 8]);
  assert.deepStrictEqual(
    Array.from(new Int32Array(remainder.share_arrays_memory).slice(8, 16)),
    [64, 8, 8, 0, 72, 8, 0, 1],
  );

  const unsplit = new BaseCallAllocatorUseArrayBuffer(64);
  assert.deepStrictEqual(unsplit.block_write(new Uint8Array(9)), [48, 9]);
  assert.deepStrictEqual(
    Array.from(new Int32Array(unsplit.share_arrays_memory).slice(8, 12)),
    [48, 16, 9, 0],
  );
});

test("reuses next-fit extents and coalesces adjacent frees", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(128);
  const [first] = allocator.block_write(new Uint8Array([1]));
  const [middle] = allocator.block_write(new Uint8Array([2]));
  const [last] = allocator.block_write(new Uint8Array([3]));

  assert.deepStrictEqual([first, middle, last], [96, 104, 112]);
  allocator.free(middle, 1);
  const [reused] = allocator.block_write(new Uint8Array([4]));
  assert.notStrictEqual(reused, middle);

  allocator.free(first, 1);
  allocator.free(reused, 1);
  const [coalesced] = allocator.block_write(new Uint8Array(16));
  assert.strictEqual(coalesced, first);

  allocator.free(coalesced, 16);
  allocator.free(last, 1);
  const words = new Int32Array(allocator.share_arrays_memory);
  assert.deepStrictEqual(
    Array.from(words.slice(0, 12)),
    [0, 0, 0, 0x42434132, 1, 4, 96, 1, 96, 32, 0, 1],
  );
});

test("next-fit skips earlier holes and repeated reuse remains owned", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(256);
  const first = allocator.block_write(new Uint8Array(8));
  const middle = allocator.block_write(new Uint8Array(8));
  const third = allocator.block_write(new Uint8Array(8));

  allocator.free(...first);
  const later = allocator.block_write(new Uint8Array(8));
  assert.notStrictEqual(later[0], first[0]);

  allocator.free(...middle);
  const anotherLater = allocator.block_write(new Uint8Array(8));
  assert.notStrictEqual(anotherLater[0], middle[0]);

  allocator.free(...later);
  allocator.free(...anotherLater);
  allocator.free(...third);
  const reused = allocator.block_write(new Uint8Array(8));
  assert.strictEqual(reused[0], first[0]);
  allocator.free(...reused);
});

test("returns owned copies of allocated payload bytes", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const allocation = allocator.block_write(new Uint8Array([4, 5, 6]));
  const copy = new Uint8Array(allocator.get_memory(...allocation));

  assert.deepStrictEqual(Array.from(copy), [4, 5, 6]);
  copy[0] = 99;
  assert.deepStrictEqual(
    Array.from(new Uint8Array(allocator.get_memory(...allocation))),
    [4, 5, 6],
  );
});

test("attaches without storing over live allocator state", () => {
  const owner = new BaseCallAllocatorUseArrayBuffer(128);
  const allocation = owner.block_write(new Uint8Array([7, 8, 9]));
  const words = new Int32Array(owner.share_arrays_memory);
  Atomics.store(words, 0, 1);
  const expectedWords = Array.from(words);

  const attached = BaseCallAllocatorUseArrayBuffer.init_self(
    owner.get_object(),
  );

  assert.strictEqual(attached.share_arrays_memory, owner.share_arrays_memory);
  assert.deepStrictEqual(Array.from(words), expectedWords);
  Atomics.store(words, 0, 0);
  attached.free(...allocation);
});

test("rejects attachment when the allocator magic is invalid", () => {
  const owner = new BaseCallAllocatorUseArrayBuffer(64);
  new Int32Array(owner.share_arrays_memory)[3] = 0;

  assert.throws(
    () => BaseCallAllocatorUseArrayBuffer.init_self(owner.get_object()),
    /magic/i,
  );
});

for (const [field, word, value] of [
  ["old header", 3, 0x42434131],
  ["version", 7, 0],
  ["future version", 7, 2],
  ["zero capacity", 5, 0],
  ["negative capacity", 5, -1],
  ["excessive capacity", 5, 2057],
  ["unaligned data start", 6, 97],
  ["overlapping table", 6, 32],
  ["wrong table end", 6, 112],
] as const) {
  test(`attachment rejects ${field} without mutating shared state`, () => {
    const allocator = new BaseCallAllocatorUseArrayBuffer(128);
    const words = new Int32Array(allocator.share_arrays_memory);
    words[word] = value;
    const before = Array.from(words);
    assert.throws(
      () => BaseCallAllocatorUseArrayBuffer.init_self(allocator.get_object()),
      /magic|corrupt/i,
    );
    assert.deepStrictEqual(Array.from(words), before);
  });
}

test("attachment rejects a table with no room for payload", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(128);
  const words = new Int32Array(allocator.share_arrays_memory);
  words[5] = 6;
  words[6] = 128;
  const before = Array.from(words);
  assert.throws(
    () => BaseCallAllocatorUseArrayBuffer.init_self(allocator.get_object()),
    /corrupt/i,
  );
  assert.deepStrictEqual(Array.from(words), before);
});

test("attachment validates buffer size before reading its header", () => {
  for (const byteLength of [0, 32, 63, 65]) {
    const share_arrays_memory = new SharedArrayBuffer(byteLength);
    assert.throws(
      () => BaseCallAllocatorUseArrayBuffer.init_self({ share_arrays_memory }),
      /invalid buffer size/i,
    );
  }
});

test("attachment neither acquires the lock nor inspects an in-progress extent table", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(128);
  const words = new Int32Array(allocator.share_arrays_memory);
  words[0] = 1;
  words[1] = -1;
  words[2] = -1;
  words[4] = 0;
  words[8] = -1;
  const before = Array.from(words);
  const compareExchange = Atomics.compareExchange;
  Atomics.compareExchange = () => {
    throw new Error("attachment must not acquire the lock");
  };
  try {
    const attached = BaseCallAllocatorUseArrayBuffer.init_self(
      allocator.get_object(),
    );
    assert.strictEqual(
      attached.share_arrays_memory,
      allocator.share_arrays_memory,
    );
    assert.deepStrictEqual(Array.from(words), before);
  } finally {
    Atomics.compareExchange = compareExchange;
  }
});

test("recovers after out-of-memory without poisoning allocator state", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);

  assert.throws(
    () => allocator.block_write(new Uint8Array(33)),
    /out of memory/i,
  );
  const words = new Int32Array(allocator.share_arrays_memory);
  assert.deepStrictEqual(Array.from(words.slice(0, 3)), [0, 0, 0]);

  const allocation = allocator.block_write(new Uint8Array([1]));
  assert.deepStrictEqual(allocation, [48, 1]);
  allocator.free(...allocation);
});

test("rejects wrong, out-of-range, and duplicate frees", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const allocation = allocator.block_write(new Uint8Array([1, 2, 3]));

  assert.throws(() => allocator.free(allocation[0], 2));
  assert.throws(() => allocator.free(allocation[0] + 8, allocation[1]));
  assert.throws(() => allocator.free(-8, allocation[1]));
  assert.strictEqual(new Int32Array(allocator.share_arrays_memory)[1], 1);

  allocator.free(...allocation);
  assert.throws(() => allocator.free(...allocation), /freed/i);
  assert.strictEqual(new Int32Array(allocator.share_arrays_memory)[1], 0);
});

test("rejects reads outside the exact live allocation", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const allocation = allocator.block_write(new Uint8Array([1, 2, 3]));

  assert.throws(() => allocator.get_memory(allocation[0], 2));
  assert.throws(() => allocator.get_memory(allocation[0] + 1, 2));
  assert.throws(() => allocator.get_memory(128, 1));
  allocator.free(...allocation);
  assert.throws(() => allocator.get_memory(...allocation), /freed/i);
});

test("rejects a malformed adjacent block before free mutates metadata", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(128);
  const first = allocator.block_write(new Uint8Array(8));
  const middle = allocator.block_write(new Uint8Array(8));
  const last = allocator.block_write(new Uint8Array(8));
  allocator.free(...middle);
  const words = new Int32Array(allocator.share_arrays_memory);
  const middleWord = 8 + 4;
  words[middleWord] = -8;
  const expectedWords = Array.from(words);

  assert.throws(() => allocator.get_memory(...last), /corrupt/i);
  assert.deepStrictEqual(Array.from(words), expectedWords);
  assert.throws(() => allocator.free(...first), /corrupt/i);
  assert.deepStrictEqual(Array.from(words), expectedWords);
});

test("rejects invalid free flags without mutating metadata", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const allocation = allocator.block_write(new Uint8Array(8));
  const words = new Int32Array(allocator.share_arrays_memory);
  words[8 + 3] = 2;
  const expectedWords = Array.from(words);

  assert.throws(() => allocator.get_memory(...allocation), /corrupt/i);
  assert.deepStrictEqual(Array.from(words), expectedWords);
  assert.throws(() => allocator.free(...allocation), /corrupt/i);
  assert.deepStrictEqual(Array.from(words), expectedWords);
});

test("rejects nonzero free-block requested lengths without mutation", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const allocation = allocator.block_write(new Uint8Array(8));
  allocator.free(...allocation);
  const words = new Int32Array(allocator.share_arrays_memory);
  words[8 + 2] = allocation[1];
  const expectedWords = Array.from(words);

  assert.throws(() => allocator.get_memory(...allocation), /corrupt/i);
  assert.deepStrictEqual(Array.from(words), expectedWords);
  assert.throws(() => allocator.free(...allocation), /corrupt/i);
  assert.deepStrictEqual(Array.from(words), expectedWords);
});

test("rejects allocated requested lengths outside their payload without mutation", () => {
  for (const requestedLength of [0, 24]) {
    const allocator = new BaseCallAllocatorUseArrayBuffer(128);
    const allocation = allocator.block_write(new Uint8Array(8));
    const words = new Int32Array(allocator.share_arrays_memory);
    words[8 + 2] = requestedLength;
    const expectedWords = Array.from(words);

    assert.throws(() => allocator.get_memory(...allocation), /corrupt/i);
    assert.deepStrictEqual(Array.from(words), expectedWords);
    assert.throws(() => allocator.free(...allocation), /corrupt/i);
    assert.deepStrictEqual(Array.from(words), expectedWords);
  }
});

test("asynchronously writes payloads with the same ownership contract", async () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const allocation = await allocator.async_write(new Uint8Array([9, 8, 7]));

  assert.deepStrictEqual(allocation, [48, 3]);
  assert.deepStrictEqual(
    Array.from(new Uint8Array(allocator.get_memory(...allocation))),
    [9, 8, 7],
  );
  allocator.free(...allocation);
});

test("asynchronously reads and frees payloads", async () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(128);
  const allocation = await allocator.async_write(new Uint8Array([3, 2, 1]));

  assert.deepStrictEqual(
    Array.from(new Uint8Array(await allocator.async_get_memory(...allocation))),
    [3, 2, 1],
  );
  await allocator.async_free(...allocation);
  await assert.rejects(
    () => allocator.async_get_memory(...allocation),
    /freed|not found/i,
  );
});

test("an asynchronous writer waits for and releases the allocator lock", async () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const words = new Int32Array(allocator.share_arrays_memory);
  Atomics.store(words, 0, 1);
  const pending = allocator.async_write(new Uint8Array([1]));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(Atomics.load(words, 1), 0);

  Atomics.store(words, 0, 0);
  Atomics.notify(words, 0, 1);
  const allocation = await pending;
  assert.deepStrictEqual(allocation, [48, 1]);
  allocator.free(...allocation);
});

for (const timing of ["waiting", "reserved"] as const) {
  for (const change of ["grow", "shrink", "transfer", "mutate"] as const) {
    test(`async write snapshots input before ${change} while ${timing}`, async () => {
      const allocator = new BaseCallAllocatorUseArrayBuffer(256);
      const words = new Int32Array(allocator.share_arrays_memory);
      const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
      const source = new Uint8Array(buffer);
      source.fill(7);
      if (timing === "waiting") Atomics.store(words, 0, 1);
      const pending = allocator.async_write(source);
      assert.strictEqual(words[1], timing === "waiting" ? 0 : 1);
      if (change === "grow") buffer.resize(16);
      if (change === "shrink") buffer.resize(0);
      if (change === "transfer") buffer.transfer();
      if (change === "mutate") source.fill(9);
      if (timing === "waiting") {
        Atomics.store(words, 0, 0);
        Atomics.notify(words, 0);
      }
      const neighbor = allocator.block_write(new Uint8Array(8).fill(3));
      const allocation = await pending;
      assert.strictEqual(allocation[1], 8);
      assert.deepStrictEqual(
        new Uint8Array(allocator.get_memory(...allocation)),
        new Uint8Array(8).fill(7),
      );
      assert.deepStrictEqual(
        new Uint8Array(allocator.get_memory(...neighbor)),
        new Uint8Array(8).fill(3),
      );
      allocator.free(...allocation);
      allocator.free(...neighbor);
      assert.strictEqual(words[1], 0);
      assert.strictEqual(words[4], 1);
    });
  }
}

test("blocking write snapshots input before waiting", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(128);
  const words = new Int32Array(allocator.share_arrays_memory);
  const source = new Uint8Array([1, 2, 3]);
  const wait = Atomics.wait;
  Atomics.store(words, 0, 1);
  Atomics.wait = () => {
    source.buffer.transfer();
    Atomics.store(words, 0, 0);
    return "ok";
  };
  try {
    const allocation = allocator.block_write(source);
    assert.deepStrictEqual(allocation, [96, 3]);
    assert.deepStrictEqual(
      new Uint8Array(allocator.get_memory(...allocation)),
      new Uint8Array([1, 2, 3]),
    );
    allocator.free(...allocation);
  } finally {
    Atomics.wait = wait;
    Atomics.store(words, 0, 0);
  }
});

for (const mode of ["blocking", "async"] as const) {
  test(`${mode} write rejects detached and out-of-bounds input without mutation`, async () => {
    for (const invalid of ["detached", "out-of-bounds"] as const) {
      const allocator = new BaseCallAllocatorUseArrayBuffer(128);
      const words = new Int32Array(allocator.share_arrays_memory);
      const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
      const source = new Uint8Array(buffer, 0, 8);
      if (invalid === "detached") buffer.transfer();
      else buffer.resize(0);
      const before = Array.from(words);
      if (mode === "blocking") {
        assert.throws(() => allocator.block_write(source), TypeError);
      } else {
        await assert.rejects(allocator.async_write(source), TypeError);
      }
      assert.deepStrictEqual(Array.from(words), before);
      const empty = new Uint8Array(new ArrayBuffer(0, { maxByteLength: 8 }));
      assert.deepStrictEqual(
        mode === "blocking"
          ? allocator.block_write(empty)
          : await allocator.async_write(empty),
        [0, 0],
      );
      assert.deepStrictEqual(Array.from(words), before);
    }
  });

  test(`${mode} write bounds the payload copy and rolls back a failed copy`, async () => {
    const allocator = new BaseCallAllocatorUseArrayBuffer(128);
    const words = new Int32Array(allocator.share_arrays_memory);
    const neighbor = allocator.block_write(new Uint8Array(8).fill(3));
    const set = Uint8Array.prototype.set;
    const failure = new Error("injected payload copy failure");
    let destinationLength = -1;
    Uint8Array.prototype.set = function (source, offset) {
      if (this.buffer === allocator.share_arrays_memory) {
        destinationLength = this.byteLength;
        this[0] = 99;
        throw failure;
      }
      return set.call(this, source, offset);
    };
    try {
      if (mode === "blocking") {
        assert.throws(() => allocator.block_write(new Uint8Array(8)), failure);
      } else {
        await assert.rejects(allocator.async_write(new Uint8Array(8)), failure);
      }
    } finally {
      Uint8Array.prototype.set = set;
    }
    assert.strictEqual(
      words[1],
      1,
      "failed write must release its reservation",
    );
    assert.strictEqual(words[0], 0);
    assert.strictEqual(
      destinationLength,
      8,
      "copy must be bounded by reservation",
    );
    assert.deepStrictEqual(
      new Uint8Array(allocator.get_memory(...neighbor)),
      new Uint8Array(8).fill(3),
    );
    allocator.free(...neighbor);
    assert.strictEqual(words[4], 1);
    const allocation = allocator.block_write(new Uint8Array(32));
    allocator.free(...allocation);
  });
}

test("reservation rejects invalid internal lengths before mutating metadata", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(128);
  const words = new Int32Array(allocator.share_arrays_memory);
  Atomics.store(words, 0, 1);
  const before = Array.from(words);
  try {
    for (const length of [0, -1, 0.5, Number.NaN, Infinity, 0x80000000]) {
      assert.throws(
        () => allocator["reserve_locked"](words, length),
        RangeError,
      );
      assert.deepStrictEqual(Array.from(words), before);
    }
  } finally {
    Atomics.store(words, 0, 0);
  }
});

for (const lock of [2, -1]) {
  for (const mode of ["blocking", "async"] as const) {
    test(`${mode} operations reject corrupt lock ${lock} without waiting or mutation`, async () => {
      const allocator = new BaseCallAllocatorUseArrayBuffer(128);
      const allocation = allocator.block_write(new Uint8Array(8));
      const words = new Int32Array(allocator.share_arrays_memory);
      Atomics.store(words, 0, lock);
      const before = Array.from(words);
      const wait = Atomics.wait;
      const waitAsync = Atomics.waitAsync;
      // Stop the old busy loop on its first wait, keeping the RED probe bounded.
      Atomics.wait = Atomics.waitAsync = () => {
        throw new Error("unexpected wait on invalid lock");
      };
      try {
        const operations =
          mode === "blocking"
            ? [
                () => allocator.block_write(new Uint8Array(8)),
                () => allocator.get_memory(...allocation),
                () => allocator.free(...allocation),
              ]
            : [
                () => allocator.async_write(new Uint8Array(8)),
                () => allocator.async_get_memory(...allocation),
                () => allocator.async_free(...allocation),
              ];
        for (const operation of operations) {
          if (mode === "blocking") assert.throws(operation, /corrupt.*lock/i);
          else await assert.rejects(async () => operation(), /corrupt.*lock/i);
          assert.deepStrictEqual(Array.from(words), before);
        }
      } finally {
        Atomics.wait = wait;
        Atomics.waitAsync = waitAsync;
      }
    });
  }
}

test("a blocking writer waits for another agent to release the lock", async () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const words = new Int32Array(allocator.share_arrays_memory);
  Atomics.store(words, 0, 1);
  const worker = new Worker(
    new URL("./test_workers/base_call_allocator_worker.ts", import.meta.url)
      .href,
    { type: "module" },
  );

  try {
    const attempting = next_worker_message(worker, 1_000);
    worker.postMessage(allocator.get_object());
    assert.deepStrictEqual(await attempting, { type: "attempting" });
    await expect_no_worker_message(worker, 20);

    const done = next_worker_message(worker, 1_000);
    Atomics.store(words, 0, 0);
    Atomics.notify(words, 0, 1);
    assert.deepStrictEqual(await done, { type: "done" });
    assert.strictEqual(Atomics.load(words, 1), 0);
  } finally {
    Atomics.store(words, 0, 0);
    Atomics.notify(words, 0, 1);
    worker.terminate();
  }
});

test("seeded writes and frees preserve live payloads and fully coalesce", async () => {
  for (const byteLength of [64, 128, 512, 4096]) {
    for (const seed of [1, 0x12345678, 0xdeadbeef]) {
      const allocator = new BaseCallAllocatorUseArrayBuffer(byteLength);
      const attached = BaseCallAllocatorUseArrayBuffer.init_self(
        allocator.get_object(),
      );
      const words = new Int32Array(allocator.share_arrays_memory);
      const live: { allocation: [number, number]; data: Uint8Array }[] = [];
      let state = seed;
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
      };
      for (let step = 0; step < 200; step++) {
        if (live.length > 0 && random() % 100 < 45) {
          const index = random() % live.length;
          const [{ allocation }] = live.splice(index, 1);
          if (step % 2 === 0) allocator.free(...allocation);
          else await attached.async_free(...allocation);
        } else {
          const data = new Uint8Array(1 + (random() % 80)).fill(random() & 255);
          const before = Array.from(words);
          try {
            const allocation =
              step % 2 === 0
                ? allocator.block_write(data)
                : await attached.async_write(data);
            assert.strictEqual(allocation[0] % 8, 0);
            assert.strictEqual(allocation[1], data.byteLength);
            live.push({ allocation, data });
          } catch (error) {
            assert.match(String(error), /out of memory/i);
            assert.deepStrictEqual(Array.from(words), before);
          }
        }
        assert.strictEqual(words[0], 0);
        assert.strictEqual(words[1], live.length);
        assert.ok(words[2] >= 0 && words[2] < words[4]);
        const sorted = [...live].sort(
          (a, b) => a.allocation[0] - b.allocation[0],
        );
        for (let index = 0; index < sorted.length; index++) {
          const { allocation, data } = sorted[index];
          assert.deepStrictEqual(
            new Uint8Array(attached.get_memory(...allocation)),
            data,
          );
          if (index > 0) {
            const previous = sorted[index - 1].allocation;
            assert.ok(previous[0] + previous[1] <= allocation[0]);
          }
        }
      }
      for (const { allocation } of live)
        await attached.async_free(...allocation);
      assert.strictEqual(words[1], 0);
      assert.strictEqual(words[4], 1);
      assert.deepStrictEqual(Array.from(words.slice(8, 12)), [
        words[6],
        byteLength - words[6],
        0,
        1,
      ]);
      const full = allocator.block_write(new Uint8Array(byteLength - words[6]));
      allocator.free(...full);
    }
  }
});
