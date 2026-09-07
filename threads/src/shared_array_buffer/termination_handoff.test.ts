import assert from "node:assert";
import { test } from "node:test";
import { AllocatorUseArrayBuffer } from "./allocator.ts";
import { ThreadSpawner } from "./thread_spawn.ts";
import { WorkerBackgroundRef } from "./worker_background/worker_background_ref.ts";
import { WorkerBackgroundRefObjectConstructor } from "./worker_background/worker_export.ts";
import {
  beginDestroy,
  createDestroyStatus,
  waitForDestroyTerminal,
  markRequesterClosing,
  readLifecycle,
  WorkerLifecycle,
} from "./worker_lifecycle.ts";
import { RuntimeCompletion } from "./worker_request.ts";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("handoff safety timeout")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function signal(view: Int32Array, index: number): Promise<void> {
  await bounded(
    (async () => {
      while (Atomics.load(view, index) === 0)
        await Atomics.waitAsync(view, index, 0).value;
    })(),
  );
}

async function harness(failAllocation = false) {
  const reference = WorkerBackgroundRefObjectConstructor(createDestroyStatus());
  const control = new SharedArrayBuffer(128);
  const signals = new Int32Array(control);
  const coordinator = new Worker(
    new URL("./test_workers/handoff_coordinator.ts", import.meta.url).href,
  );
  const message = () =>
    bounded(
      new Promise<void>((resolve, reject) => {
        coordinator.onmessage = () => resolve();
        coordinator.onerror = (event) => reject(new Error(event.message));
      }),
    );
  const ready = message();
  coordinator.postMessage({ reference, control, failAllocation });
  await ready;
  const ref = WorkerBackgroundRef.init_self(reference);
  return {
    reference,
    signals,
    ref,
    coordinator,
    spawn: (mode: string) =>
      ref.new_worker(
        new URL("./test_workers/handoff_animal.ts", import.meta.url).href,
        { type: "module" },
        { mode },
      ),
    probe: async (kill?: number) => {
      const response = message();
      coordinator.postMessage({ kill });
      await response;
    },
    cleanup: async () => {
      Atomics.store(signals, 2, 1);
      Atomics.notify(signals, 2);
      Atomics.store(signals, 3, 1);
      Atomics.notify(signals, 3);
      beginDestroy(new Int32Array(reference.destroy_status));
      ref.notify_destroy();
      try {
        await bounded(
          waitForDestroyTerminal(new Int32Array(reference.destroy_status)),
        );
      } finally {
        coordinator.terminate();
      }
    },
  };
}

for (const mode of ["preparing", "allocating"]) {
  test(`handoff: ordinary error allocation failure cannot kill a ${mode} caller`, async () => {
    const h = await harness(true);
    try {
      h.spawn("error");
      h.spawn(mode);
      await signal(h.signals, 1);
      Atomics.store(h.signals, 3, 1);
      Atomics.notify(h.signals, 3);
      await signal(h.signals, 15);
      assert.strictEqual(
        new Int32Array(h.reference.lock)[0],
        3,
        "termination reserved the live caller's gate",
      );
      assert.strictEqual(
        Atomics.load(h.signals, 21),
        0,
        "caller must stay alive through preparation",
      );
      Atomics.store(h.signals, 2, 1);
      Atomics.notify(h.signals, 2);
      await assert.rejects(
        bounded(
          waitForDestroyTerminal(new Int32Array(h.reference.destroy_status)),
        ),
      );
      assert.strictEqual(new Int32Array(h.reference.lock)[0], 0);
      assert.strictEqual(
        Atomics.load(h.signals, 21),
        5,
        "termination owns Coordinator gate",
      );
    } finally {
      await h.cleanup().catch(() => undefined);
    }
  });
}

