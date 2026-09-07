import assert from "node:assert";
import { test } from "node:test";
import { WorkerBackgroundRef } from "./worker_background/worker_background_ref.ts";
import { WorkerBackgroundRefObjectConstructor } from "./worker_background/worker_export.ts";
import {
  beginDestroy,
  createDestroyStatus,
  markDestroyFailed,
  markDestroyed,
  WorkerDestroyFailureCode,
} from "./worker_lifecycle.ts";
import { RuntimeCompletion } from "./worker_request.ts";

for (const blocking of [false, true]) {
  for (const outcome of [
    "failure",
    "destroyed",
    "destroyed-waiting",
    "exit",
  ] as const) {
    test(`${blocking ? "block" : "async"} runtime wait wakes from ${outcome === "failure" || outcome === "destroyed" ? "Completing" : "Waiting"} on ${outcome}`, async () => {
      const reference = WorkerBackgroundRefObjectConstructor(
        createDestroyStatus(),
      );
      const completion = new Int32Array(reference.lock, 12, 3);
      if (outcome === "failure" || outcome === "destroyed")
        Atomics.store(completion, 0, RuntimeCompletion.Completing);
      const worker = new Worker(
        new URL("./test_workers/runtime_wait_worker.ts", import.meta.url).href,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = new Promise<unknown>((resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("runtime wait stayed asleep")),
            500,
          );
          worker.onerror = (event) => reject(new Error(event.message));
          worker.onmessage = (event) => {
            if (event.data.type === "waiting") {
              if (outcome !== "exit") {
                const view = new Int32Array(reference.destroy_status);
                beginDestroy(view);
                if (outcome !== "failure") markDestroyed(view);
                else
                  markDestroyFailed(
                    view,
                    WorkerDestroyFailureCode.CoordinatorRuntime,
                  );
              } else {
                WorkerBackgroundRef.init_self(reference).done_notify(37);
              }
            } else resolve(event.data);
          };
        });
        worker.postMessage({ reference, blocking });
        assert.deepStrictEqual(
          await result,
          outcome !== "exit"
            ? {
                type: "error",
                code:
                  outcome === "failure"
                    ? WorkerDestroyFailureCode.CoordinatorRuntime
                    : WorkerDestroyFailureCode.Protocol,
              }
            : { type: "result", result: 37 },
        );
        assert.strictEqual(
          Atomics.load(completion, 0),
          outcome === "failure" || outcome === "destroyed"
            ? RuntimeCompletion.Completing
            : outcome === "exit"
              ? RuntimeCompletion.Exit
              : RuntimeCompletion.Waiting,
        );
      } finally {
        clearTimeout(timeout);
        worker.terminate();
      }
    });
  }

  test(`${blocking ? "block" : "async"} runtime terminal wins over global failure`, async () => {
    const reference = WorkerBackgroundRefObjectConstructor(
      createDestroyStatus(),
    );
    const ref = WorkerBackgroundRef.init_self(reference);
    ref.done_notify(42);
    const view = new Int32Array(reference.destroy_status);
    beginDestroy(view);
    markDestroyFailed(view, WorkerDestroyFailureCode.CoordinatorRuntime);
    assert.strictEqual(
      blocking
        ? ref.block_wait_done_or_error()
        : await ref.async_wait_done_or_error(),
      42,
    );
  });
}
