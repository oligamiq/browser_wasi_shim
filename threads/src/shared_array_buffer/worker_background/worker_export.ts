import type { AllocatorUseArrayBufferObject } from "../allocator.js";

/**
 * Represents the serialized state of a WorkerBackgroundRef for thread transfer.
 */
export type WorkerBackgroundRefObject = {
  allocator: AllocatorUseArrayBufferObject;
  lock: SharedArrayBuffer;
  signature_input: SharedArrayBuffer;
};

/**
 * Constructs a new default WorkerBackgroundRefObject.
 *
 * @returns A WorkerBackgroundRefObject with initialized SharedArrayBuffers.
 */
export const WorkerBackgroundRefObjectConstructor =
  (): WorkerBackgroundRefObject => {
    return {
      allocator: {
        share_arrays_memory: new SharedArrayBuffer(10 * 1024),
      },
      lock: new SharedArrayBuffer(24),
      signature_input: new SharedArrayBuffer(24),
    };
  };

export type WorkerOptions = {
  type: "module" | "";
};