test("handoff: actual selfkill ACK precedes caller release and sibling remains usable", async () => {
  const h = await harness();
  try {
    h.spawn("sibling");
    h.spawn("selfkill");
    await Promise.race([signal(h.signals, 1), signal(h.signals, 21)]);
    assert.strictEqual(
      Atomics.load(h.signals, 21),
      0,
      "selfkill must ACK before retirement",
    );
    await signal(h.signals, 1);
    await h.probe();
    assert.strictEqual(Atomics.load(h.signals, 21), 0);
    Atomics.store(h.signals, 2, 1);
    Atomics.notify(h.signals, 2);
    await signal(h.signals, 21);
    assert.strictEqual(Atomics.load(h.signals, 21), 5);
    Atomics.store(h.signals, 5, 1);
    Atomics.notify(h.signals, 5);
    await signal(h.signals, 6);
    assert.ok(h.spawn("idle").get_id() > 0);
    assert.strictEqual(Atomics.load(h.signals, 20), 0);
    await h.cleanup();
  } finally {
    await h.cleanup().catch(() => undefined);
  }
});

for (const mode of ["publish", "consume"]) {
  for (const throughCommand of [false, true]) {
    test(`handoff: managed Completing ${mode} excludes retirement (${throughCommand ? "command" : "reservation"})`, async () => {
      const h = await harness();
      const killer = new Worker(
        new URL("./test_workers/handoff_killer.ts", import.meta.url).href,
      );
      try {
        if (mode === "consume") {
          const allocator = AllocatorUseArrayBuffer.init_self(
            h.reference.allocator,
          );
          const [ptr, len] = allocator.block_write(
            new TextEncoder().encode(
              JSON.stringify({ name: "Error", message: "consume me" }),
            ),
            new SharedArrayBuffer(8),
            0,
          );
          const completion = new Int32Array(h.reference.lock, 12, 3);
          Atomics.store(completion, 1, ptr);
          Atomics.store(completion, 2, len);
          Atomics.store(completion, 0, RuntimeCompletion.Error);
        }
        h.spawn(mode);
        await signal(h.signals, 1);
        await h.probe(throughCommand ? undefined : 0);
        assert.strictEqual(Atomics.load(h.signals, 20), 0);
        killer.postMessage({
          reference: h.reference,
          control: h.signals.buffer,
          id: 0,
        });
        await signal(h.signals, 7);
        assert.strictEqual(
          Atomics.load(h.signals, 7),
          throughCommand ? 2 : 4,
          "wait uses the observed gate state",
        );
        assert.strictEqual(Atomics.load(h.signals, 20), 0);
        Atomics.store(h.signals, 2, 1);
        Atomics.notify(h.signals, 2);
        await signal(h.signals, 20);
        await signal(h.signals, 8);
        assert.strictEqual(Atomics.load(h.signals, 20), 5);
        assert.strictEqual(
          new Int32Array(h.reference.lock)[3],
          mode === "publish"
            ? RuntimeCompletion.Exit
            : RuntimeCompletion.ErrorConsumed,
        );
        assert.strictEqual(
          new Int32Array(h.reference.allocator.share_arrays_memory)[1],
          0,
        );
        await h.cleanup();
      } finally {
        killer.terminate();
        await h.cleanup().catch(() => undefined);
      }
    });
  }
}

test("handoff: owner recovers a real coordinator crash while Coordinator owns the gate", async () => {
  const control = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const signals = new Int32Array(control.buffer);
  const spawner = new ThreadSpawner(
    new URL("./test_workers/noop_worker.ts", import.meta.url).href,
    [],
    { control },
    undefined,
    undefined,
    undefined,
    new URL("./test_workers/handoff_crash_coordinator.ts", import.meta.url)
      .href,
  );
  try {
    await bounded(spawner.wait_worker_background_worker());
    spawner.thread_spawn(0, [], [], []);
    spawner.kill_animal(0);
    await signal(signals, 1);
    const coordinator = (
      spawner as unknown as { worker_background_worker: Worker }
    ).worker_background_worker;
    coordinator.postMessage("crash");
    await assert.rejects(
      bounded(
        waitForDestroyTerminal(
          new Int32Array(spawner.get_object().destroy_status),
        ),
      ),
      /coordinator/i,
    );
    await assert.rejects(spawner.async_destroy(), /coordinator/i);
    assert.strictEqual(
      new Int32Array(spawner.get_object().worker_background_ref_object.lock)[0],
      0,
    );
  } finally {
    await bounded(spawner.async_destroy()).catch(() => undefined);
  }
});

