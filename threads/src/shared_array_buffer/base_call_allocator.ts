const DEFAULT_BYTE_LENGTH = 10 * 1024 * 1024;
const MIN_BYTE_LENGTH = 64;
const MAX_BYTE_LENGTH = 0x7ffffff8;
const GLOBAL_HEADER_BYTES = 16;
const BLOCK_HEADER_BYTES = 16;
const MIN_BLOCK_PAYLOAD_BYTES = 8;
const MAGIC = 0x42434132;

/**
 * Cloneable shared state for a base-call allocator.
 *
 * Cloning this object does not block or transfer allocation ownership; every
 * attached instance coordinates access to the same shared allocations.
 */
export type BaseCallAllocatorUseArrayBufferObject = {
  share_arrays_memory: SharedArrayBuffer;
};

/**
 * Concurrent first-fit allocator for base-call payloads.
 *
 * Metadata operations briefly block on a shared lock. A successful write gives
 * the caller ownership of its pointer/length pair until exactly one `free`.
 */
export class BaseCallAllocatorUseArrayBuffer {
  /** Shared storage; direct mutation does not change allocation ownership. */
  readonly share_arrays_memory: SharedArrayBuffer;

  /**
   * Creates and owns a new allocator buffer without blocking on another agent.
   * The new instance initially owns no payload allocations.
   */
  constructor(byteLength = DEFAULT_BYTE_LENGTH) {
    if (
      !Number.isInteger(byteLength) ||
      byteLength < MIN_BYTE_LENGTH ||
      byteLength > MAX_BYTE_LENGTH ||
      byteLength % 8 !== 0
    ) {
      throw new RangeError(
        `byteLength must be an 8-byte multiple from ${MIN_BYTE_LENGTH} through ${MAX_BYTE_LENGTH}`,
      );
    }

    this.share_arrays_memory = new SharedArrayBuffer(byteLength);
    const words = new Int32Array(this.share_arrays_memory);
    words[0] = 0;
    words[1] = GLOBAL_HEADER_BYTES;
    words[2] = 0;
    words[3] = MAGIC;
    words[4] = byteLength - GLOBAL_HEADER_BYTES - BLOCK_HEADER_BYTES;
    words[5] = 0;
    words[6] = 1;
    words[7] = 0;
  }

  /**
   * Attaches to cloned shared state without blocking or storing into it.
   * Existing allocation ownership remains with the agents that own each pair.
   */
  static init_self(
    object: BaseCallAllocatorUseArrayBufferObject,
  ): BaseCallAllocatorUseArrayBuffer {
    const memory = object?.share_arrays_memory;
    if (!(memory instanceof SharedArrayBuffer)) {
      throw new TypeError("allocator object must contain a SharedArrayBuffer");
    }
    if (
      memory.byteLength < MIN_BYTE_LENGTH ||
      memory.byteLength > MAX_BYTE_LENGTH ||
      memory.byteLength % 8 !== 0
    ) {
      throw new RangeError("allocator object has an invalid buffer size");
    }
    if (Atomics.load(new Int32Array(memory), 3) !== MAGIC) {
      throw new Error("allocator object has invalid magic");
    }

    const allocator = Object.create(
      BaseCallAllocatorUseArrayBuffer.prototype,
    ) as BaseCallAllocatorUseArrayBuffer;
    Object.defineProperty(allocator, "share_arrays_memory", {
      value: memory,
      enumerable: true,
    });
    return allocator;
  }

  /**
   * Blocks the current agent while allocator metadata is locked, then copies
   * `data`. The caller owns the returned pair and must release it with `free`.
   */
  block_write(data: Uint8Array): [pointer: number, length: number] {
    if (data.byteLength === 0) {
      return [0, 0];
    }

    const allocation = this.with_blocking_lock((words) =>
      this.reserve_locked(words, data.byteLength),
    );
    new Uint8Array(this.share_arrays_memory).set(data, allocation[0]);
    return allocation;
  }

