import assert from "node:assert";
import { test } from "node:test";
import { ThreadSpawner } from "./thread_spawn.ts";
import { WorkerBackgroundRefObjectConstructor } from "./worker_background/worker_export.ts";
import {
  createDestroyStatus,
  DESTROY_REQUESTER_STATUS,
  markDestroyed,
  readRequesterAnimalId,
  RequesterStatus,
  wakeDestroyWaiters,
} from "./worker_lifecycle.ts";

function createManagedSpawner(): ThreadSpawner {
  return new ThreadSpawner(
    "unused",
    [],
    undefined,
    undefined,
    WorkerBackgroundRefObjectConstructor(createDestroyStatus()),
  );
}

for (const syncFirst of [false, true]) {
  test(`managed spawner ${syncFirst ? "destroy then async_destroy" : "concurrent async_destroy"} schedules one close`, async () => {
    const spawner = createManagedSpawner();
    const view = new Int32Array(spawner.get_object().destroy_status);
    const timeout = globalThis.setTimeout;
    const close = Object.getOwnPropertyDescriptor(globalThis, "close");
    const callbacks: Array<() => void> = [];
    let closes = 0;
    globalThis.setTimeout = ((callback: () => void) => {
      callbacks.push(callback);
      return 0;
    }) as unknown as typeof setTimeout;
    Object.defineProperty(globalThis, "close", {
      configurable: true,
      value: () => {
        closes += 1;
      },
    });
    try {
      if (syncFirst) spawner.destroy(7);
      const first = spawner.async_destroy(7);
      const second = spawner.async_destroy(7);
      const factoryCall = spawner.create_destroyer(7).async_destroy();
      Atomics.store(
        view,
        DESTROY_REQUESTER_STATUS,
        RequesterStatus.RequesterDrained,
      );
      wakeDestroyWaiters(view);
      await Promise.all([first, second, factoryCall]);
      assert.strictEqual(readRequesterAnimalId(view), 7);
      assert.strictEqual(callbacks.length, 1);
      assert.strictEqual(closes, 0);
      assert.strictEqual(
        Atomics.load(view, DESTROY_REQUESTER_STATUS),
        RequesterStatus.RequesterDrained,
      );
      callbacks[0]();
      assert.strictEqual(closes, 1);
      assert.strictEqual(
        Atomics.load(view, DESTROY_REQUESTER_STATUS),
        RequesterStatus.Closing,
      );
      markDestroyed(view);
      await spawner.async_destroy(7);
      assert.strictEqual(callbacks.length, 1);
    } finally {
      globalThis.setTimeout = timeout;
      if (close) Object.defineProperty(globalThis, "close", close);
      else Reflect.deleteProperty(globalThis, "close");
    }
  });
}

test("managed destroyer cache separates requester IDs and spawners", () => {
  const first = createManagedSpawner();
  const second = createManagedSpawner();
  assert.ok(first.create_destroyer(7) === first.create_destroyer(7));
  assert.notStrictEqual(first.create_destroyer(7), first.create_destroyer(8));
  assert.notStrictEqual(first.create_destroyer(7), first.create_destroyer());
  assert.notStrictEqual(first.create_destroyer(7), second.create_destroyer(7));
});

test("owner requester IDs share the unbound cached handle", async () => {
  const owner = new ThreadSpawner("unused", []);
  try {
    await owner.wait_worker_background_worker();
    const handle = owner.create_destroyer(7);
    assert.ok(handle === owner.create_destroyer(8));
    assert.ok(handle === owner.create_destroyer());
    handle.destroy();
    assert.strictEqual(
      readRequesterAnimalId(new Int32Array(owner.get_object().destroy_status)),
      undefined,
    );
    await owner.async_destroy();
  } finally {
    await owner.async_destroy();
  }
});
