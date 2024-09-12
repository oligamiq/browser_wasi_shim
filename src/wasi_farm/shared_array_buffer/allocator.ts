// @ts-ignore
// import { debug } from "../../debug.js";
import "../polyfill.js";

export class Allocator {
  // !Sizedを渡す
  // 最初の4byteはロック用の値: i32
  // 次の4byteは現在のarrayの数: m: i32
  // 次の4byteはshare_arrays_memoryの使っている場所の長さ: n: i32
  // busyでなくなれば直ぐに空になるはずなので、空になったときだけリセットする。
  // 長くなりすぎても、ブラウザの仮想化により大丈夫なはず
  // First-Fitよりもさらに簡素なアルゴリズムを使う
  // SharedArrayBuffer.grow is supported by all major browsers except Android WebView,
  // which does not support SharedArrayBuffer in the first place,
  // but es2024 and the type system does not support it,
  // so the size is fixed from the beginning

  // share_arrays_memory: SharedArrayBuffer = new SharedArrayBuffer(12, {
  //   // 10MB
  //   maxByteLength: 10 * 1024 * 1024,
  // });

  // 100MB割り当てたとしても、ブラウザの仮想化により、実際には、使うとするまでメモリを使わないはず
  share_arrays_memory: SharedArrayBuffer;

  // データを追加するときは、Atomics.waitで、最初の4byteが0になるまで待つ
  // その後、Atomics.compareExchangeで、最初の4byteを1にする
  // その後、Atomics.addで、次の4byteを1増やす
  // 上の返り値が0ならば、*1
  // 上の返り値が1ならば、Atomics.waitで、最初の4byteが0になるまで待つ
  // *1: 2番目をAtomics.addで1増やす。返り値が0なら、リセットする。
  // データを追加する。足りないときは延ばす。
  // 解放するときは、Atomics.subで1減らすだけ。

  constructor(
    share_arrays_memory: SharedArrayBuffer = new SharedArrayBuffer(10 * 1024 * 1024),
  ) {
    this.share_arrays_memory = share_arrays_memory;
    const view = new Int32Array(this.share_arrays_memory);
    Atomics.store(view, 0, 0);
    Atomics.store(view, 1, 0);
    Atomics.store(view, 2, 12);
  }

  static init_self(
    sl: Allocator,
  ): Allocator {
    return new Allocator(sl.share_arrays_memory);
  }

  async async_write(
    data: Uint8Array | Uint32Array,
    memory: SharedArrayBuffer,
    // ptr, len
    // I32Arrayのret_ptrを渡す
    ret_ptr: number,
  ): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const view = new Int32Array(this.share_arrays_memory);
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

      this.write_inner(data, memory, ret_ptr);

      // lockを解放する
      Atomics.store(view, 0, 0);
      Atomics.notify(view, 0, 1);

      break;
    }
  }

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

      // lockを解放する
      Atomics.store(view, 0, 0);
      Atomics.notify(view, 0, 1);

      return ret;
    }
  }

  write_inner(
    data: Uint8Array | Uint32Array,
    memory: SharedArrayBuffer,
    // ptr, len
    ret_ptr: number,
  ): [number, number] {
    // console.log("data", data);

    const view = new Int32Array(this.share_arrays_memory);
    const view8 = new Uint8Array(this.share_arrays_memory);

    // lockを取得した
    // メモリを使っているユーザが増えたことを示す
    const old_num = Atomics.add(view, 1, 1);
    let share_arrays_memory_kept: number;
    if (old_num === 0) {
      // ユーザがいなかったので、リセットする
      // debug.log("reset allocator");
      share_arrays_memory_kept = Atomics.store(view, 2, 12);
    } else {
      share_arrays_memory_kept = Atomics.load(view, 2);
    }
    // console.log("num", Atomics.load(view, 1));

    const memory_len = memory.byteLength;
    const len = data.byteLength;
    const new_memory_len = share_arrays_memory_kept + len;
    if (memory_len < new_memory_len) {
      // メモリを延ばす
      // support from es2024
      // this.share_arrays_memory.grow(new_memory_len);
      throw new Error("size is bigger than memory. \nTODO! fix memory limit. support big size another way.");
    }

    let data8: Uint8Array;
    if (data instanceof Uint8Array) {
      data8 = data;
    } else if (data instanceof Uint32Array) {
      const tmp = new ArrayBuffer(data.byteLength);
      new Uint32Array(tmp).set(data);
      data8 = new Uint8Array(tmp);
    }

    view8.set(new Uint8Array(data8), share_arrays_memory_kept);
    Atomics.store(view, 2, new_memory_len);

    const memory_view = new Int32Array(memory);
    Atomics.store(memory_view, ret_ptr, share_arrays_memory_kept);
    Atomics.store(memory_view, ret_ptr + 1, len);

    // console.log("allocator: allocate", share_arrays_memory_kept, len);

    return [share_arrays_memory_kept, len];
  }

  free(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    pointer: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    len: number
  ) {
    Atomics.sub(new Int32Array(this.share_arrays_memory), 1, 1);

    // console.log("allocator: free", pointer, len);
  }

  get_memory(
    ptr: number,
    len: number,
  ): ArrayBuffer {
    const data = new ArrayBuffer(len);
    const view = new Uint8Array(data);
    view.set(new Uint8Array(this.share_arrays_memory).slice(ptr, ptr + len));
    return data;
  }

  use_defined_memory(
    ptr: number,
    len: number,
    data: ArrayBufferLike,
  ) {
    const memory = new Uint8Array(this.share_arrays_memory);
    memory.set(new Uint8Array(data).slice(0, len), ptr);
  }
}
