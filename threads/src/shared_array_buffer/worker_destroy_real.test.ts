import assert from "node:assert";
import { describe, test } from "node:test";
import { File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "../farm.ts";
import type { WASIFarmRefObject } from "../ref.ts";
import { ThreadSpawner } from "./thread_spawn.ts";
import { WorkerBackgroundRef } from "./worker_background/worker_background_ref.ts";
import {
  DESTROY_REQUESTER_STATUS,
  readLifecycle,
  RequesterStatus,
  WorkerLifecycle,
} from "./worker_lifecycle.ts";

const REAL_COORDINATOR_URL = new URL(
  "./worker_background/worker.ts",
  import.meta.url,
).href;
const REQUESTER_WORKER_URL = new URL(
  "./test_workers/managed_requester_worker.ts",
  import.meta.url,
).href;
const OBSERVABLE_WORKER_URL = new URL(
  "./test_workers/observable_animal_worker.ts",
  import.meta.url,
).href;
const SPAWN_WORKER_URL = new URL(
  "./test_workers/managed_spawn_worker.ts",
  import.meta.url,
).href;

const STDIO_FD_MAP: [number, number][] = [
  [0, 0],
  [1, 0],
  [2, 0],
];
const REQUESTER_RESOLVED = 1;
const REQUESTER_RELEASED = 2;

type Observation = {
  animal_id?: number;
  lifecycle?: number;
  requester_status?: number;
  seq?: number;
  token?: string;
  type?: string;
};

function createFarm(): WASIFarm {
  return new WASIFarm(
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    new OpenFile(new File([])),
  );
}

function createSpawner(
  workerUrl: string,
  refs: WASIFarmRefObject[] = [],
): ThreadSpawner {
  return new ThreadSpawner(
    workerUrl,
    refs,
    undefined,
    16_777_216,
    undefined,
    undefined,
    REAL_COORDINATOR_URL,
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = 3_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  await withTimeout(
    (async () => {
      while (!predicate()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    })(),
    label,
  );
}

async function cleanupSpawner(spawner: ThreadSpawner): Promise<void> {
  spawner.destroy();
  await withTimeout(spawner.async_destroy(), "real coordinator cleanup").catch(
    () => undefined,
  );
}

async function spawnManagedAnimal(
  worker: Worker,
  spawner: ThreadSpawner,
  args: string[],
  label: string,
): Promise<void> {
  const requestId = crypto.randomUUID();
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      worker.onmessage = (
        event: MessageEvent<{
          error?: string;
          request_id?: string;
          type?: string;
        }>,
      ) => {
        if (event.data.request_id !== requestId) return;
        worker.onmessage = null;
        worker.onerror = null;
        if (event.data.type === "spawned") resolve();
        else reject(new Error(event.data.error ?? "managed spawn failed"));
      };
      worker.onerror = (event) =>
        reject(event.error ?? new Error(event.message));
      worker.postMessage({
        args,
        fd_map: STDIO_FD_MAP,
        request_id: requestId,
        spawner: spawner.get_object(),
      });
    }),
    label,
  );
}

function observeChannel(channel: BroadcastChannel): {
  events: Observation[];
  heartbeatCount: (token: string) => number;
  readyId: (token: string) => number | undefined;
} {
  const events: Observation[] = [];
  const heartbeats = new Map<string, number>();
  const readyIds = new Map<string, number>();
  channel.onmessage = (event: MessageEvent<Observation>) => {
    const message = event.data;
    events.push(message);
    if (
      message.type === "managed-ready" &&
      message.animal_id !== undefined &&
      message.token !== undefined
    ) {
      readyIds.set(message.token, message.animal_id);
    }
    if (message.type === "heartbeat" && message.token !== undefined) {
      heartbeats.set(message.token, (heartbeats.get(message.token) ?? 0) + 1);
    }
  };
  return {
    events,
    heartbeatCount: (token) => heartbeats.get(token) ?? 0,
    readyId: (token) => readyIds.get(token),
  };
}

