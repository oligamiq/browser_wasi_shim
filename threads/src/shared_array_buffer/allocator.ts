// @ts-ignore
// import { debug } from "../../debug.js";
// import "../polyfill.js";

/**
 * Represents the serialized state of an AllocatorUseArrayBuffer for thread transfer.
 */
export type AllocatorUseArrayBufferObject = {
  share_arrays_memory: SharedArrayBuffer;
};

/**
 * AllocatorUseArrayBuffer provides a simple shared memory allocator built on top of `SharedArrayBuffer`.
 *
 * It uses atomic operations for thread-safe memory management and a First-Fit-like
 * simplified allocation strategy.
 *
 * Memory Layout:
 * - [0..3]: Lock flag (0 = unlocked, 1 = locked)
 * - [4..7]: Active user count
 * - [8..11]: Current offset for the next allocation
 * - [12..]: Data storage
 */
export class AllocatorUseArrayBuffer {
  // Pass a !Sized type
  // The first 4 bytes are for a lock value: i32
  // The next 4 bytes are for the current number of arrays: m: i32
  // The next 4 bytes are for the length of the occupied space in share_arrays_memory: n: i32
  // Once it is no longer busy, it should become empty immediately, so reset only when it is empty.
  // Even if it becomes too long, it should be fine due to the browser's virtualization.
  // Using an algorithm even simpler than First-Fit
  // SharedArrayBuffer.grow is supported by all major browsers except Android WebView,
  // which does not support SharedArrayBuffer in the first place,
  // but es2024 and the type system does not support it,
  // so the size is fixed from the beginning

  // share_arrays_memory: SharedArrayBuffer = new SharedArrayBuffer(12, {
  //   // 10MB
  //   maxByteLength: 10 * 1024 * 1024,
  // });

  // Even if 100MB is allocated, due to browser virtualization,
  // the memory should not actually be used until it is needed.
  share_arrays_memory: SharedArrayBuffer;

  // When adding data, use Atomics.wait to wait until the first 4 bytes become 0.
  // After that, use Atomics.compareExchange to set the first 4 bytes to 1.
  // Then, use Atomics.add to increment the next 4 bytes by 1.
  // If the return value is 0, proceed to *1.
  // If the return value is 1, use Atomics.wait to wait until the first 4 bytes become 0.
  // *1: Increment the second by 1 using Atomics.add. If the return value is 0, reset it.
  // Add the data. Extend if there is not enough space.
  // To release, just decrement by 1 using Atomics.sub.

  // Since postMessage makes the class an object,
  // it must be able to receive and assign a SharedArrayBuffer.
  /**
   * Initializes a new AllocatorUseArrayBuffer.
   *
   * @param share_arrays_memory The shared memory buffer to manage. Defaults to a 10MB buffer.
   */
  constructor(
    share_arrays_memory: SharedArrayBuffer = new SharedArrayBuffer(
      10 * 1024 * 1024,
    ),
  ) {
    this.share_arrays_memory = share_arrays_memory;
    const view = new Int32Array(this.share_arrays_memory);
    Atomics.store(view, 0, 0);
    Atomics.store(view, 1, 0);
    Atomics.store(view, 2, 12);
  }

  // Since postMessage converts classes to objects,
  // it must be able to convert objects to classes.
  /**
   * Reconstructs an allocator from a transferred object.
   *
   * @param sl The serialized allocator state.
   * @returns A new AllocatorUseArrayBuffer instance.
   */
  static init_self(sl: AllocatorUseArrayBufferObject): AllocatorUseArrayBuffer {
    return new AllocatorUseArrayBuffer(sl.share_arrays_memory);
  }

