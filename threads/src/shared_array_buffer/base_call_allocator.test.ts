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

test("initializes the allocator and first free block headers", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const words = new Int32Array(allocator.share_arrays_memory);

  assert.deepStrictEqual(
    Array.from(words.slice(0, 8)),
    [0, 16, 0, 0x42434132, 32, 0, 1, 0],
  );
});

test("handles zero-length payloads without creating ownership", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);

  assert.deepStrictEqual(allocator.block_write(new Uint8Array()), [0, 0]);
  assert.strictEqual(allocator.get_memory(0, 0).byteLength, 0);
  assert.doesNotThrow(() => allocator.free(0, 0));
  assert.strictEqual(new Int32Array(allocator.share_arrays_memory)[2], 0);
});

test("aligns split blocks and keeps undersized remainders", () => {
  const split = new BaseCallAllocatorUseArrayBuffer(80);
  assert.deepStrictEqual(
    split.block_write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])),
    [32, 9],
  );
  const splitWords = new Int32Array(split.share_arrays_memory);
  assert.deepStrictEqual(Array.from(splitWords.slice(4, 8)), [16, 48, 0, 9]);
  assert.deepStrictEqual(Array.from(splitWords.slice(12, 16)), [16, 0, 1, 0]);

  const unsplit = new BaseCallAllocatorUseArrayBuffer(64);
  assert.deepStrictEqual(unsplit.block_write(new Uint8Array(9)), [32, 9]);
  assert.deepStrictEqual(
    Array.from(new Int32Array(unsplit.share_arrays_memory).slice(4, 8)),
    [32, 0, 0, 9],
  );
});

test("reuses first-fit blocks and coalesces adjacent frees", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(128);
  const [first] = allocator.block_write(new Uint8Array([1]));
  const [middle] = allocator.block_write(new Uint8Array([2]));
  const [last] = allocator.block_write(new Uint8Array([3]));

  assert.deepStrictEqual([first, middle, last], [32, 56, 80]);
  allocator.free(middle, 1);
  const [reused] = allocator.block_write(new Uint8Array([4]));
  assert.strictEqual(reused, middle);

  allocator.free(first, 1);
  allocator.free(reused, 1);
  const [coalesced] = allocator.block_write(new Uint8Array(24));
  assert.strictEqual(coalesced, first);

  allocator.free(coalesced, 24);
  allocator.free(last, 1);
  const words = new Int32Array(allocator.share_arrays_memory);
  assert.deepStrictEqual(
    Array.from(words.slice(1, 8)),
    [16, 0, 0x42434132, 96, 0, 1, 0],
  );
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

test("recovers after out-of-memory without poisoning allocator state", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);

  assert.throws(
    () => allocator.block_write(new Uint8Array(33)),
    /out of memory/i,
  );
  const words = new Int32Array(allocator.share_arrays_memory);
  assert.deepStrictEqual(Array.from(words.slice(0, 3)), [0, 16, 0]);

  const allocation = allocator.block_write(new Uint8Array([1]));
  assert.deepStrictEqual(allocation, [32, 1]);
  allocator.free(...allocation);
});

test("rejects wrong, out-of-range, and duplicate frees", () => {
  const allocator = new BaseCallAllocatorUseArrayBuffer(64);
  const allocation = allocator.block_write(new Uint8Array([1, 2, 3]));

  assert.throws(() => allocator.free(allocation[0], 2));
  assert.throws(() => allocator.free(allocation[0] + 8, allocation[1]));
  assert.throws(() => allocator.free(-8, allocation[1]));
  assert.strictEqual(new Int32Array(allocator.share_arrays_memory)[2], 1);

  allocator.free(...allocation);
  assert.throws(() => allocator.free(...allocation), /freed/i);
  assert.strictEqual(new Int32Array(allocator.share_arrays_memory)[2], 0);
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
  const middleWord = (middle[0] - 16) / 4;
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
  words[(allocation[0] - 16) / 4 + 2] = 2;
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
  words[(allocation[0] - 16) / 4 + 3] = allocation[1];
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
    words[(allocation[0] - 16) / 4 + 3] = requestedLength;
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

  assert.deepStrictEqual(allocation, [32, 3]);
  assert.deepStrictEqual(
    Array.from(new Uint8Array(allocator.get_memory(...allocation))),
    [9, 8, 7],
  );
  allocator.free(...allocation);
});

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
    assert.strictEqual(Atomics.load(words, 2), 0);
  } finally {
    Atomics.store(words, 0, 0);
    Atomics.notify(words, 0, 1);
    worker.terminate();
  }
});
