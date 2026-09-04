import assert from "node:assert";
import { describe, test } from "node:test";
import { DestroyerHandle } from "./destroyer_handle.ts";
import type { WorkerBackgroundRef } from "./shared_array_buffer/worker_background/index.ts";
import {
  createDestroyStatus,
  markDestroyed,
  markDestroyFailed,
  readLifecycle,
  WorkerDestroyError,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "./shared_array_buffer/worker_lifecycle.ts";

const unusedSender = {
  notify_destroy: () => undefined,
} as unknown as WorkerBackgroundRef;

describe("DestroyerHandle", () => {
  test("remains usable after a task delay", async () => {
    const status = createDestroyStatus();
    const handle = new DestroyerHandle(unusedSender, status);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    handle.destroy();

    assert.strictEqual(
      readLifecycle(new Int32Array(status)),
      WorkerLifecycle.Destroying,
    );
  });

  test("repeated destroy is idempotent", () => {
    const status = createDestroyStatus();
    const handle = new DestroyerHandle(unusedSender, status);

    handle.destroy();
    handle.destroy();

    assert.strictEqual(
      readLifecycle(new Int32Array(status)),
      WorkerLifecycle.Destroying,
    );
  });

  test("async_destroy waits for successful terminal state", async () => {
    const status = createDestroyStatus();
    const view = new Int32Array(status);
    const handle = new DestroyerHandle(unusedSender, status);
    const completion = handle.async_destroy();
    markDestroyed(view);

    assert.strictEqual(await completion, undefined);
  });

  test("async_destroy reports a stable failure category", async () => {
    const status = createDestroyStatus();
    const view = new Int32Array(status);
    const handle = new DestroyerHandle(unusedSender, status);
    const completion = handle.async_destroy();
    markDestroyFailed(view, WorkerDestroyFailureCode.CoordinatorRuntime);

    await assert.rejects(completion, WorkerDestroyError);
  });

  test("repeated and losing handles notify the coordinator once", () => {
    const status = createDestroyStatus();
    let notificationCount = 0;
    const sender = {
      notify_destroy: () => {
        notificationCount += 1;
      },
    } as unknown as WorkerBackgroundRef;
    const winner = new DestroyerHandle(sender, status);
    const loser = new DestroyerHandle(sender, status);

    winner.destroy();
    winner.destroy();
    loser.destroy();

    assert.strictEqual(notificationCount, 1);
  });
});
