/**
 * browser_wasi_shim/threads
 *
 * This package provides a multi-threaded WASI implementation for browsers,
 * using SharedArrayBuffer and Atomics for high-performance synchronization.
 */
import { WASIFarmAnimal } from "./animals.ts";
import { WASIFarm } from "./farm.ts";
import { WASIFarmRef } from "./ref.ts";
import { DestroyerHandle } from "./destroyer_handle.ts";
export { thread_spawn_on_worker } from "./shared_array_buffer/index.ts";
export { WASIFarm, WASIFarmRef, WASIFarmAnimal, DestroyerHandle };
const worker_background_worker_url: string =
  "./dist/worker_background_worker.min.ts";
export { worker_background_worker_url };
// @ts-ignore
export { wait_async_polyfill } from "./polyfill.js";
