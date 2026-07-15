import { File, OpenFile, PreopenDirectory } from "@bjorn3/browser_wasi_shim";
import assert from "node:assert";
import test from "node:test";
import { WASIFarmAnimal } from "../animals.ts";
import { WASIFarm } from "../farm.ts";
import type { WASIFarmRefObject } from "../ref.ts";
import * as publicApi from "../index.ts";
import {
  BaseCallOpcode,
  BaseCallRefUseArrayBuffer,
  type BaseCallTransportObject,
} from "./base_call.ts";

function createTestFarm(
  unknown_fn?: (arg: unknown) => Promise<unknown> | unknown,
  max_base_calls_limit = 4,
): WASIFarm {
  return new WASIFarm(
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    [new PreopenDirectory("/", new Map())],
    { unknown_fn, max_base_calls_limit },
  );
}

function destroyFarm(farm: WASIFarm): void {
  const destroy = (farm as WASIFarm & { destroy?: () => void }).destroy;
  if (destroy !== undefined) {
    destroy.call(farm);
    return;
  }

  // Keeps the RED run from leaking the v1 listener before WASIFarm.destroy exists.
  (
    farm as unknown as {
      park: { destroy(): void } | null;
    }
  ).park?.destroy();
}

test("validates and propagates max_base_calls_limit", () => {
  for (const maxBaseCalls of [0, -1, 1025, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => createTestFarm(undefined, maxBaseCalls), RangeError);
  }

  const farm = createTestFarm(undefined, 3);
  try {
    const concrete = farm.get_ref() as unknown as {
      baseCall: BaseCallTransportObject;
    };
    assert.strictEqual(concrete.baseCall.userSlotCount, 3);
  } finally {
    destroyFarm(farm);
  }
});

test("exports cloneable public farm reference data and capacity errors", () => {
  assert.strictEqual(
    typeof (publicApi as Record<string, unknown>).BaseCallCapacityError,
    "function",
  );

  const farm = createTestFarm();
  try {
    const concrete = farm.get_ref();
    const publicRef: WASIFarmRefObject = structuredClone(concrete);
    assert.deepStrictEqual(publicRef.default_fds, concrete.default_fds);
  } finally {
    destroyFarm(farm);
  }
});

test("owner destroy is idempotent and rejects later get_ref calls", () => {
  const farm = createTestFarm();
  const destroy = (farm as WASIFarm & { destroy(): void }).destroy;

  destroy.call(farm);
  destroy.call(farm);

  assert.throws(() => farm.get_ref(), /already destroyed/i);
});

test("owner destroy prevents a waiting fd replacement from restarting", async () => {
  const farm = createTestFarm();
  const park = (
    farm as unknown as {
      park: {
        notify_set_fd(fd: number): Promise<void>;
        listen_fds_terminator: Array<(() => void) | null | undefined>;
      };
    }
  ).park;

  const replacement = park.notify_set_fd(0);
  await Promise.resolve();
  farm.destroy();
  await replacement;

  assert.strictEqual(park.listen_fds_terminator[0], null);
});

test("duplicate fd mappings are ignored", async () => {
  const farm = createTestFarm();
  try {
    const concrete = farm.get_ref() as unknown as {
      baseCall: BaseCallTransportObject;
    };
    const ref = BaseCallRefUseArrayBuffer.init_self(concrete.baseCall);
    const words = new Uint32Array([7, 0]);
    const payload = new Uint8Array(
      words.buffer,
      words.byteOffset,
      words.byteLength,
    );

    await ref.async_call(BaseCallOpcode.SetParkFdsMap, payload);
    await ref.async_call(BaseCallOpcode.SetParkFdsMap, payload);

    const park = (
      farm as unknown as {
        park: { fds_map: Array<number[]> };
      }
    ).park;
    assert.deepStrictEqual(park.fds_map[0], [7]);
  } finally {
    destroyFarm(farm);
  }
});

type DestroyScopeAnimal = WASIFarmAnimal & {
  thread_spawner?: { destroy(): void };
  wasi_farm_refs: Array<{ destroy_park(): void }>;
  id_in_wasi_farm_ref: number[];
  fd_map: Array<[number, number] | undefined>;
};

function createDestroyScopeAnimal(events: string[]): WASIFarmAnimal {
  return Object.assign(Object.create(WASIFarmAnimal.prototype), {
    thread_spawner: { destroy: () => events.push("animal") },
    wasi_farm_refs: [
      { destroy_park: () => events.push("park-0") },
      { destroy_park: () => events.push("park-1") },
    ],
    id_in_wasi_farm_ref: [0, 1],
    fd_map: [],
  }) as DestroyScopeAnimal;
}

test("destroy-series methods retain their existing scopes", () => {
  const destroyEvents: string[] = [];
  createDestroyScopeAnimal(destroyEvents).destroy();
  assert.deepStrictEqual(destroyEvents, ["animal"]);

  const oneParkEvents: string[] = [];
  createDestroyScopeAnimal(oneParkEvents).destroy_park(1);
  assert.deepStrictEqual(oneParkEvents, ["park-1"]);

  const allParkEvents: string[] = [];
  createDestroyScopeAnimal(allParkEvents).destroy_park_all();
  assert.deepStrictEqual(allParkEvents, ["park-0", "park-1"]);

  const combinedEvents: string[] = [];
  createDestroyScopeAnimal(combinedEvents).destroy_with_park();
  assert.deepStrictEqual(combinedEvents, ["park-0", "park-1", "animal"]);
});
