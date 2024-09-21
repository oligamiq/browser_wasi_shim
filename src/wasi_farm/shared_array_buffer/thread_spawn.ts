//  (export "wasi_thread_start" (func $61879))
//  (func $61879 (param $0 i32) (param $1 i32)
//   (local $2 i32)
//   (local $3 i32)
//   (local $4 i32)
//   (local $5 i32)
//   (local $6 i32)
//   (local $7 i32)
//   (global.set $global$0
//    (i32.load
//     (local.get $1)
//    )
//   )

//  (import "wasi" "thread-spawn" (func $fimport$27 (param i32) (result i32)))

import { WASIFarmAnimal } from "../animals";
import { WASIFarmRefObject } from "../ref";

type ThreadSpawnerObject = {
  thread_id_and_lock: SharedArrayBuffer;
  share_memory: WebAssembly.Memory;
  wasi_farm_refs_object: Array<WASIFarmRefObject>;
  worker_url: string;
};

export class ThreadSpawner {
  private thread_id_and_lock: SharedArrayBuffer;
  private share_memory: WebAssembly.Memory;
  private wasi_farm_refs_object: Array<WASIFarmRefObject>;
  private worker_url: string;

  // https://github.com/rustwasm/wasm-pack/issues/479

  constructor(
    worker_url: string,
    wasi_farm_refs_object: Array<WASIFarmRefObject>,
    thread_id_and_lock?: SharedArrayBuffer,
    share_memory?: WebAssembly.Memory,
    // 16MB for the time being.
    // https://users.rust-lang.org/t/what-is-the-size-limit-of-threads-stack-in-rust/11867/3
    MIN_STACK: number = 16777216,
  ) {
    if (thread_id_and_lock) {
      this.thread_id_and_lock = thread_id_and_lock;
    } else {
      this.thread_id_and_lock = new SharedArrayBuffer(4);
      const thread_id_and_lock_view = new Uint32Array(this.thread_id_and_lock);
      Atomics.store(thread_id_and_lock_view, 0, 1);
    }

    this.worker_url = worker_url;
    this.wasi_farm_refs_object = wasi_farm_refs_object;

    const min_initial_size = 1048576 / 65536; // Rust's default stack size is 1MB.
    const initial_size = MIN_STACK / 65536;
    if (initial_size < min_initial_size) {
      throw new Error(`The stack size must be at least ${min_initial_size} bytes.`);
    }
    const max_memory = 1073741824 / 65536; // Rust's default maximum memory size is 1GB.

    this.share_memory = share_memory ||
    // WebAssembly.Memory's 1 page is 65536 bytes.
      new WebAssembly.Memory({ initial: initial_size, maximum: max_memory, shared: true });
  }

  lock(): void {
    const lock_view = new Int32Array(this.thread_id_and_lock, 4);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const value = Atomics.wait(lock_view, 0, 1);
      if (value === "timed-out") {
        console.error("lock_fd timed-out");
        continue;
      }
      const old = Atomics.compareExchange(lock_view, 0, 0, 1);
      if (old === 0) {
        // console.log("lock_fd success", fd);
        return;
      }
    }
  }

  release(): void {
    const lock_view = new Int32Array(this.thread_id_and_lock, 4);
    const old = Atomics.compareExchange(lock_view, 0, 1, 0);
    if (old !== 1) {
      throw new Error("release_fd failed");
    }
    Atomics.notify(lock_view, 0);
  }

  wait_release(): void {
    const lock_view = new Int32Array(this.thread_id_and_lock, 4);
    const ret = Atomics.wait(lock_view, 0, 0);
    if (ret === "timed-out") {
      throw new Error("wait_release timed-out");
    }
  }

  thread_spawn(
    start_arg: number,
    args: Array<string>,
    env: Array<string>,
    fd_map: Array<[number, number]>,
  ): number {
    this.lock();
    const thread_id_and_lock_view = new Uint32Array(this.thread_id_and_lock);
    const thread_id = Atomics.add(thread_id_and_lock_view, 0, 1);
    const sl_object: ThreadSpawnerObject = {
      thread_id_and_lock: this.thread_id_and_lock,
      share_memory: this.share_memory,
      wasi_farm_refs_object: this.wasi_farm_refs_object,
      worker_url: this.worker_url,
    };
    const worker = new Worker(this.worker_url, { type: "module" });
    worker.postMessage({
      this_is_thread_spawn: true,
      thread_id,
      start_arg,
      sl_object,
      args,
      env,
      fd_map,
    });

    this.wait_release();

    return thread_id;
  }

  static init_self(
    sl: ThreadSpawnerObject,
  ): ThreadSpawner {
    const thread_spawner = new ThreadSpawner(sl.worker_url, sl.wasi_farm_refs_object, sl.thread_id_and_lock, sl.share_memory);
    thread_spawner.wasi_farm_refs_object = sl.wasi_farm_refs_object;
    return thread_spawner;
  }
}

// send fd_map is not implemented yet.
// issue: the fd passed to the child process is different from the parent process.
export const thread_spawn_on_worker = (
  msg: {
    this_is_thread_spawn: boolean;
    thread_id: number;
    start_arg: number;
    sl_object: ThreadSpawnerObject;
    args: Array<string>;
    env: Array<string>;
    fd_map: Array<number []>;
  }
): WASIFarmAnimal => {
  if (msg.this_is_thread_spawn) {
    const sl_object = msg.sl_object;
    const thread_spawner = ThreadSpawner.init_self(msg.sl_object);
    const { thread_id, start_arg, args, env } = msg;

    const override_fd_map: Array<number []> = new Array(sl_object.wasi_farm_refs_object.length);

    for (const [fd, wasi_ref_n] of msg.fd_map) {
      if (override_fd_map[wasi_ref_n] === undefined) {
        override_fd_map[wasi_ref_n] = [];
      }
      override_fd_map[wasi_ref_n].push(fd);
    }

    const wasi_animal = new WASIFarmAnimal(
      sl_object.wasi_farm_refs_object,
      args,
      env,
      {
        can_thread_spawn: true,
        thread_spawn_worker_url: sl_object.worker_url,
      },
      override_fd_map,
      thread_spawner,
    );

    (wasi_animal.inst.exports as unknown as { wasi_thread_start: (thread_id_and_lock: number, start_arg: number) => void }).wasi_thread_start(thread_id, start_arg);

    thread_spawner.release();

    return wasi_animal;
  }
}