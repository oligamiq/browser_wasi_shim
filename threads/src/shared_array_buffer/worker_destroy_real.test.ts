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
const CONTROL_WORKER_URL = new URL(
  "./test_workers/broadcast_control_worker.ts",
  import.meta.url,
).href;

type Observation = {
  animal_id?: number;
  lifecycle?: number;
  requester_status?: number;
  seq?: number;
  type?: string;
};

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

function observeChannel(channel: BroadcastChannel): {
  controlHeartbeats: () => number;
  events: Observation[];
  heartbeatCount: (animalId: number) => number;
  readyIds: Set<number>;
} {
  const events: Observation[] = [];
  const heartbeats = new Map<number, number>();
  const readyIds = new Set<number>();
  let controlHeartbeats = 0;
  channel.onmessage = (event: MessageEvent<Observation>) => {
    const message = event.data;
    events.push(message);
    if (message.type === "ready" && message.animal_id !== undefined) {
      readyIds.add(message.animal_id);
    }
    if (message.type === "heartbeat" && message.animal_id !== undefined) {
      heartbeats.set(
        message.animal_id,
        (heartbeats.get(message.animal_id) ?? 0) + 1,
      );
    }
    if (message.type === "control-heartbeat") controlHeartbeats += 1;
  };
  return {
    controlHeartbeats: () => controlHeartbeats,
    events,
    heartbeatCount: (animalId) => heartbeats.get(animalId) ?? 0,
    readyIds,
  };
}

describe("real managed Animal lifecycle races", () => {
  test("managed requester resolves at Drained before scheduled Closing and terminal teardown", async () => {
    const channelName = `managed-requester-${crypto.randomUUID()}`;
    const channel = new BroadcastChannel(channelName);
    const observations = observeChannel(channel);
    const farm = new WASIFarm(
      new OpenFile(new File([])),
      new OpenFile(new File([])),
      new OpenFile(new File([])),
    );
    const spawner = createSpawner(REQUESTER_WORKER_URL, [farm.get_ref()]);
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
          fd_map: [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
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
        () => observations.events.some((event) => event.type === "resolved"),
        "managed requester resolution",
      );
      const resolved = observations.events.find(
        (event) => event.type === "resolved",
      );
      assert.strictEqual(
        resolved?.requester_status,
        RequesterStatus.RequesterDrained,
      );
      assert.strictEqual(resolved?.lifecycle, WorkerLifecycle.Destroying);
      await withTimeout(spawner.async_destroy(), "managed requester terminal");
      const destroyView = new Int32Array(spawner.get_object().destroy_status);
      assert.strictEqual(
        Atomics.load(destroyView, DESTROY_REQUESTER_STATUS),
        RequesterStatus.Closing,
      );
      assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Destroyed);
    } finally {
      channel.close();
      await cleanupSpawner(spawner);
      farm.destroy();
    }
  });

  test("two live Workers have distinct IDs and repeated kill stops only the selected activity", async () => {
    const channelName = `selective-kill-${crypto.randomUUID()}`;
    const channel = new BroadcastChannel(channelName);
    const observations = observeChannel(channel);
    const spawner = createSpawner(OBSERVABLE_WORKER_URL);
    try {
      await withTimeout(
        spawner.wait_worker_background_worker(),
        "kill coordinator readiness",
      );
      spawner.thread_spawn(0, [channelName], [], []);
      spawner.thread_spawn(0, [channelName], [], []);
      await waitFor(
        () =>
          observations.readyIds.size === 2 &&
          [...observations.readyIds].every(
            (animalId) => observations.heartbeatCount(animalId) >= 2,
          ),
        "two live Animal heartbeats",
      );
      const [firstId, secondId] = [...observations.readyIds];
      assert.notStrictEqual(firstId, secondId);

      spawner.kill_animal(firstId);
      const secondFlushTarget = observations.heartbeatCount(secondId) + 2;
      await waitFor(
        () => observations.heartbeatCount(secondId) >= secondFlushTarget,
        "survivor heartbeat flush",
      );
      const stoppedFirstCount = observations.heartbeatCount(firstId);
      const secondProofTarget = observations.heartbeatCount(secondId) + 3;
      await waitFor(
        () => observations.heartbeatCount(secondId) >= secondProofTarget,
        "survivor after first kill",
      );
      assert.strictEqual(
        observations.heartbeatCount(firstId),
        stoppedFirstCount,
      );

      spawner.kill_animal(firstId);
      const repeatedProofTarget = observations.heartbeatCount(secondId) + 3;
      await waitFor(
        () => observations.heartbeatCount(secondId) >= repeatedProofTarget,
        "survivor after repeated kill",
      );
      assert.strictEqual(
        observations.heartbeatCount(firstId),
        stoppedFirstCount,
      );
    } finally {
      channel.close();
      await cleanupSpawner(spawner);
    }
  });

  for (const outcome of ["error", "exit"] as const) {
    test(`real ${outcome} sender stops after registry cleanup and publishes runtime result`, async () => {
      const channelName = `${outcome}-sender-${crypto.randomUUID()}`;
      const channel = new BroadcastChannel(channelName);
      const observations = observeChannel(channel);
      const control = new Worker(CONTROL_WORKER_URL, { type: "module" });
      const spawner = createSpawner(OBSERVABLE_WORKER_URL);
      try {
        control.postMessage({ channel: channelName });
        await withTimeout(
          spawner.wait_worker_background_worker(),
          `${outcome} coordinator readiness`,
        );
        spawner.thread_spawn(0, [channelName], [], []);
        await waitFor(
          () =>
            observations.readyIds.size === 1 &&
            observations.controlHeartbeats() >= 2 &&
            observations.heartbeatCount([...observations.readyIds][0]) >= 2,
          `${outcome} sender activity`,
        );
        const animalId = [...observations.readyIds][0];
        const runtimeResult = spawner.async_wait_done_or_error();
        channel.postMessage({ animal_id: animalId, outcome, type: "trigger" });
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

        const controlFlushTarget = observations.controlHeartbeats() + 2;
        await waitFor(
          () => observations.controlHeartbeats() >= controlFlushTarget,
          `${outcome} control flush`,
        );
        const stoppedCount = observations.heartbeatCount(animalId);
        const controlProofTarget = observations.controlHeartbeats() + 3;
        await waitFor(
          () => observations.controlHeartbeats() >= controlProofTarget,
          `${outcome} sender stop proof`,
        );
        assert.strictEqual(observations.heartbeatCount(animalId), stoppedCount);
      } finally {
        control.terminate();
        channel.close();
        await cleanupSpawner(spawner);
      }
    });
  }
});
