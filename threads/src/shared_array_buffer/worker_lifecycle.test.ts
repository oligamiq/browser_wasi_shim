import assert from "node:assert";
import { describe, test } from "node:test";
import {
  beginDestroy,
  createDestroyStatus,
  DESTROY_REQUESTER_STATUS,
  markDestroyed,
  markDestroyFailed,
  markRequesterClosing,
  readLifecycle,
  readRequesterAnimalId,
  RequesterStatus,
  wakeDestroyWaiters,
  waitForDestroyTerminal,
  waitForRequesterDrained,
  WorkerDestroyError,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "./worker_lifecycle.ts";

describe("worker destroy control", () => {
  test("publishes lifecycle and managed requester in one election", () => {
    const status = createDestroyStatus();
    const view = new Int32Array(status);

    assert.strictEqual(beginDestroy(view, 41), true);
    assert.strictEqual(readLifecycle(view), WorkerLifecycle.Destroying);
    assert.strictEqual(readRequesterAnimalId(view), 41);
  });

  test("allows only one destroy winner", () => {
    const view = new Int32Array(createDestroyStatus());

    assert.strictEqual(beginDestroy(view, 7), true);
    assert.strictEqual(beginDestroy(view, 8), false);
    assert.strictEqual(readRequesterAnimalId(view), 7);
  });

  test("uses an unbound requester code for controller destroy", () => {
    const view = new Int32Array(createDestroyStatus());

    assert.strictEqual(beginDestroy(view), true);
    assert.strictEqual(readRequesterAnimalId(view), undefined);
  });

  test("rejects an animal id that cannot fit in CONTROL", () => {
    const view = new Int32Array(createDestroyStatus());

    assert.throws(() => beginDestroy(view, 2 ** 30 - 1), RangeError);
  });

  test("settles all terminal waiters", async () => {
    const view = new Int32Array(createDestroyStatus());
    beginDestroy(view);
    const first = waitForDestroyTerminal(view);
    const second = waitForDestroyTerminal(view);
    markDestroyed(view);
    assert.strictEqual(await first, undefined);
    assert.strictEqual(await second, undefined);
  });

  test("reports a stable terminal failure", async () => {
    const view = new Int32Array(createDestroyStatus());
    beginDestroy(view);
    const completion = waitForDestroyTerminal(view);
    markDestroyFailed(view, WorkerDestroyFailureCode.CoordinatorRuntime);
    await assert.rejects(completion, WorkerDestroyError);
  });

  test("coordinates requester drained and closing states", async () => {
    const view = new Int32Array(createDestroyStatus());
    beginDestroy(view, 4);
    const drained = waitForRequesterDrained(view);
    Atomics.store(
      view,
      DESTROY_REQUESTER_STATUS,
      RequesterStatus.RequesterDrained,
    );
    wakeDestroyWaiters(view);
    await drained;
    markRequesterClosing(view);
    assert.strictEqual(
      Atomics.load(view, DESTROY_REQUESTER_STATUS),
      RequesterStatus.Closing,
    );
  });

  test("Running->Failed throws Protocol and leaves failure code None", () => {
    const view = new Int32Array(createDestroyStatus());
    assert.strictEqual(readLifecycle(view), WorkerLifecycle.Running);

    assert.throws(
      () => markDestroyFailed(view, WorkerDestroyFailureCode.WorkerBootstrap),
      (error: unknown) => {
        assert.ok(error instanceof WorkerDestroyError);
        assert.strictEqual(error.code, WorkerDestroyFailureCode.Protocol);
        return true;
      },
    );

    assert.strictEqual(readLifecycle(view), WorkerLifecycle.Running);
    assert.strictEqual(
      Atomics.load(view, 2 /* DESTROY_FAILURE_CODE */),
      WorkerDestroyFailureCode.None,
    );
  });

  test("opposite terminal transition after a winner is non-throwing and leaves winner unchanged", () => {
    const view1 = new Int32Array(createDestroyStatus());
    beginDestroy(view1);
    markDestroyed(view1);
    assert.strictEqual(readLifecycle(view1), WorkerLifecycle.Destroyed);
    markDestroyFailed(view1, WorkerDestroyFailureCode.WorkerBootstrap);
    assert.strictEqual(readLifecycle(view1), WorkerLifecycle.Destroyed);

    const view2 = new Int32Array(createDestroyStatus());
    beginDestroy(view2);
    markDestroyFailed(view2, WorkerDestroyFailureCode.CoordinatorRuntime);
    assert.strictEqual(readLifecycle(view2), WorkerLifecycle.Failed);
    assert.strictEqual(
      Atomics.load(view2, 2 /* DESTROY_FAILURE_CODE */),
      WorkerDestroyFailureCode.CoordinatorRuntime,
    );
    markDestroyed(view2);
    assert.strictEqual(readLifecycle(view2), WorkerLifecycle.Failed);
    assert.strictEqual(
      Atomics.load(view2, 2 /* DESTROY_FAILURE_CODE */),
      WorkerDestroyFailureCode.CoordinatorRuntime,
    );
  });
});
