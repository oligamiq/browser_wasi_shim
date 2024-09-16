export type ToRefSenderUseArrayBufferObject = {
  data_size: number;
  share_arrays_memory?: SharedArrayBuffer;
}

export abstract class ToRefSenderUseArrayBuffer {
  // 構造としては、allocatorに近いが、仕組みが違う

  // fd管理の例
  // これに対応しないといけない
  // 1. path_openの開始
  // 2. fd_closeによりなくなる
  // 2.1 ToRefSenderで送られる
  // 3. path_openによって再度割り当てられる
  // < ToRefSenderでクローズ
  // 3.1 開いた人が使えるようになる
  // < ToRefSenderでクローズ こちらだけではバグる
  // farmの構造的に起きないはず

  // 結局、この関数から受け取るときは、各関数の最初の呼び出し時に行えばいいはず

  // 最初の4byteはロック用の値: i32
  // 次の4byteは現在のデータの数: m: i32
  // 次の4byteはshare_arrays_memoryの使っている場所の長さ: n: i32
  // データのヘッダ
  // 4byte: 残りの対象の数
  // 4byte: 対象の数 (n)
  // n*4 byte: 対象の割り当て数値
  // データ
  // data_size byte: データ
  private share_arrays_memory: SharedArrayBuffer;

  private data_size: number;

  constructor(
    // data is Uint32Array
    // and data_size is data.length
    data_size: number,
    max_share_arrays_memory: number = 100 * 1024,
    share_arrays_memory?: SharedArrayBuffer,
  ) {
    this.data_size = data_size;
    if (share_arrays_memory) {
      this.share_arrays_memory = share_arrays_memory;
    } else {
      this.share_arrays_memory = new SharedArrayBuffer(max_share_arrays_memory);
    }
    const view = new Int32Array(this.share_arrays_memory);
    Atomics.store(view, 0, 0);
    Atomics.store(view, 1, 0);
    Atomics.store(view, 2, 12);
  }

  protected static init_self_inner(
    sl: ToRefSenderUseArrayBufferObject,
  ): {
    data_size: number,
    max_share_arrays_memory: number,
    share_arrays_memory: SharedArrayBuffer,
  } {
    return {
      data_size: sl.data_size,
      max_share_arrays_memory: sl.share_arrays_memory.byteLength,
      share_arrays_memory: sl.share_arrays_memory,
    };
  }

  private async async_lock(): Promise<void> {
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
      break;
    }
  }

  private block_lock(): void {
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
      break;
    }
  }

  private release_lock(): void {
    const view = new Int32Array(this.share_arrays_memory);
    Atomics.store(view, 0, 0);
    Atomics.notify(view, 0, 1);
  }

  protected async async_send(
    targets: Array<number>,
    data: Uint32Array,
  ): Promise<void> {
    await this.async_lock();

    const view = new Int32Array(this.share_arrays_memory);
    const used_len = Atomics.load(view, 2);
    const data_len = data.byteLength;
    if (data_len !== this.data_size) {
      throw new Error("invalid data size: " + data_len + " !== " + this.data_size);
    }
    const new_used_len = used_len + data_len + 8 + targets.length * 4;
    if (new_used_len > this.share_arrays_memory.byteLength) {
      throw new Error("over memory");
    }

    Atomics.store(view, 2, new_used_len);

    const header = new Int32Array(this.share_arrays_memory, used_len);
    header[0] = targets.length;
    header[1] = targets.length;
    header.set(targets, 2);

    const data_view = new Uint32Array(this.share_arrays_memory, used_len + 8 + targets.length * 4);
    data_view.set(data);

    // console.log("async_send send", targets, data);

    Atomics.add(view, 1, 1);

    this.release_lock();
  }

  protected get_data(
    id: number,
  ): Array<Uint32Array> | undefined {
    const view = new Int32Array(this.share_arrays_memory);
    const data_num_tmp = Atomics.load(view, 1);
    if (data_num_tmp === 0) {
      return undefined;
    }

    this.block_lock();

    const data_num = Atomics.load(view, 1);

    const return_data: Array<Uint32Array> = [];

    let offset = 12;
    // console.log("data_num", data_num);
    for (let i = 0; i < data_num; i++) {
      // console.log("this.share_arrays_memory", this.share_arrays_memory);
      const header = new Int32Array(this.share_arrays_memory, offset);
      const target_num = header[1];
      const targets = new Int32Array(this.share_arrays_memory, offset + 8, target_num);
      const data_len = this.data_size;
      if (targets.includes(id)) {
        const data = new Uint32Array(this.share_arrays_memory, offset + 8 + target_num * 4, data_len / 4);

        // なぜかわからないが、上では正常に動作せず、以下のようにすると動作する
        // return_data.push(new Uint32Array(data));
        return_data.push(new Uint32Array([...data]));

        const target_index = targets.indexOf(id);
        Atomics.store(targets, target_index, -1);
        const old_left_targets_num = Atomics.sub(header, 0, 1);
        if (old_left_targets_num === 1) {
          // rm data
          Atomics.sub(view, 1, 1);
          const used_len = Atomics.load(view, 2);
          const new_used_len = used_len - data_len - 8 - target_num * 4;
          Atomics.store(view, 2, new_used_len);
          const next_data_offset = offset + data_len + 8 + target_num * 4;
          const next_tail = new Int32Array(this.share_arrays_memory, next_data_offset);
          const now_tail = new Int32Array(this.share_arrays_memory, offset);
          now_tail.set(next_tail);
          // console.log("new_used_len", new_used_len);
        } else {
          offset += data_len + 8 + target_num * 4;
        }
      } else {
        offset += data_len + 8 + target_num * 4;
      }
      // console.log("offset", offset);
    }

    if (offset !== Atomics.load(view, 2)) {
      throw new Error("invalid offset: " + offset + " !== " + Atomics.load(view, 2));
    }

    this.release_lock();

    // console.log("get_data get: return_data", return_data);

    return return_data;
  }
}
