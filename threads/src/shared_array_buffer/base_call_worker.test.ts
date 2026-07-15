import { File, OpenFile, PreopenDirectory } from "@bjorn3/browser_wasi_shim";
import assert from "node:assert";
import test from "node:test";
import { WASIFarm } from "../farm.ts";
import type { WASIFarmRefObject } from "../ref.ts";

type WorkerRequest = { wasiRef: WASIFarmRefObject };
type WorkerResult = { ok: true; value: unknown } | { ok: false; error: string };

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

function runWorker(
  worker: Worker,
  request: WorkerRequest,
  timeoutMs = 5_000,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Worker timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message));
    };
    worker.onmessageerror = () => {
      clearTimeout(timer);
      reject(new Error("Worker message could not be decoded"));
    };
    worker.postMessage(request);
  });
}

function destroyFarm(farm: WASIFarm): void {
  const destroy = (farm as WASIFarm & { destroy?: () => void }).destroy;
  if (destroy !== undefined) {
    destroy.call(farm);
    return;
  }
  (
    farm as unknown as {
      park: { destroy(): void } | null;
    }
  ).park?.destroy();
}

test("callback throws cross the actual Worker boundary", async () => {
  const farm = createTestFarm(() => {
    throw new Error("callback boom");
  });
  const outer = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );

  try {
    const result = await runWorker(outer, { wasiRef: farm.get_ref() });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /callback boom/);
    }
  } finally {
    outer.terminate();
    destroyFarm(farm);
  }
});

test("reentrant Animal calls complete through actual Workers", async () => {
  let inner: Worker | undefined;
  let farm: WASIFarm;
  farm = createTestFarm(async (arg) => {
    assert.deepStrictEqual(arg, {
      kind: inner === undefined ? "outer" : "inner",
    });
    if (inner !== undefined) {
      return "inner-ok";
    }

    inner = new Worker(
      new URL("./test_workers/base_call_inner_worker.ts", import.meta.url).href,
    );
    const result = await runWorker(inner, { wasiRef: farm.get_ref() });
    assert.deepStrictEqual(result, { ok: true, value: "inner-ok" });
    return "outer-ok";
  });
  const outer = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );

  try {
    const result = await runWorker(outer, { wasiRef: farm.get_ref() });
    assert.deepStrictEqual(result, { ok: true, value: "outer-ok" });
  } finally {
    outer.terminate();
    inner?.terminate();
    destroyFarm(farm);
  }
});
