import { WorkerBackgroundRef } from "../worker_background/worker_background_ref.ts";
import type { WorkerBackgroundRefObject } from "../worker_background/worker_export.ts";

self.onmessage = async (
  event: MessageEvent<{
    reference: WorkerBackgroundRefObject;
    blocking: boolean;
  }>,
) => {
  const ref = WorkerBackgroundRef.init_self(event.data.reference);
  const wait = Atomics.wait;
  const waitAsync = Atomics.waitAsync;
  Atomics.wait = (view, index, value, timeout) => {
    if (!(view instanceof Int32Array) || typeof value !== "number") {
      throw new Error("expected Int32 runtime wait");
    }
    postMessage({ type: "waiting" });
    return wait(view, index, value, timeout);
  };
  Atomics.waitAsync = (view, index, value, timeout) => {
    if (!(view instanceof Int32Array) || typeof value !== "number") {
      throw new Error("expected Int32 runtime wait");
    }
    postMessage({ type: "waiting" });
    return waitAsync(view, index, value, timeout);
  };
  try {
    const result = event.data.blocking
      ? ref.block_wait_done_or_error()
      : await ref.async_wait_done_or_error();
    postMessage({ type: "result", result });
  } catch (error) {
    postMessage({ type: "error", code: (error as { code?: number }).code });
  }
};
