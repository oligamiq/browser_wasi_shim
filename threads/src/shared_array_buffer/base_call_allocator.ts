const DEFAULT_BYTE_LENGTH = 10 * 1024 * 1024;
const MIN_BYTE_LENGTH = 64;
const MAX_BYTE_LENGTH = 0x7ffffff8;
const GLOBAL_HEADER_BYTES = 32;
const EXTENT_WORDS = 4;
const EXTENT_BYTES = EXTENT_WORDS * Int32Array.BYTES_PER_ELEMENT;
const MIN_EXTENT_BYTES = 8;
const MAX_EXTENT_COUNT = 2056;
const MAGIC = 0x42434132;
const VERSION = 1;

const LOCK_WORD = 0;
const ACTIVE_ALLOCATION_WORD = 1;
const NEXT_FIT_WORD = 2;
const MAGIC_WORD = 3;
const EXTENT_COUNT_WORD = 4;
const EXTENT_CAPACITY_WORD = 5;
const DATA_START_WORD = 6;
const VERSION_WORD = 7;

const EXTENT_OFFSET = 0;
const EXTENT_CAPACITY = 1;
const EXTENT_REQUESTED_LENGTH = 2;
const EXTENT_FREE = 3;

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
 * Concurrent allocator for base-call payloads.
 *
 * The buffer contains a fixed-size extent table followed by payload storage.
 * Extents stay sorted and contiguous, allocation uses a next-fit cursor, and
 * freeing immediately coalesces adjacent free extents. Metadata operations
 * briefly hold one shared lock; payload copies happen after the lock is
 * released. Callers must retain ownership until pending reads finish. Pairs
 * have no generation: a stale pair can identify a later allocation after reuse.
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

    const extentCapacity = Math.max(
      1,
      Math.min(
        MAX_EXTENT_COUNT,
        Math.floor(
          (byteLength - GLOBAL_HEADER_BYTES) /
            (EXTENT_BYTES + MIN_EXTENT_BYTES),
        ),
        Math.max(4, Math.floor((byteLength - GLOBAL_HEADER_BYTES) / 64)),
      ),
    );
    const dataStart = GLOBAL_HEADER_BYTES + extentCapacity * EXTENT_BYTES;
    if (dataStart + MIN_EXTENT_BYTES > byteLength) {
      throw new RangeError("byteLength cannot hold allocator metadata");
    }

    this.share_arrays_memory = new SharedArrayBuffer(byteLength);
    const words = new Int32Array(this.share_arrays_memory);
    words[LOCK_WORD] = 0;
    words[ACTIVE_ALLOCATION_WORD] = 0;
    words[NEXT_FIT_WORD] = 0;
    words[MAGIC_WORD] = MAGIC;
    words[EXTENT_COUNT_WORD] = 1;
    words[EXTENT_CAPACITY_WORD] = extentCapacity;
    words[DATA_START_WORD] = dataStart;
    words[VERSION_WORD] = VERSION;

    const firstExtent = GLOBAL_HEADER_BYTES / 4;
    words[firstExtent + EXTENT_OFFSET] = dataStart;
    words[firstExtent + EXTENT_CAPACITY] = byteLength - dataStart;
    words[firstExtent + EXTENT_REQUESTED_LENGTH] = 0;
    words[firstExtent + EXTENT_FREE] = 1;
  }

  /**
   * Validates the immutable header and attaches without acquiring the lock or
   * storing into shared state. Existing allocation ownership remains with the
   * agents that own each pair; incompatible or malformed headers are rejected.
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
    BaseCallAllocatorUseArrayBuffer.validate_header(new Int32Array(memory));

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
   * Snapshots `data` before blocking on allocator metadata. The caller owns the
   * returned pair and must release it with `free`. Invalid input or a failed
   * payload copy leaves no new allocation owned by the caller.
   */
  block_write(data: Uint8Array): [pointer: number, length: number] {
    const snapshot = new Uint8Array(data);
    if (snapshot.byteLength === 0) {
      return [0, 0];
    }

    const allocation = this.with_blocking_lock((words) =>
      this.reserve_locked(words, snapshot.byteLength),
    );
    try {
      new Uint8Array(this.share_arrays_memory, ...allocation).set(snapshot);
    } catch (error) {
      this.free(...allocation);
      throw error;
    }
    return allocation;
  }

  /**
   * Snapshots `data` before asynchronously waiting for allocator metadata. The
   * caller owns the returned pair and must release it exactly once with `free`
   * or `async_free`. A failed payload copy releases its reservation first.
   */
  async async_write(
    data: Uint8Array,
  ): Promise<[pointer: number, length: number]> {
    const snapshot = new Uint8Array(data);
    if (snapshot.byteLength === 0) {
      return [0, 0];
    }

    const allocation = await this.with_async_lock((words) =>
      this.reserve_locked(words, snapshot.byteLength),
    );
    try {
      new Uint8Array(this.share_arrays_memory, ...allocation).set(snapshot);
    } catch (error) {
      await this.async_free(...allocation);
      throw error;
    }
    return allocation;
  }

  /**
   * Blocks briefly to validate an owned allocation, then returns an independent
   * copy. Reading does not transfer or release the caller's allocation; no other
   * agent may free or reuse it while the read is in progress.
   */
  get_memory(pointer: number, length: number): ArrayBuffer {
    if (pointer === 0 && length === 0) {
      return new ArrayBuffer(0);
    }

    this.with_blocking_lock((words) => {
      this.find_allocated_extent(words, pointer, length);
    });
    const copy = new ArrayBuffer(length);
    new Uint8Array(copy).set(
      new Uint8Array(this.share_arrays_memory, pointer, length),
    );
    return copy;
  }

  /**
   * Asynchronously validates an owned allocation and returns an independent
   * copy without blocking the current agent while waiting for metadata. The
   * caller must not free or reuse the pair until this read settles.
   */
  async async_get_memory(
    pointer: number,
    length: number,
  ): Promise<ArrayBuffer> {
    if (pointer === 0 && length === 0) {
      return new ArrayBuffer(0);
    }

    await this.with_async_lock((words) => {
      this.find_allocated_extent(words, pointer, length);
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
      this.release_locked(words, pointer, length);
    });
  }

  /**
   * Asynchronously releases an owned allocation without blocking the current
   * agent while waiting for metadata.
   */
  async async_free(pointer: number, length: number): Promise<void> {
    if (pointer === 0 && length === 0) {
      return;
    }

    await this.with_async_lock((words) => {
      this.release_locked(words, pointer, length);
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
    if (!Number.isInteger(length) || length <= 0 || length > MAX_BYTE_LENGTH) {
      throw new RangeError("invalid allocation length");
    }
    this.validate_metadata(words);
    const alignedLength =
      Math.ceil(length / MIN_EXTENT_BYTES) * MIN_EXTENT_BYTES;
    const extentCount = words[EXTENT_COUNT_WORD];
    const start = words[NEXT_FIT_WORD] % extentCount;

    for (let scanned = 0; scanned < extentCount; scanned++) {
      const extentIndex = (start + scanned) % extentCount;
      const extentWord = this.extent_word(extentIndex);
      const extentCapacity = words[extentWord + EXTENT_CAPACITY];
      if (
        words[extentWord + EXTENT_FREE] !== 1 ||
        extentCapacity < alignedLength
      ) {
        continue;
      }

      const remainder = extentCapacity - alignedLength;
      if (
        remainder >= MIN_EXTENT_BYTES &&
        extentCount < words[EXTENT_CAPACITY_WORD]
      ) {
        this.insert_extent(words, extentIndex + 1);
        const splitWord = this.extent_word(extentIndex + 1);
        words[splitWord + EXTENT_OFFSET] =
          words[extentWord + EXTENT_OFFSET] + alignedLength;
        words[splitWord + EXTENT_CAPACITY] = remainder;
        words[splitWord + EXTENT_REQUESTED_LENGTH] = 0;
        words[splitWord + EXTENT_FREE] = 1;
        words[extentWord + EXTENT_CAPACITY] = alignedLength;
      }

      words[extentWord + EXTENT_FREE] = 0;
      words[extentWord + EXTENT_REQUESTED_LENGTH] = length;
      Atomics.add(words, ACTIVE_ALLOCATION_WORD, 1);
      words[NEXT_FIT_WORD] =
        extentIndex + 1 < words[EXTENT_COUNT_WORD] ? extentIndex + 1 : 0;
      return [words[extentWord + EXTENT_OFFSET], length];
    }

    throw new RangeError("base call allocator is out of memory");
  }

  private with_blocking_lock<T>(operation: (words: Int32Array) => T): T {
    const words = new Int32Array(this.share_arrays_memory);
    for (;;) {
      const previous = Atomics.compareExchange(words, LOCK_WORD, 0, 1);
      if (previous === 0) break;
      if (previous !== 1) throw new Error("corrupt allocator lock");
      Atomics.wait(words, LOCK_WORD, 1);
    }

    try {
      return operation(words);
    } finally {
      Atomics.store(words, LOCK_WORD, 0);
      Atomics.notify(words, LOCK_WORD, 1);
    }
  }

  private async with_async_lock<T>(
    operation: (words: Int32Array) => T,
  ): Promise<T> {
    const words = new Int32Array(this.share_arrays_memory);
    for (;;) {
      const previous = Atomics.compareExchange(words, LOCK_WORD, 0, 1);
      if (previous === 0) break;
      if (previous !== 1) throw new Error("corrupt allocator lock");
      const waiter = Atomics.waitAsync(words, LOCK_WORD, 1).value;
      if (waiter instanceof Promise) {
        await waiter;
      }
    }

    try {
      return operation(words);
    } finally {
      Atomics.store(words, LOCK_WORD, 0);
      Atomics.notify(words, LOCK_WORD, 1);
    }
  }

  private find_allocated_extent(
    words: Int32Array,
    pointer: number,
    length: number,
  ): number {
    this.validate_metadata(words);
    if (
      !Number.isInteger(pointer) ||
      !Number.isInteger(length) ||
      pointer < words[DATA_START_WORD] ||
      pointer % MIN_EXTENT_BYTES !== 0 ||
      length <= 0 ||
      pointer + length > this.share_arrays_memory.byteLength
    ) {
      throw new RangeError("invalid allocation range");
    }

    const extentCount = words[EXTENT_COUNT_WORD];
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex++) {
      const extentWord = this.extent_word(extentIndex);
      if (words[extentWord + EXTENT_OFFSET] !== pointer) {
        continue;
      }
      if (words[extentWord + EXTENT_FREE] !== 0) {
        throw new Error("allocation has already been freed");
      }
      if (words[extentWord + EXTENT_REQUESTED_LENGTH] !== length) {
        throw new RangeError("allocation length does not match");
      }
      return extentIndex;
    }

    throw new RangeError("allocation pointer was not found");
  }

  private static validate_header(words: Int32Array): void {
    if (Atomics.load(words, MAGIC_WORD) !== MAGIC) {
      throw new Error("allocator object has invalid magic");
    }
    const version = Atomics.load(words, VERSION_WORD);
    const extentCapacity = Atomics.load(words, EXTENT_CAPACITY_WORD);
    const dataStart = Atomics.load(words, DATA_START_WORD);
    if (
      version !== VERSION ||
      extentCapacity < 1 ||
      extentCapacity > MAX_EXTENT_COUNT ||
      dataStart !== GLOBAL_HEADER_BYTES + extentCapacity * EXTENT_BYTES ||
      dataStart % MIN_EXTENT_BYTES !== 0 ||
      dataStart + MIN_EXTENT_BYTES > words.buffer.byteLength
    ) {
      throw new Error("corrupt allocator metadata");
    }
  }

  private validate_metadata(words: Int32Array): void {
    BaseCallAllocatorUseArrayBuffer.validate_header(words);

    const extentCount = words[EXTENT_COUNT_WORD];
    if (
      extentCount < 1 ||
      extentCount > words[EXTENT_CAPACITY_WORD] ||
      words[NEXT_FIT_WORD] < 0 ||
      words[NEXT_FIT_WORD] >= extentCount ||
      words[ACTIVE_ALLOCATION_WORD] < 0 ||
      words[ACTIVE_ALLOCATION_WORD] > extentCount
    ) {
      throw new Error("corrupt allocator metadata");
    }

    let expectedOffset = words[DATA_START_WORD];
    let activeAllocations = 0;
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex++) {
      const extentWord = this.extent_word(extentIndex);
      const offset = words[extentWord + EXTENT_OFFSET];
      const capacity = words[extentWord + EXTENT_CAPACITY];
      const requestedLength = words[extentWord + EXTENT_REQUESTED_LENGTH];
      const free = words[extentWord + EXTENT_FREE];
      if (
        offset !== expectedOffset ||
        offset % MIN_EXTENT_BYTES !== 0 ||
        capacity < MIN_EXTENT_BYTES ||
        capacity % MIN_EXTENT_BYTES !== 0 ||
        offset + capacity > this.share_arrays_memory.byteLength ||
        (free !== 0 && free !== 1) ||
        (free === 1 && requestedLength !== 0) ||
        (free === 0 && (requestedLength < 1 || requestedLength > capacity))
      ) {
        throw new Error("corrupt allocator extent table");
      }
      if (free === 0) {
        activeAllocations++;
      }
      if (
        extentIndex > 0 &&
        free === 1 &&
        words[this.extent_word(extentIndex - 1) + EXTENT_FREE] === 1
      ) {
        throw new Error("corrupt allocator extent table");
      }
      expectedOffset += capacity;
    }
    if (
      expectedOffset !== this.share_arrays_memory.byteLength ||
      activeAllocations !== words[ACTIVE_ALLOCATION_WORD]
    ) {
      throw new Error("corrupt allocator extent table");
    }

    for (
      let extentIndex = extentCount;
      extentIndex < words[EXTENT_CAPACITY_WORD];
      extentIndex++
    ) {
      const extentWord = this.extent_word(extentIndex);
      if (
        words[extentWord + EXTENT_OFFSET] !== 0 ||
        words[extentWord + EXTENT_CAPACITY] !== 0 ||
        words[extentWord + EXTENT_REQUESTED_LENGTH] !== 0 ||
        words[extentWord + EXTENT_FREE] !== 0
      ) {
        throw new Error("corrupt allocator extent table");
      }
    }
  }

  private insert_extent(words: Int32Array, extentIndex: number): void {
    const extentCount = words[EXTENT_COUNT_WORD];
    for (let index = extentCount; index > extentIndex; index--) {
      const destination = this.extent_word(index);
      const source = this.extent_word(index - 1);
      words.copyWithin(destination, source, source + EXTENT_WORDS);
    }
    words[EXTENT_COUNT_WORD] = extentCount + 1;
  }

  private remove_extent(words: Int32Array, extentIndex: number): void {
    const extentCount = words[EXTENT_COUNT_WORD];
    for (let index = extentIndex; index < extentCount - 1; index++) {
      const destination = this.extent_word(index);
      const source = this.extent_word(index + 1);
      words.copyWithin(destination, source, source + EXTENT_WORDS);
    }
    const last = this.extent_word(extentCount - 1);
    words.fill(0, last, last + EXTENT_WORDS);
    words[EXTENT_COUNT_WORD] = extentCount - 1;
    if (words[NEXT_FIT_WORD] > extentIndex) {
      words[NEXT_FIT_WORD]--;
    }
  }

  private extent_word(extentIndex: number): number {
    return GLOBAL_HEADER_BYTES / 4 + extentIndex * EXTENT_WORDS;
  }

  private release_locked(
    words: Int32Array,
    pointer: number,
    length: number,
  ): void {
    let extentIndex = this.find_allocated_extent(words, pointer, length);
    const extentWord = this.extent_word(extentIndex);
    words[extentWord + EXTENT_FREE] = 1;
    words[extentWord + EXTENT_REQUESTED_LENGTH] = 0;
    Atomics.sub(words, ACTIVE_ALLOCATION_WORD, 1);

    if (extentIndex + 1 < words[EXTENT_COUNT_WORD]) {
      const nextWord = this.extent_word(extentIndex + 1);
      if (words[nextWord + EXTENT_FREE] === 1) {
        words[extentWord + EXTENT_CAPACITY] +=
          words[nextWord + EXTENT_CAPACITY];
        this.remove_extent(words, extentIndex + 1);
      }
    }

    if (extentIndex > 0) {
      const previousWord = this.extent_word(extentIndex - 1);
      if (words[previousWord + EXTENT_FREE] === 1) {
        words[previousWord + EXTENT_CAPACITY] +=
          words[extentWord + EXTENT_CAPACITY];
        this.remove_extent(words, extentIndex);
      }
    }

    if (words[NEXT_FIT_WORD] >= words[EXTENT_COUNT_WORD]) {
      words[NEXT_FIT_WORD] = 0;
    }
  }
}