  /**
   * Asynchronously waits for allocator metadata, then copies `data`. The caller
   * owns the returned pair and must release it exactly once with `free`.
   */
  async async_write(
    data: Uint8Array,
  ): Promise<[pointer: number, length: number]> {
    if (data.byteLength === 0) {
      return [0, 0];
    }

    const allocation = await this.with_async_lock((words) =>
      this.reserve_locked(words, data.byteLength),
    );
    new Uint8Array(this.share_arrays_memory).set(data, allocation[0]);
    return allocation;
  }

  /**
   * Blocks briefly to validate an owned allocation, then returns an independent
   * copy. Reading does not transfer or release the caller's allocation.
   */
  get_memory(pointer: number, length: number): ArrayBuffer {
    if (pointer === 0 && length === 0) {
      return new ArrayBuffer(0);
    }

    this.with_blocking_lock((words) => {
      this.find_allocated_block(words, pointer, length);
    });
    const copy = new ArrayBuffer(length);
    new Uint8Array(copy).set(
      new Uint8Array(this.share_arrays_memory, pointer, length),
    );
    return copy;
  }

  /**
   * Blocks briefly while releasing exactly the allocation identified by the
   * pair. A successful call relinquishes the caller's ownership permanently.
   */
  free(pointer: number, length: number): void {
    if (pointer === 0 && length === 0) {
      return;
    }

    this.with_blocking_lock((words) => {
      const blockOffset = this.find_allocated_block(words, pointer, length);
      const blockWord = blockOffset / 4;
      const nextOffset = words[blockWord + 1];
      if (nextOffset !== 0) {
        this.validate_block(words, nextOffset);
      }

      words[blockWord + 2] = 1;
      words[blockWord + 3] = 0;
      Atomics.sub(words, 2, 1);

      if (nextOffset !== 0) {
        const nextWord = nextOffset / 4;
        if (words[nextWord + 2] === 1) {
          words[blockWord] += BLOCK_HEADER_BYTES + words[nextWord];
          words[blockWord + 1] = words[nextWord + 1];
        }
      }

      let previousOffset = 0;
      let currentOffset = words[1];
      while (currentOffset !== 0 && currentOffset !== blockOffset) {
        previousOffset = currentOffset;
        currentOffset = words[currentOffset / 4 + 1];
      }
      if (currentOffset === 0) {
        throw new Error("corrupt allocator block list");
      }
      if (previousOffset !== 0) {
        const previousWord = previousOffset / 4;
        if (words[previousWord + 2] === 1) {
          words[previousWord] += BLOCK_HEADER_BYTES + words[blockWord];
          words[previousWord + 1] = words[blockWord + 1];
        }
      }
    });
  }

  /**
   * Returns cloneable shared state without blocking or transferring ownership.
   * Allocations remain owned by the callers holding their pointer/length pairs.
   */
  get_object(): BaseCallAllocatorUseArrayBufferObject {
    return { share_arrays_memory: this.share_arrays_memory };
  }

  private reserve_locked(
    words: Int32Array,
    length: number,
  ): [pointer: number, length: number] {
    const alignedLength = Math.ceil(length / 8) * 8;
    let blockOffset = words[1];

    while (blockOffset !== 0) {
      this.validate_block(words, blockOffset);
      const blockWord = blockOffset / 4;
      const payloadSize = words[blockWord];
      const nextOffset = words[blockWord + 1];
      const isFree = words[blockWord + 2] === 1;

      if (isFree && payloadSize >= alignedLength) {
        const remainder = payloadSize - alignedLength;
        if (remainder >= BLOCK_HEADER_BYTES + MIN_BLOCK_PAYLOAD_BYTES) {
          const splitOffset = blockOffset + BLOCK_HEADER_BYTES + alignedLength;
          const splitWord = splitOffset / 4;
          words[splitWord] = remainder - BLOCK_HEADER_BYTES;
          words[splitWord + 1] = nextOffset;
          words[splitWord + 2] = 1;
          words[splitWord + 3] = 0;
          words[blockWord] = alignedLength;
          words[blockWord + 1] = splitOffset;
        }

        words[blockWord + 2] = 0;
        words[blockWord + 3] = length;
        Atomics.add(words, 2, 1);
        const pointer = blockOffset + BLOCK_HEADER_BYTES;
        return [pointer, length];
      }

      blockOffset = nextOffset;
    }

    throw new RangeError("base call allocator is out of memory");
  }

