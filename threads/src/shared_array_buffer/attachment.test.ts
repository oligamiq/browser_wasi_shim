import assert from "node:assert";
import test from "node:test";
import { ALLOCATOR_DATA_OFFSET, AllocatorUseArrayBuffer } from "./allocator.js";
import { FdCloseSenderUseArrayBuffer } from "./fd_close_sender.js";

test("allocator attachment preserves headers and allocated bytes", () => {
  const allocator = new AllocatorUseArrayBuffer();
  const guestMemory = new SharedArrayBuffer(8);
  const [pointer, length] = allocator.block_write(
    new Uint8Array([1, 2, 3]),
    guestMemory,
    0,
  );
  const header = new Int32Array(allocator.share_arrays_memory);
  const bytes = new Uint8Array(allocator.share_arrays_memory);
  const expectedHeader = Array.from(header.slice(0, 3));
  const expectedBytes = Array.from(bytes.slice(pointer, pointer + length));

  const attached = AllocatorUseArrayBuffer.init_self(allocator.get_object());

  assert.deepStrictEqual(Array.from(header.slice(0, 3)), expectedHeader);
  assert.deepStrictEqual(
    Array.from(bytes.slice(pointer, pointer + length)),
    expectedBytes,
  );
  attached.free(pointer, length);
});

test("fd-close sender attachment preserves queued notifications", async () => {
  const sender = new FdCloseSenderUseArrayBuffer();
  await sender.send([7], 42);

  const attached = FdCloseSenderUseArrayBuffer.init_self(sender.get_object());

  assert.deepStrictEqual(attached.get(7), [42]);
});

test("oversized allocator writes roll back the lock and active count", () => {
  const allocator = new AllocatorUseArrayBuffer(new SharedArrayBuffer(64));
  const guestMemory = new SharedArrayBuffer(8);

  assert.throws(() =>
    allocator.block_write(new Uint8Array(128), guestMemory, 0),
  );

  const header = new Int32Array(allocator.share_arrays_memory);
  assert.strictEqual(Atomics.load(header, 0), 0);
  assert.strictEqual(Atomics.load(header, 1), 0);

  const [pointer, length] = allocator.block_write(
    new Uint8Array([1]),
    guestMemory,
    0,
  );
  assert.deepStrictEqual([pointer, length], [12, 1]);
  allocator.free(pointer, length);
});

test("allocator take rejects header ranges without releasing ownership", () => {
  const allocator = new AllocatorUseArrayBuffer(new SharedArrayBuffer(64));
  const guestMemory = new SharedArrayBuffer(8);
  const allocation = allocator.block_write(
    new Uint8Array([1, 2, 3, 4]),
    guestMemory,
    0,
  );
  const words = new Int32Array(allocator.share_arrays_memory);

  assert.strictEqual(ALLOCATOR_DATA_OFFSET, 12);
  assert.strictEqual(allocation[0], ALLOCATOR_DATA_OFFSET);
  for (const pointer of [0, 4, 8]) {
    assert.throws(() => allocator.take_memory(pointer, 4), RangeError);
    assert.strictEqual(Atomics.load(words, 1), 1);
  }
  assert.throws(() => allocator.take_memory(60, 8), RangeError);
  assert.strictEqual(Atomics.load(words, 1), 1);

  assert.deepStrictEqual(
    Array.from(new Uint8Array(allocator.take_memory(...allocation))),
    [1, 2, 3, 4],
  );
  assert.strictEqual(Atomics.load(words, 1), 0);
});
