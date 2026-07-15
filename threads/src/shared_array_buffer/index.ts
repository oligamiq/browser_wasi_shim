/**
 * shared_array_buffer
 *
 * This module provides SharedArrayBuffer-based implementations of the WASI farm
 * components, enabling efficient cross-thread communication using atomics.
 */
import { WASIFarmParkUseArrayBuffer } from "./park.ts";
import {
  BaseCallAllocatorUseArrayBuffer,
  type BaseCallAllocatorUseArrayBufferObject,
} from "./base_call_allocator.ts";
import {
  BaseCallCapacityError,
  type BaseCallHandler,
  BaseCallOpcode,
  BaseCallParkUseArrayBuffer,
  BaseCallRefUseArrayBuffer,
  BaseCallTerminalError,
  type BaseCallTransportObject,
} from "./base_call.ts";
import { WASIFarmRefUseArrayBuffer } from "./ref.ts";
import type { WASIFarmRefUseArrayBufferObject } from "./ref.ts";
import { ThreadSpawner } from "./thread_spawn.ts";
import { thread_spawn_on_worker } from "./thread_spawn.ts";

export {
  BaseCallAllocatorUseArrayBuffer,
  type BaseCallAllocatorUseArrayBufferObject,
  BaseCallCapacityError,
  type BaseCallHandler,
  BaseCallOpcode,
  BaseCallParkUseArrayBuffer,
  BaseCallRefUseArrayBuffer,
  BaseCallTerminalError,
  type BaseCallTransportObject,
  WASIFarmRefUseArrayBuffer,
  type WASIFarmRefUseArrayBufferObject,
  WASIFarmParkUseArrayBuffer,
  ThreadSpawner,
  thread_spawn_on_worker,
};
