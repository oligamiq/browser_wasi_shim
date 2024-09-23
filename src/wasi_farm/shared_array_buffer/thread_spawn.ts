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

import { WASIFarmAnimal } from "../animals.js";
import { WASIFarmRefObject } from "../ref.js";
import { WorkerBackgroundRefObject } from "./worker_background/worker.js";
import { WorkerBackgroundRef } from "./worker_background/worker_background_ref.js";
import { url as worker_background_worker_url } from "./worker_background/worker_blob.js";

type ThreadSpawnerObject = {
  share_memory: WebAssembly.Memory;
  wasi_farm_refs_object: Array<WASIFarmRefObject>;
  worker_url: string;
  worker_background_ref_object: WorkerBackgroundRefObject;
};

export class ThreadSpawner {
  private share_memory: WebAssembly.Memory;
  private wasi_farm_refs_object: Array<WASIFarmRefObject>;
  private worker_url: string;
  private worker_background_ref: WorkerBackgroundRef;
  private worker_background_ref_object: WorkerBackgroundRefObject;

  // hold the worker to prevent GC.
  private worker_background_worker?: Worker;
  private worker_background_worker_promise?: Promise<void>;

  // https://github.com/rustwasm/wasm-pack/issues/479

  constructor(
    worker_url: string,
    wasi_farm_refs_object: Array<WASIFarmRefObject>,
    share_memory?: WebAssembly.Memory,
    // 16MB for the time being.
    // https://users.rust-lang.org/t/what-is-the-size-limit-of-threads-stack-in-rust/11867/3
    MIN_STACK: number = 16777216,
    worker_background_ref_object?: WorkerBackgroundRefObject,
    thread_spawn_wasm?: WebAssembly.Module,
  ) {
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

    if (worker_background_ref_object === undefined) {
      const worker_background_worker_url__ = worker_background_worker_url();
      this.worker_background_worker = new Worker(worker_background_worker_url__, { type: "module" });
      URL.revokeObjectURL(worker_background_worker_url__);
      const { promise, resolve } = Promise.withResolvers<void>();
      this.worker_background_worker_promise = promise;
      this.worker_background_worker.onmessage = (e) => {
        this.worker_background_ref_object = e.data;
        this.worker_background_ref = WorkerBackgroundRef.init_self(this.worker_background_ref_object);
        resolve();
      }
      this.worker_background_worker.postMessage({ override_object: {
        sl_object: this.get_object(),
        thread_spawn_wasm,
      } });
    } else {
      this.worker_background_ref_object = worker_background_ref_object;
      this.worker_background_ref = WorkerBackgroundRef.init_self(this.worker_background_ref_object);
    }
  }

  wait_worker_background_worker(): Promise<void> {
    if (this.worker_background_worker_promise) {
      return this.worker_background_worker_promise;
    } else {
      return Promise.resolve();
    }
  }

  thread_spawn(
    start_arg: number,
    args: Array<string>,
    env: Array<string>,
    fd_map: Array<[number, number]>,
  ): number {
    if (!(self.Worker.toString().includes("[native code]"))) {
      if (self.Worker.toString().includes("function")) {
        console.warn("SubWorker(new Worker on Worker) is polyfilled maybe.");
      } else {
        throw new Error("SubWorker(new Worker on Worker) is not supported.");
      }
    }

    const worker = this.worker_background_ref.new_worker(
      this.worker_url,
      { type: "module" },
      {
      this_is_thread_spawn: true,
      start_arg,
      args,
      env,
      fd_map,
    });

    const thread_id = worker.get_id();

    return thread_id;
  }

  static init_self(
    sl: ThreadSpawnerObject,
  ): ThreadSpawner {
    const thread_spawner = new ThreadSpawner(sl.worker_url, sl.wasi_farm_refs_object, sl.share_memory, undefined, sl.worker_background_ref_object);
    return thread_spawner;
  }

  static init_self_with_worker_background_ref(
    sl: ThreadSpawnerObject,
    worker_background_ref_object: WorkerBackgroundRefObject,
  ): ThreadSpawner {
    const thread_spawner = new ThreadSpawner(sl.worker_url, sl.wasi_farm_refs_object, sl.share_memory, undefined, worker_background_ref_object);
    return thread_spawner;
  }

  get_share_memory(): WebAssembly.Memory {
    return this.share_memory;
  }

  get_object(): ThreadSpawnerObject {
    return {
      share_memory: this.share_memory,
      wasi_farm_refs_object: this.wasi_farm_refs_object,
      worker_url: this.worker_url,
      worker_background_ref_object: this.worker_background_ref_object,
    };
  }
}

// send fd_map is not implemented yet.
// issue: the fd passed to the child process is different from the parent process.
export const thread_spawn_on_worker = async (
  msg: {
    this_is_thread_spawn: boolean;
    worker_id: number;
    start_arg: number;
    worker_background_ref: WorkerBackgroundRefObject;
    sl_object: ThreadSpawnerObject;
    thread_spawn_wasm: WebAssembly.Module;
    args: Array<string>;
    env: Array<string>;
    fd_map: Array<number []>;
  }
): Promise<WASIFarmAnimal> => {
  if (msg.this_is_thread_spawn) {

    const { worker_id: thread_id, start_arg, args, env, sl_object, thread_spawn_wasm } = msg;

    console.log(`thread_spawn worker ${thread_id} start`);

    const thread_spawner = ThreadSpawner.init_self_with_worker_background_ref(sl_object, msg.worker_background_ref);

    const override_fd_map: Array<number []> = new Array(sl_object.wasi_farm_refs_object.length);

    for (const [fd, wasi_ref_n] of msg.fd_map) {
      if (override_fd_map[wasi_ref_n] === undefined) {
        override_fd_map[wasi_ref_n] = [];
      }
      override_fd_map[wasi_ref_n].push(fd);
    }

    const wasi = new WASIFarmAnimal(
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

    const inst = await WebAssembly.instantiate(thread_spawn_wasm, {
      "env": {
        memory: wasi.get_share_memory(),
      },
      "wasi": wasi.wasiThreadImport,
      "wasi_snapshot_preview1": wasi.wasiImport,
    });

    globalThis.postMessage({
      msg: "ready"
    });

    wasi.wasi_thread_start(inst as {
      exports: {
        memory: WebAssembly.Memory;
        wasi_thread_start: (thread_id: number, start_arg: number) => void;
      };
    }, thread_id, start_arg);

    globalThis.postMessage({
      msg: "done"
    });

    return wasi;
  }
}
