import { describe, expect, test } from "bun:test";
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

    expect(beginDestroy(view, 41)).toBe(true);
    expect(readLifecycle(view)).toBe(WorkerLifecycle.Destroying);
    expect(readRequesterAnimalId(view)).toBe(41);
  });

  test("allows only one destroy winner", () => {
    const view = new Int32Array(createDestroyStatus());

    expect(beginDestroy(view, 7)).toBe(true);
    expect(beginDestroy(view, 8)).toBe(false);
    expect(readRequesterAnimalId(view)).toBe(7);
  });

  test("uses an unbound requester code for controller destroy", () => {
    const view = new Int32Array(createDestroyStatus());

    expect(beginDestroy(view)).toBe(true);
    expect(readRequesterAnimalId(view)).toBeUndefined();
  });

  test("rejects an animal id that cannot fit in CONTROL", () => {
    const view = new Int32Array(createDestroyStatus());

    expect(() => beginDestroy(view, 2 ** 30 - 1)).toThrow(RangeError);
  });

  test("settles all terminal waiters", async () => {
    const view = new Int32Array(createDestroyStatus());
    beginDestroy(view);
    const first = waitForDestroyTerminal(view);
    const second = waitForDestroyTerminal(view);
    markDestroyed(view);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  test("reports a stable terminal failure", async () => {
    const view = new Int32Array(createDestroyStatus());
    beginDestroy(view);
    const completion = waitForDestroyTerminal(view);
    markDestroyFailed(view, WorkerDestroyFailureCode.CoordinatorRuntime);
    await expect(completion).rejects.toBeInstanceOf(WorkerDestroyError);
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
    expect(Atomics.load(view, DESTROY_REQUESTER_STATUS)).toBe(
      RequesterStatus.Closing,
    );
  });
});