describe("real managed Animal lifecycle races", () => {
  test("managed requester resolves at Drained before scheduled Closing and terminal teardown", async () => {
    const channelName = `managed-requester-${crypto.randomUUID()}`;
    const channel = new BroadcastChannel(channelName);
    const observations = observeChannel(channel);
    const farm = createFarm();
    const spawner = createSpawner(REQUESTER_WORKER_URL, [farm.get_ref()]);
    const requesterGate = new Int32Array(
      spawner.get_object().animal_id_counter,
    );
    try {
      await withTimeout(
        spawner.wait_worker_background_worker(),
        "requester coordinator readiness",
      );
      const workerRef = (
        spawner as unknown as { worker_background_ref: WorkerBackgroundRef }
      ).worker_background_ref;
      const operation = workerRef.async_start_on_thread(
        REQUESTER_WORKER_URL,
        { type: "module" },
        {
          args: [channelName],
          env: [],
          fd_map: STDIO_FD_MAP,
          this_is_start: true,
          this_is_thread_spawn: true,
        },
      );
      await withTimeout(operation, "managed requester assigned readiness");
      await waitFor(
        () => observations.events.some((event) => event.type === "requesting"),
        "managed requester readiness",
      );
      channel.postMessage({ type: "begin-destroy" });

      await waitFor(
        () => Atomics.load(requesterGate, 0) === REQUESTER_RESOLVED,
        "managed requester async resolution",
      );
      const destroyView = new Int32Array(spawner.get_object().destroy_status);
      assert.strictEqual(
        Atomics.load(destroyView, DESTROY_REQUESTER_STATUS),
        RequesterStatus.RequesterDrained,
      );
      assert.strictEqual(
        readLifecycle(destroyView),
        WorkerLifecycle.Destroying,
      );
      Atomics.store(requesterGate, 0, REQUESTER_RELEASED);
      Atomics.notify(requesterGate, 0);
      await waitFor(
        () =>
          Atomics.load(destroyView, DESTROY_REQUESTER_STATUS) ===
          RequesterStatus.Closing,
        "scheduled requester Closing",
      );
      await withTimeout(spawner.async_destroy(), "managed requester terminal");
      assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Destroyed);
    } finally {
      Atomics.store(requesterGate, 0, REQUESTER_RELEASED);
      Atomics.notify(requesterGate, 0);
      channel.close();
      await cleanupSpawner(spawner);
      farm.destroy();
    }
  });

  test("two live Workers have distinct IDs and repeated kill stops only the selected activity", async () => {
    const channelName = `selective-kill-${crypto.randomUUID()}`;
    const channel = new BroadcastChannel(channelName);
    const observations = observeChannel(channel);
    const farm = createFarm();
    const spawner = createSpawner(OBSERVABLE_WORKER_URL, [farm.get_ref()]);
    const spawnWorker = new Worker(SPAWN_WORKER_URL, { type: "module" });
    const firstToken = "first";
    const secondToken = "second";
    try {
      await withTimeout(
        spawner.wait_worker_background_worker(),
        "kill coordinator readiness",
      );
      await spawnManagedAnimal(
        spawnWorker,
        spawner,
        [channelName, firstToken],
        "first managed spawn",
      );
      await spawnManagedAnimal(
        spawnWorker,
        spawner,
        [channelName, secondToken],
        "second managed spawn",
      );
      await waitFor(
        () =>
          observations.readyId(firstToken) !== undefined &&
          observations.readyId(secondToken) !== undefined &&
          observations.heartbeatCount(firstToken) >= 2 &&
          observations.heartbeatCount(secondToken) >= 2,
        "two live Animal heartbeats",
      );
      const firstId = observations.readyId(firstToken);
      const secondId = observations.readyId(secondToken);
      assert.ok(firstId !== undefined);
      assert.ok(secondId !== undefined);
      assert.notStrictEqual(firstId, secondId);

      spawner.kill_animal(firstId);
      const secondFlushTarget = observations.heartbeatCount(secondToken) + 2;
      await waitFor(
        () => observations.heartbeatCount(secondToken) >= secondFlushTarget,
        "survivor heartbeat flush",
      );
      const stoppedFirstCount = observations.heartbeatCount(firstToken);
      const secondProofTarget = observations.heartbeatCount(secondToken) + 3;
      await waitFor(
        () => observations.heartbeatCount(secondToken) >= secondProofTarget,
        "survivor after first kill",
      );
      assert.strictEqual(
        observations.heartbeatCount(firstToken),
        stoppedFirstCount,
      );

      spawner.kill_animal(firstId);
      const repeatedProofTarget = observations.heartbeatCount(secondToken) + 3;
      await waitFor(
        () => observations.heartbeatCount(secondToken) >= repeatedProofTarget,
        "survivor after repeated kill",
      );
      assert.strictEqual(
        observations.heartbeatCount(firstToken),
        stoppedFirstCount,
      );
    } finally {
      spawnWorker.terminate();
      channel.close();
      await cleanupSpawner(spawner);
      farm.destroy();
    }
  });

  for (const outcome of ["error", "exit"] as const) {
    test(`real ${outcome} sender stops after registry cleanup and publishes runtime result`, async () => {
      const channelName = `${outcome}-sender-${crypto.randomUUID()}`;
      const channel = new BroadcastChannel(channelName);
      const observations = observeChannel(channel);
      const farm = createFarm();
      const spawner = createSpawner(OBSERVABLE_WORKER_URL, [farm.get_ref()]);
      const spawnWorker = new Worker(SPAWN_WORKER_URL, { type: "module" });
      const senderToken = `${outcome}-sender`;
      const replacementToken = `${outcome}-replacement`;
      try {
        await withTimeout(
          spawner.wait_worker_background_worker(),
          `${outcome} coordinator readiness`,
        );
        await spawnManagedAnimal(
          spawnWorker,
          spawner,
          [channelName, senderToken],
          `${outcome} managed sender spawn`,
        );
        await waitFor(
          () =>
            observations.readyId(senderToken) !== undefined &&
            observations.heartbeatCount(senderToken) >= 2,
          `${outcome} sender activity`,
        );
        const animalId = observations.readyId(senderToken);
        assert.ok(animalId !== undefined);
        const runtimeResult = spawner.async_wait_done_or_error();
        channel.postMessage({
          animal_id: animalId,
          outcome,
          token: senderToken,
          type: "trigger",
        });
        if (outcome === "error") {
          await assert.rejects(
            withTimeout(runtimeResult, "real error runtime result"),
            /real Animal error/,
          );
        } else {
          assert.strictEqual(
            await withTimeout(runtimeResult, "real exit runtime result"),
            23,
          );
        }

        await spawnManagedAnimal(
          spawnWorker,
          spawner,
          [channelName, replacementToken],
          `${outcome} managed replacement spawn`,
        );
        await waitFor(
          () =>
            observations.readyId(replacementToken) !== undefined &&
            observations.heartbeatCount(replacementToken) >= 2,
          `${outcome} replacement activity`,
        );
        assert.strictEqual(observations.readyId(replacementToken), animalId);
        const stoppedCount = observations.heartbeatCount(senderToken);
        const replacementProofTarget =
          observations.heartbeatCount(replacementToken) + 3;
        await waitFor(
          () =>
            observations.heartbeatCount(replacementToken) >=
            replacementProofTarget,
          `${outcome} sender stop proof`,
        );
        assert.strictEqual(
          observations.heartbeatCount(senderToken),
          stoppedCount,
        );
      } finally {
        spawnWorker.terminate();
        channel.close();
        await cleanupSpawner(spawner);
        farm.destroy();
      }
    });
  }
});
