import {
  BaseCallAllocatorUseArrayBuffer,
  type BaseCallAllocatorUseArrayBufferObject,
} from "../base_call_allocator.ts";

self.onmessage = (
  event: MessageEvent<BaseCallAllocatorUseArrayBufferObject>,
) => {
  const allocator = BaseCallAllocatorUseArrayBuffer.init_self(event.data);
  postMessage({ type: "attempting" });
  try {
    const allocation = allocator.block_write(new Uint8Array([1]));
    allocator.free(...allocation);
    postMessage({ type: "done" });
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    postMessage({
      type: "error",
      error: {
        name: normalized.name,
        message: normalized.message,
        stack: normalized.stack,
      },
    });
  }
};

export {};
