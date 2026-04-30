import type { AllocatorUseArrayBufferObject } from "../allocator.js";

export type WorkerBackgroundRefObject = {
  allocator: AllocatorUseArrayBufferObject;
  lock: SharedArrayBuffer;
  signature_input: SharedArrayBuffer;
  destroy_status?: SharedArrayBuffer;
};

export const WorkerBackgroundRefObjectConstructor =
  (): WorkerBackgroundRefObject => {
    return {
      allocator: {
        share_arrays_memory: new SharedArrayBuffer(10 * 1024),
      },
      lock: new SharedArrayBuffer(24),
      signature_input: new SharedArrayBuffer(24),
      destroy_status: new SharedArrayBuffer(4),
    };
  };

export type WorkerOptions = {
  type: "module" | "";
};