  // Writes without blocking threads when acquiring locks
  /**
   * Asynchronously writes data to the shared memory.
   *
   * @param data The data to write.
   * @param memory The guest memory buffer to update with the pointer and length.
   * @param ret_ptr The offset in guest memory where the pointer and length should be stored.
   * @returns A promise that resolves to a tuple containing the shared memory offset and the data length.
   */
  async async_write(
    data: Uint8Array | Uint32Array,
    memory: SharedArrayBuffer,
    // ptr, len
    // Pass I32Array ret_ptr
    ret_ptr: number,
  ): Promise<[number, number]> {
    const view = new Int32Array(this.share_arrays_memory);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let lock: "not-equal" | "timed-out" | "ok";
      const { value } = Atomics.waitAsync(view, 0, 1);
      if (value instanceof Promise) {
        lock = await value;
      } else {
        lock = value;
      }
      if (lock === "timed-out") {
        throw new Error("timed-out lock");
      }
      const old = Atomics.compareExchange(view, 0, 0, 1);
      if (old !== 0) {
        continue;
      }

      const ret = this.write_inner(data, memory, ret_ptr);

      // release lock
      Atomics.store(view, 0, 0);
      Atomics.notify(view, 0, 1);

      return ret;
    }
  }

  // Blocking threads for writing when acquiring locks
  block_write(
    data: Uint8Array | Uint32Array,
    memory: SharedArrayBuffer,
    // ptr, len
    ret_ptr: number,
  ): [number, number] {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const view = new Int32Array(this.share_arrays_memory);
      const lock = Atomics.wait(view, 0, 1);
      if (lock === "timed-out") {
        throw new Error("timed-out lock");
      }
      const old = Atomics.compareExchange(view, 0, 0, 1);
      if (old !== 0) {
        continue;
      }

      const ret = this.write_inner(data, memory, ret_ptr);

      // release lock
      Atomics.store(view, 0, 0);
      Atomics.notify(view, 0, 1);

      return ret;
    }
  }

  // Function to write after acquiring a lock
  write_inner(
    data: Uint8Array | Uint32Array,
    memory: SharedArrayBuffer,
    // ptr, len
    ret_ptr: number,
  ): [number, number] {
    // console.log("data", data);

    const view = new Int32Array(this.share_arrays_memory);
    const view8 = new Uint8Array(this.share_arrays_memory);

    // Indicates more users using memory
    const old_num = Atomics.add(view, 1, 1);
    let share_arrays_memory_kept: number;
    if (old_num === 0) {
      // Reset because there were no users.
      // debug.log("reset allocator");
      share_arrays_memory_kept = Atomics.store(view, 2, 12);
    } else {
      share_arrays_memory_kept = Atomics.load(view, 2);
    }
    // console.log("num", Atomics.load(view, 1));

    const memory_len = this.share_arrays_memory.byteLength;
    const len = data.byteLength;
    const new_memory_len = share_arrays_memory_kept + len;
    if (memory_len < new_memory_len) {
      // extend memory
      // support from es2024
      // this.share_arrays_memory.grow(new_memory_len);
      throw new Error(
        "size is bigger than memory. \nTODO! fix memory limit. support big size another way.",
      );
    }

    let data8: Uint8Array;
    if (data instanceof Uint8Array) {
      data8 = data;
    } else if (data instanceof Uint32Array) {
      // data to uint8
      const tmp = new ArrayBuffer(data.byteLength);
      new Uint32Array(tmp).set(data);
      data8 = new Uint8Array(tmp);
    }

    // biome-ignore lint/style/noNonNullAssertion: <explanation>
    view8.set(new Uint8Array(data8!), share_arrays_memory_kept);
    Atomics.store(view, 2, new_memory_len);

    const memory_view = new Int32Array(memory);
    Atomics.store(memory_view, ret_ptr, share_arrays_memory_kept);
    Atomics.store(memory_view, ret_ptr + 1, len);

    // console.log("allocator: allocate", share_arrays_memory_kept, len);

    return [share_arrays_memory_kept, len];
  }

  // free allocated memory
  /**
   * Releases an allocation, decrementing the active user count.
   *
   * @param _pointer The offset of the allocation.
   * @param _len The length of the allocation.
   */
  free(_pointer: number, _len: number) {
    Atomics.sub(new Int32Array(this.share_arrays_memory), 1, 1);

    // console.log("allocator: free", pointer, len);
  }

  // get memory from pointer and length
  /**
   * Retrieves data from the shared memory.
   *
   * @param ptr The offset in shared memory.
   * @param len The length of the data.
   * @returns A new ArrayBuffer containing the data.
   */
  get_memory(ptr: number, len: number): ArrayBuffer {
    const data = new ArrayBuffer(len);
    const view = new Uint8Array(data);
    view.set(new Uint8Array(this.share_arrays_memory).slice(ptr, ptr + len));
    return data;
  }

  // Write again to the memory before releasing
  // Not used because the situation for using it does not exist.
  use_defined_memory(ptr: number, len: number, data: ArrayBufferLike) {
    const memory = new Uint8Array(this.share_arrays_memory);
    memory.set(new Uint8Array(data).slice(0, len), ptr);
  }

  /**
   * Returns a serializable representation of this allocator.
   *
   * @returns An AllocatorUseArrayBufferObject containing the shared state.
   */
  get_object(): AllocatorUseArrayBufferObject {
    return {
      share_arrays_memory: this.share_arrays_memory,
    };
  }
}
