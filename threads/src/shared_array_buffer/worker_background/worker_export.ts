import type { AllocatorUseArrayBufferObject } from "../allocator.js";

/**
 * Represents the serialized state of a WorkerBackgroundRef for thread transfer.
 */
export type WorkerBackgroundRefObject = {
  allocator: AllocatorUseArrayBufferObject;
  lock: SharedArrayBuffer;
  signature_input: SharedArrayBuffer;
  destroy_status: SharedArrayBuffer;
};

export const SIGNATURE_REQUEST_STATUS_PTR = 6;
export const SIGNATURE_REQUEST_STATUS_LEN = 7;
export const WORKER_BACKGROUND_LOCK_BYTES = 28;
export const WORKER_COMMAND_MUTEX = 0;
export const WORKER_COMMAND_PHASE = 1;
export const WORKER_COMMAND_ACK = 2;
export const WORKER_COMMAND_ACTIVITY_EPOCH = 6;
export const WORKER_RUNTIME_COMPLETION_OFFSET_BYTES = 12;
export const WORKER_RUNTIME_COMPLETION_WORDS = 3;

export enum WorkerCommandState {
  Published = 0,
  Idle = 1,
  Preparing = 2,
  Claimed = 3,
}

export function wakeWorkerCommandActivity(view: Int32Array): void {
  Atomics.add(view, WORKER_COMMAND_ACTIVITY_EPOCH, 1);
  Atomics.notify(view, WORKER_COMMAND_ACTIVITY_EPOCH);
}

/**
 * Constructs a new default WorkerBackgroundRefObject.
 *
 * @returns A WorkerBackgroundRefObject with initialized SharedArrayBuffers.
 */
export const WorkerBackgroundRefObjectConstructor = (
  destroyStatus: SharedArrayBuffer,
): WorkerBackgroundRefObject => {
  const lock = new SharedArrayBuffer(WORKER_BACKGROUND_LOCK_BYTES);
  const lockView = new Int32Array(lock);
  Atomics.store(lockView, WORKER_COMMAND_PHASE, WorkerCommandState.Idle);
  wakeWorkerCommandActivity(lockView);
  return {
    allocator: {
      share_arrays_memory: new SharedArrayBuffer(10 * 1024),
    },
    lock,
    signature_input: new SharedArrayBuffer(32),
    destroy_status: destroyStatus,
  };
};

export type WorkerOptions = {
  type: "module" | "";
};