test("handoff: runtime-wide stop includes a creation published while draining", async () => {
  const h = await harness();
  try {
    h.spawn("error");
    h.spawn("preparing");
    await signal(h.signals, 1);
    Atomics.store(h.signals, 3, 1);
    Atomics.notify(h.signals, 3);
    await signal(h.signals, 15);
    assert.strictEqual(Atomics.load(h.signals, 21), 0);
    Atomics.store(h.signals, 2, 1);
    Atomics.notify(h.signals, 2);
    await signal(h.signals, 21);
    assert.strictEqual(
      Atomics.load(h.signals, 12),
      5,
      "in-flight creation was Cancelled, not launched",
    );
    await assert.rejects(h.ref.async_wait_done_or_error(), /ordinary error/);
    assert.strictEqual(
      readLifecycle(new Int32Array(h.reference.destroy_status)),
      WorkerLifecycle.Running,
    );
  } finally {
    await h.cleanup();
  }
});

test("handoff: requester Closing wait releases then reacquires the gate", async () => {
  const h = await harness();
  try {
    h.spawn("requester");
    Atomics.store(h.signals, 11, 1);
    Atomics.notify(h.signals, 11);
    await signal(h.signals, 9);
    assert.strictEqual(
      Atomics.load(h.signals, 9),
      1,
      "Drained is observable with a free gate",
    );
    Atomics.store(h.signals, 10, 1);
    Atomics.notify(h.signals, 10);
    await signal(h.signals, 1);
    markRequesterClosing(new Int32Array(h.reference.destroy_status));
    const lock = new Int32Array(h.reference.lock);
    await bounded(
      (async () => {
        for (;;) {
          const epoch = Atomics.load(lock, 6);
          if (Atomics.load(lock, 0) === 3) return;
          await Atomics.waitAsync(lock, 6, epoch).value;
        }
      })(),
    );
    await h.probe();
    assert.strictEqual(Atomics.load(h.signals, 20), 0);
    assert.strictEqual(new Int32Array(h.reference.lock)[0], 3);
    Atomics.store(h.signals, 2, 1);
    Atomics.notify(h.signals, 2);
    await bounded(
      waitForDestroyTerminal(new Int32Array(h.reference.destroy_status)),
    );
    assert.strictEqual(Atomics.load(h.signals, 20), 5);
    assert.strictEqual(new Int32Array(h.reference.lock)[0], 0);
  } finally {
    await h.cleanup();
  }
});

test("handoff: default generated coordinator selfkill and sibling reuse (10 runtimes)", async () => {
  for (let run = 0; run < 10; run++) {
    const control = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const signals = new Int32Array(control.buffer);
    const spawner = new ThreadSpawner(
      new URL("./test_workers/handoff_animal.ts", import.meta.url).href,
      [],
      { control },
    );
    try {
      await bounded(spawner.wait_worker_background_worker());
      spawner.thread_spawn(0, ["sibling"], [], []);
      spawner.thread_spawn(0, ["selfkill"], [], []);
      await signal(signals, 1);
      const lock = new Int32Array(
        spawner.get_object().worker_background_ref_object.lock,
      );
      assert.strictEqual(Atomics.load(lock, 0), 3);
      Atomics.store(signals, 2, 1);
      Atomics.notify(signals, 2);
      await bounded(
        (async () => {
          for (;;) {
            const epoch = Atomics.load(lock, 6);
            if (Atomics.load(lock, 0) === 0) return;
            await Atomics.waitAsync(lock, 6, epoch).value;
          }
        })(),
      );
      Atomics.store(signals, 5, 1);
      Atomics.notify(signals, 5);
      await signal(signals, 6);
      await bounded(spawner.async_destroy());
      assert.strictEqual(Atomics.load(lock, 0), 0);
    } finally {
      Atomics.store(signals, 2, 1);
      Atomics.notify(signals, 2);
      await bounded(spawner.async_destroy()).catch(() => undefined);
    }
  }
});
