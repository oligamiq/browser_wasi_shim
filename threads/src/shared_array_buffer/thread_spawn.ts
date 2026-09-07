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

import { WASIProcExit } from "@bjorn3/browser_wasi_shim";
import { WASIFarmAnimal } from "../animals.ts";
import { DestroyerHandle } from "../index.ts";
import type { WASIFarmRefObject } from "../ref.ts";
import type { WorkerBackgroundRefObject } from "./worker_background/index.ts";
import {
  gen_worker_background_worker_url,
  WorkerBackgroundRef,
} from "./worker_background/index.ts";
import { WorkerBackgroundRefObjectConstructor } from "./worker_background/worker_export.ts";
import {
  beginDestroy,
  createDestroyStatus,
  DESTROY_WAKE_EPOCH,
  markDestroyFailed,
  readLifecycle,
  waitForDestroyTerminal,
  WorkerDestroyError,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "./worker_lifecycle.ts";

function coordinatorErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

/**
 * Represents the serialized state of a ThreadSpawner for thread transfer.
 */
type ThreadSpawnerObject = {
  share_memory: {
    [key: string]: WebAssembly.Memory;
  };
  wasi_farm_refs_object: Array<WASIFarmRefObject>;
  worker_url: string;
  worker_background_ref_object: WorkerBackgroundRefObject;
  destroy_status: SharedArrayBuffer;
  animal_id_counter: SharedArrayBuffer;
  // inst_default_buffer_kept: WebAssembly.Memory;
};

/**
 * ThreadSpawner manages the spawning and lifecycle of WebAssembly threads.
 *
 * It coordinates with a background worker to manage thread resources,
 * shared memory, and synchronization primitives.
 */
export class ThreadSpawner {
  private share_memory: {
    [key: string]: WebAssembly.Memory;
  };
  private wasi_farm_refs_object: Array<WASIFarmRefObject>;
  private worker_url: string;
  private worker_background_ref: WorkerBackgroundRef;
  private worker_background_ref_object: WorkerBackgroundRefObject;

  private destroy_status: SharedArrayBuffer;
  private animal_id_counter: SharedArrayBuffer;

  // inst_default_buffer_kept: WebAssembly.Memory;

  // hold the worker to prevent GC.
  private worker_background_worker?: Worker;
  private worker_background_worker_promise: Promise<void> = Promise.resolve();
  private worker_background_ready = false;
  private worker_background_ready_settled = false;
  private worker_background_readiness_error?: WorkerDestroyError;
  private reject_worker_background_worker?: (reason?: unknown) => void;
  private destroy_promise?: Promise<void>;
  private coordinator_failure?: WorkerDestroyError;
  readonly owns_worker_background_worker: boolean;

  // https://github.com/rustwasm/wasm-pack/issues/479

  /**
   * Initializes a new ThreadSpawner.
   *
   * @param worker_url The URL of the worker script.
   * @param wasi_farm_refs_object The serialized state of WASI farm references.
   * @param share_memory The shared WebAssembly memories.
   * @param MIN_STACK The minimum stack size for spawned threads. Defaults to 16MB.
   * @param worker_background_ref_object The serialized state of the background worker reference.
   * @param thread_spawn_wasm The WebAssembly module used for thread spawning.
   * @param worker_background_worker_url Optional custom URL for the background worker.
   * @param destroy_status Shared buffer for tracking destruction status.
   * @param animal_id_counter Shared buffer for generating unique process IDs.
   */
  constructor(
    worker_url: string,
    wasi_farm_refs_object: Array<WASIFarmRefObject>,
    share_memory?: {
      [key: string]: WebAssembly.Memory;
    },
    // 16MB for the time being.
    // https://users.rust-lang.org/t/what-is-the-size-limit-of-threads-stack-in-rust/11867/3
    MIN_STACK = 16777216,
    worker_background_ref_object?: WorkerBackgroundRefObject,
    thread_spawn_wasm?: WebAssembly.Module,
    // inst_default_buffer_kept?: WebAssembly.Memory,
    worker_background_worker_url?: string,
    destroy_status?: SharedArrayBuffer,
    animal_id_counter?: SharedArrayBuffer,
  ) {
    this.owns_worker_background_worker =
      worker_background_ref_object === undefined;
    this.worker_url = worker_url;
    this.wasi_farm_refs_object = wasi_farm_refs_object;

    this.destroy_status =
      worker_background_ref_object?.destroy_status ??
      destroy_status ??
      createDestroyStatus();
    this.animal_id_counter = animal_id_counter ?? new SharedArrayBuffer(4);

    if (share_memory === undefined) {
      const min_initial_size = 1048576 / 65536; // Rust's default stack size is 1MB.
      const initial_size = MIN_STACK / 65536;
      if (initial_size < min_initial_size) {
        throw new Error(
          `The stack size must be at least ${min_initial_size} bytes.`,
        );
      }
      const max_memory = 1073741824 / 65536; // Rust's default maximum memory size is 1GB.

      // WebAssembly.Memory's 1 page is 65536 bytes.
      this.share_memory = {
        memory: new WebAssembly.Memory({
          initial: initial_size,
          maximum: max_memory,
          shared: true,
        }),
      };
    } else {
      this.share_memory = share_memory;
    }

    this.worker_background_ref_object =
      worker_background_ref_object ??
      WorkerBackgroundRefObjectConstructor(this.destroy_status);
    this.worker_background_ref = WorkerBackgroundRef.init_self(
      this.worker_background_ref_object,
    );

    if (this.owns_worker_background_worker) {
      let worker_background_worker_url__: string;
      if (worker_background_worker_url) {
        worker_background_worker_url__ = worker_background_worker_url;
      } else {
        worker_background_worker_url__ = gen_worker_background_worker_url();
      }
      let workerBackgroundUrlRevoked = false;
      const revokeWorkerBackgroundUrl = (): void => {
        if (
          worker_background_worker_url === undefined &&
          !workerBackgroundUrlRevoked
        ) {
          workerBackgroundUrlRevoked = true;
          URL.revokeObjectURL(worker_background_worker_url__);
        }
      };
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      this.worker_background_worker_promise = promise;
      this.reject_worker_background_worker = reject;
      void promise.catch(() => undefined);

      const failCoordinator = (error: unknown): void => {
        revokeWorkerBackgroundUrl();
        const destroyView = new Int32Array(this.destroy_status);
        const lifecycle = readLifecycle(destroyView);
        if (
          lifecycle === WorkerLifecycle.Destroyed ||
          lifecycle === WorkerLifecycle.Failed ||
          this.coordinator_failure !== undefined
        ) {
          return;
        }
        const code = this.worker_background_ready
          ? WorkerDestroyFailureCode.CoordinatorRuntime
          : WorkerDestroyFailureCode.CoordinatorBootstrap;
        const failure = new WorkerDestroyError(code);
        failure.cause = new Error(coordinatorErrorMessage(error));
        this.coordinator_failure = failure;
        const failedCoordinator = this.worker_background_worker;
        if (failedCoordinator !== undefined) {
          this.worker_background_worker = undefined;
          failedCoordinator.onmessage = null;
          failedCoordinator.onerror = null;
          failedCoordinator.onmessageerror = null;
          failedCoordinator.terminate();
        }
        if (!this.worker_background_ready_settled) {
          this.worker_background_ready_settled = true;
          this.worker_background_readiness_error = failure;
          reject(failure);
        }
        beginDestroy(destroyView);
        this.start_destroy_finalization();
        void this.worker_background_ref
          .recover_failed_coordinator_command()
          .catch((commandError) => console.error(commandError))
          .finally(() => {
            markDestroyFailed(destroyView, code);
            this.worker_background_ref.cancel_runtime_completion();
          });
      };

      let coordinator: Worker;
      try {
        coordinator = new Worker(worker_background_worker_url__, {
          type: "module",
        });
        this.worker_background_worker = coordinator;
      } catch (error) {
        failCoordinator(error);
        return;
      }

      coordinator.onmessage = (event) => {
        revokeWorkerBackgroundUrl();
        if (
          readLifecycle(new Int32Array(this.destroy_status)) !==
          WorkerLifecycle.Running
        ) {
          return;
        }
        if (!this.worker_background_ready) {
          if (event.data !== "ready") {
            failCoordinator(new Error("invalid coordinator ready message"));
            return;
          }
          this.worker_background_ready = true;
          this.worker_background_ready_settled = true;
          this.reject_worker_background_worker = undefined;
          resolve();
          return;
        }
        failCoordinator(new Error("unexpected coordinator message"));
      };
      coordinator.onerror = (event) => {
        event.preventDefault();
        failCoordinator(event.error ?? new Error(event.message));
      };
      coordinator.onmessageerror = () => {
        failCoordinator(new Error("coordinator message could not be decoded"));
      };
      try {
        const {
          destroy_status: _destroyStatus,
          worker_background_ref_object: _workerBackgroundRefObject,
          ...coordinatorSpawnerObject
        } = this.get_object();
        coordinator.postMessage({
          override_object: {
            sl_object: coordinatorSpawnerObject,
            thread_spawn_wasm,
          },
          worker_background_ref_object: this.worker_background_ref.get_object(),
        });
      } catch (error) {
        failCoordinator(error);
      }
      void this.observe_destroy()
        .finally(revokeWorkerBackgroundUrl)
        .catch((error) => console.error(error));
    } else {
      this.worker_background_ready = true;
      this.worker_background_ready_settled = true;
    }
  }

  // This cannot blocking.
  wait_worker_background_worker(): Promise<void> {
    return this.worker_background_worker_promise;
  }

  check_worker_background_worker(): void {
    if (this.worker_background_readiness_error !== undefined) {
      throw this.worker_background_readiness_error;
    }
    if (!this.worker_background_ready) {
      throw new Error("worker_background_worker is not ready.");
    }
  }

  /**
   * Spawns a new thread.
   *
   * @param start_arg The argument passed to the thread start function.
   * @param args The command line arguments for the thread.
   * @param env The environment variables for the thread.
   * @param fd_map A mapping of file descriptors for the thread.
   * @returns The ID of the spawned thread.
   */
  thread_spawn(
    start_arg: number,
    args: Array<string>,
    env: Array<string>,
    fd_map: Array<[number, number]>,
  ): number {
    const worker = this.worker_background_ref.new_worker(
      this.worker_url,
      { type: "module" },
      {
        this_is_thread_spawn: true,
        start_arg,
        args,
        env,
        fd_map,
      },
    );

    const thread_id = worker.get_id();

    return thread_id;
  }

  create_destroyer(requesterAnimalId?: number): DestroyerHandle {
    const requester = this.is_managed_worker_context()
      ? requesterAnimalId
      : undefined;
    return new DestroyerHandle(
      this.worker_background_ref,
      this.destroy_status,
      requester,
    );
  }

  is_managed_worker_context(): boolean {
    return !this.owns_worker_background_worker;
  }

  /// This is atomic
  generate_animal_id(): number {
    const buffer = new Int32Array(this.animal_id_counter);
    return Atomics.add(buffer, 0, 1);
  }

  async async_start_on_thread(
    args: Array<string>,
    env: Array<string>,
    fd_map: Array<[number, number]>,
  ): Promise<void> {
    if (!self.Worker.toString().includes("[native code]")) {
      if (self.Worker.toString().includes("function")) {
        console.warn("SubWorker(new Worker on Worker) is polyfilled maybe.");
      } else {
        throw new Error("SubWorker(new Worker on Worker) is not supported.");
      }
    }

    await this.worker_background_ref.async_start_on_thread(
      this.worker_url,
      { type: "module" },
      {
        this_is_thread_spawn: true,
        this_is_start: true,
        args,
        env,
        fd_map,
      },
    );
  }

  block_start_on_thread(
    args: Array<string>,
    env: Array<string>,
    fd_map: Array<[number, number]>,
  ): void {
    if (!self.Worker.toString().includes("[native code]")) {
      if (self.Worker.toString().includes("function")) {
        console.warn("SubWorker(new Worker on Worker) is polyfilled maybe.");
      } else {
        throw new Error("SubWorker(new Worker on Worker) is not supported.");
      }
    }

    this.worker_background_ref.block_start_on_thread(
      this.worker_url,
      { type: "module" },
      {
        this_is_thread_spawn: true,
        this_is_start: true,
        args,
        env,
        fd_map,
      },
    );
  }

  static init_self(sl: ThreadSpawnerObject): ThreadSpawner {
    const thread_spawner = new ThreadSpawner(
      sl.worker_url,
      sl.wasi_farm_refs_object,
      sl.share_memory,
      undefined,
      sl.worker_background_ref_object,
      undefined,
      undefined,
      sl.destroy_status,
      sl.animal_id_counter,
    );
    return thread_spawner;
  }

  static init_self_with_worker_background_ref(
    sl: ThreadSpawnerObject,
    worker_background_ref_object: WorkerBackgroundRefObject,
  ): ThreadSpawner {
    const thread_spawner = new ThreadSpawner(
      sl.worker_url,
      sl.wasi_farm_refs_object,
      sl.share_memory,
      undefined,
      worker_background_ref_object,
      undefined,
      undefined,
      sl.destroy_status,
      sl.animal_id_counter,
    );
    return thread_spawner;
  }

  get_share_memory(): {
    [key: string]: WebAssembly.Memory;
  } {
    return this.share_memory;
  }

  get_object(): ThreadSpawnerObject {
    return {
      share_memory: this.share_memory,
      wasi_farm_refs_object: this.wasi_farm_refs_object,
      worker_url: this.worker_url,
      worker_background_ref_object: this.worker_background_ref_object,
      destroy_status: this.destroy_status,
      animal_id_counter: this.animal_id_counter,
      // inst_default_buffer_kept: this.inst_default_buffer_kept,
    };
  }

  done_notify(code: number): void {
    this.worker_background_ref.done_notify(
      code,
      this.owns_worker_background_worker,
    );
  }

  async async_wait_done_or_error(): Promise<number> {
    if (this.worker_background_worker === undefined) {
      throw new Error("worker_background_worker is undefined.");
    }

    return await this.worker_background_ref.async_wait_done_or_error();
  }

  block_wait_done_or_error(): number {
    if (this.worker_background_worker === undefined) {
      throw new Error("worker_background_worker is undefined.");
    }

    return this.worker_background_ref.block_wait_done_or_error();
  }

  /// Destroys all threads spawned by this Runtime.
  destroy(requesterAnimalId?: number): void {
    if (!this.owns_worker_background_worker) {
      this.create_destroyer(requesterAnimalId).destroy();
      return;
    }

    const destroyView = new Int32Array(this.destroy_status);
    const requester = this.is_managed_worker_context()
      ? requesterAnimalId
      : undefined;
    if (beginDestroy(destroyView, requester)) {
      this.worker_background_ref.notify_destroy();
    }
    if (!this.worker_background_ready_settled) {
      const error = new WorkerDestroyError(WorkerDestroyFailureCode.Protocol);
      this.worker_background_ready_settled = true;
      this.worker_background_readiness_error = error;
      this.reject_worker_background_worker?.(error);
      this.reject_worker_background_worker = undefined;
    }
    this.start_destroy_finalization();
  }

  async_destroy(requesterAnimalId?: number): Promise<void> {
    if (!this.owns_worker_background_worker) {
      return this.create_destroyer(requesterAnimalId).async_destroy();
    }
    this.destroy(requesterAnimalId);
    return this.destroy_promise!;
  }

  private start_destroy_finalization(): Promise<void> {
    this.destroy_promise ??= this.finish_destroy();
    void this.destroy_promise.catch(() => undefined);
    return this.destroy_promise;
  }

  private async observe_destroy(): Promise<void> {
    const view = new Int32Array(this.destroy_status);
    for (;;) {
      const epoch = Atomics.load(view, DESTROY_WAKE_EPOCH);
      if (readLifecycle(view) !== WorkerLifecycle.Running) {
        this.destroy();
        // Bootstrap may still be fetching the generated worker URL.
        await this.start_destroy_finalization().catch(() => undefined);
        return;
      }
      const { value } = Atomics.waitAsync(view, DESTROY_WAKE_EPOCH, epoch);
      if (value instanceof Promise) await value;
    }
  }

  private async finish_destroy(): Promise<void> {
    const coordinator = this.worker_background_worker;
    try {
      await waitForDestroyTerminal(new Int32Array(this.destroy_status));
    } finally {
      if (
        coordinator !== undefined &&
        this.worker_background_worker === coordinator
      ) {
        coordinator.onmessage = null;
        coordinator.onerror = null;
        coordinator.onmessageerror = null;
        coordinator.terminate();
        this.worker_background_worker = undefined;
      }
    }
  }

  kill_animal(id: number) {
    this.worker_background_ref.kill_animal(id);
  }
}

/** send fd_map is not implemented yet.
issue: the fd passed to the child process is different from the parent process.
@param instantiate - WebAssembly.instantiate or custom instantiate function
*/
/**
 * The entry point for thread spawning on a worker.
 *
 * It handles the message from the parent thread and initializes the WASI environment
 * and WebAssembly instance for the new thread.
 *
 * @param msg The message containing thread initialization data.
 * @param instantiate An optional custom WebAssembly instantiation function.
 * @returns A promise that resolves to the created WASIFarmAnimal.
 */
export const thread_spawn_on_worker = async (
  msg: {
    this_is_thread_spawn: boolean;
    worker_id?: number;
    start_arg: number;
    worker_background_ref: WorkerBackgroundRefObject;
    sl_object: ThreadSpawnerObject;
    thread_spawn_wasm: WebAssembly.Module;
    args: Array<string>;
    env: Array<string>;
    fd_map: [number, number][];
    this_is_start?: boolean;
    animal_id: number;
  },
  instantiate: (
    thread_spawn_wasm: WebAssembly.Module,
    imports: {
      env: {
        [key: string]: WebAssembly.Memory;
      };
      wasi: {
        "thread-spawn": (start_arg: number) => number;
      };
      wasi_snapshot_preview1: {
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        [key: string]: (...args: any[]) => unknown;
      };
    },
  ) => Promise<WebAssembly.Instance> = WebAssembly.instantiate.bind(
    WebAssembly,
  ),
  callback: (wasi: WASIFarmAnimal) => void | Promise<void> = () => {},
): Promise<WASIFarmAnimal | undefined> => {
  if (msg.this_is_thread_spawn) {
    const {
      sl_object,
      fd_map,
      worker_background_ref,
      thread_spawn_wasm,
      args,
      env,
    } = msg;

    const override_fd_map: Array<number[]> = new Array(
      sl_object.wasi_farm_refs_object.length,
    );

    // Possibly null (undefined)
    for (const fd_and_wasi_ref_n of fd_map) {
      // biome-ignore lint/suspicious/noDoubleEquals: <explanation>
      if (fd_and_wasi_ref_n == undefined) {
        continue;
      }
      const [fd, wasi_ref_n] = fd_and_wasi_ref_n;
      if (override_fd_map[wasi_ref_n] === undefined) {
        override_fd_map[wasi_ref_n] = [];
      }
      override_fd_map[wasi_ref_n].push(fd);
    }

    const thread_spawner = ThreadSpawner.init_self_with_worker_background_ref(
      sl_object,
      worker_background_ref,
    );

    const { animal_id: animalId } = msg;

    let wasi: WASIFarmAnimal;
    try {
      wasi = new WASIFarmAnimal(
        sl_object.wasi_farm_refs_object,
        args,
        env,
        {
          can_thread_spawn: true,
          thread_spawn_worker_url: sl_object.worker_url,
          hand_override_fd_map: fd_map,
        },
        override_fd_map,
        thread_spawner,
        animalId,
      );
      await callback(wasi);
    } catch (error) {
      post_worker_error(error, animalId, "animal-construction");
      return undefined;
    }

    let inst: WebAssembly.Instance;
    try {
      inst = await instantiate(thread_spawn_wasm, {
        env: {
          ...wasi.get_share_memory(),
        },
        wasi: wasi.wasiThreadImport,
        wasi_snapshot_preview1: wasi.wasiImport,
      });
    } catch (error) {
      post_worker_error(error, animalId, "wasm-instantiation");
      return undefined;
    }

    globalThis.postMessage({
      msg: "ready",
      animal_id: animalId,
    });

    if (msg.this_is_start) {
      try {
        wasi.start_only(
          inst as unknown as {
            exports: {
              memory: WebAssembly.Memory;
              _start: () => unknown;
            };
          },
        );
      } catch (e) {
        check_error(e, "main", animalId);
        return wasi;
      }

      globalThis.postMessage({
        msg: "done",
        animal_id: animalId,
      });

      return wasi;
    }

    const { worker_id: thread_id, start_arg } = msg;

    console.debug(`thread_spawn worker ${thread_id} start`);

    try {
      wasi.wasi_thread_start(
        inst as unknown as {
          exports: {
            memory: WebAssembly.Memory;
            wasi_thread_start: (thread_id: number, start_arg: number) => void;
          };
        },
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        thread_id!,
        start_arg,
      );
    } catch (e) {
      // biome-ignore lint/style/noNonNullAssertion: <explanation>
      check_error(e, thread_id!, animalId);
      return wasi;
    }

    globalThis.postMessage({
      msg: "done",
      animal_id: animalId,
    });

    return wasi;
  }
};

function check_error(
  e: unknown,
  thread_id: number | string,
  animalId: number,
): void {
  if (e instanceof WASIProcExit) {
    globalThis.postMessage({
      msg: "exit",
      animal_id: animalId,
      code: e.code,
    });

    return;
  }

  post_worker_error(e, animalId, undefined, thread_id);
}

function post_worker_error(
  error: unknown,
  animalId: number,
  stage?: "animal-construction" | "wasm-instantiation",
  threadId: number | string = "startup",
): void {
  let cloneableError: unknown = error;

  try {
    structuredClone(error);
  } catch (cloneError) {
    if (
      (
        cloneError as {
          name: string;
        }
      ).name === "DataCloneError"
    ) {
      const replacement = new Error(
        `An error occurred on the thread ${threadId}, but it cannot be cloned.
                Since error propagation does not work properly with this,
                stopping cannot be performed.
                Therefore, I will insert this error instead.
                The error currently confirmed occurs in Firefox,
                after executing with invoke on webworker and reaching an unreachable statement.
                `,
      );
      replacement.name = "EncounteredUncloneableError";
      replacement.stack = (error as Error).stack;
      cloneableError = replacement;
    }
  }

  globalThis.postMessage({
    msg: "error",
    animal_id: animalId,
    error: cloneableError,
    ...(stage === undefined ? {} : { stage }),
  });
}