  private with_blocking_lock<T>(operation: (words: Int32Array) => T): T {
    const words = new Int32Array(this.share_arrays_memory);
    while (Atomics.compareExchange(words, 0, 0, 1) !== 0) {
      Atomics.wait(words, 0, 1);
    }

    try {
      return operation(words);
    } finally {
      Atomics.store(words, 0, 0);
      Atomics.notify(words, 0, 1);
    }
  }

  private async with_async_lock<T>(
    operation: (words: Int32Array) => T,
  ): Promise<T> {
    const words = new Int32Array(this.share_arrays_memory);
    while (Atomics.compareExchange(words, 0, 0, 1) !== 0) {
      const waiter = Atomics.waitAsync(words, 0, 1).value;
      if (waiter instanceof Promise) {
        await waiter;
      }
    }

    try {
      return operation(words);
    } finally {
      Atomics.store(words, 0, 0);
      Atomics.notify(words, 0, 1);
    }
  }

  private find_allocated_block(
    words: Int32Array,
    pointer: number,
    length: number,
  ): number {
    if (
      !Number.isInteger(pointer) ||
      !Number.isInteger(length) ||
      pointer < GLOBAL_HEADER_BYTES + BLOCK_HEADER_BYTES ||
      pointer % 8 !== 0 ||
      length <= 0 ||
      pointer + length > this.share_arrays_memory.byteLength
    ) {
      throw new RangeError("invalid allocation range");
    }

    let blockOffset = words[1];
    while (blockOffset !== 0) {
      this.validate_block(words, blockOffset);
      const blockWord = blockOffset / 4;
      if (blockOffset + BLOCK_HEADER_BYTES === pointer) {
        if (words[blockWord + 2] !== 0) {
          throw new Error("allocation has already been freed");
        }
        if (words[blockWord + 3] !== length) {
          throw new RangeError("allocation length does not match");
        }
        return blockOffset;
      }
      blockOffset = words[blockWord + 1];
    }

    throw new RangeError("allocation pointer was not found");
  }

  private validate_block(words: Int32Array, blockOffset: number): void {
    if (
      blockOffset < GLOBAL_HEADER_BYTES ||
      blockOffset % 8 !== 0 ||
      blockOffset + BLOCK_HEADER_BYTES > this.share_arrays_memory.byteLength
    ) {
      throw new Error("corrupt allocator block offset");
    }

    const blockWord = blockOffset / 4;
    const payloadSize = words[blockWord];
    const nextOffset = words[blockWord + 1];
    const freeFlag = words[blockWord + 2];
    const requestedLength = words[blockWord + 3];
    const hasInvalidAllocationState =
      (freeFlag !== 0 && freeFlag !== 1) ||
      (freeFlag === 1 && requestedLength !== 0) ||
      (freeFlag === 0 &&
        (requestedLength < 1 || requestedLength > payloadSize));
    if (
      payloadSize < MIN_BLOCK_PAYLOAD_BYTES ||
      payloadSize % 8 !== 0 ||
      blockOffset + BLOCK_HEADER_BYTES + payloadSize >
        this.share_arrays_memory.byteLength ||
      (nextOffset !== 0 &&
        nextOffset !== blockOffset + BLOCK_HEADER_BYTES + payloadSize) ||
      hasInvalidAllocationState
    ) {
      throw new Error("corrupt allocator block header");
    }
  }
}
