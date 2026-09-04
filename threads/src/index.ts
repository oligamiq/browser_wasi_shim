/**
 * browser_wasi_shim/threads
 *
 * This package provides a multi-threaded WASI implementation for browsers,
 * using SharedArrayBuffer and Atomics for high-performance synchronization.
 */
import { WASIFarmAnimal } from "./animals.ts";
import { WASIFarm } from "./farm.ts";
import { WASIFarmRef } from "./ref.ts";
import type { WASIFarmRefObject } from "./ref.ts";
import { DestroyerHandle } from "./destroyer_handle.ts";
export type { DestroyerHandleObject } from "./destroyer_handle.ts";
export {
  BaseCallCapacityError,
  thread_spawn_on_worker,
} from "./shared_array_buffer/index.ts";
export {
  WorkerDestroyError,
  WorkerDestroyFailureCode,
} from "./shared_array_buffer/worker_lifecycle.ts";
export {
  WASIFarm,
  WASIFarmRef,
  type WASIFarmRefObject,
  WASIFarmAnimal,
  DestroyerHandle,
};

// @ts-ignore
import worker_background_worker from "./shared_array_buffer/worker_background/worker_background_worker_minify.js";
export { worker_background_worker };

const worker_background_worker_url: string = new URL(
  "./worker_background_worker.min.js",
  import.meta.url,
).href;
export { worker_background_worker_url };
// @ts-ignore
export { wait_async_polyfill } from "./polyfill.js";
