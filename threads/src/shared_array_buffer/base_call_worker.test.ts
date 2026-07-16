import { File, OpenFile, PreopenDirectory } from "@bjorn3/browser_wasi_shim";
import assert from "node:assert";
import test from "node:test";
import { WASIFarm } from "../farm.ts";
import type { WASIFarmRefObject } from "../ref.ts";
import type { BaseCallTransportObject } from "./base_call.ts";

const SLOT_WORDS = 12;
const SLOT_STATE = 0;
const SLOT_RESPONSE_POINTER = 6;
const SLOT_RESPONSE_LENGTH = 7;
const SLOT_ERROR_POINTER = 8;
const SLOT_ERROR_LENGTH = 9;
const FREE = 0;
const RUNNING = 3;
const CANCELLED = 6;

type WorkerRequest = { wasiRef: WASIFarmRefObject; arg?: unknown };
type WorkerResult = { ok: true; value: unknown } | { ok: false; error: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMilliseconds = 1_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(
        `condition was not met within ${timeoutMilliseconds} milliseconds`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function getBaseCallTransport(farm: WASIFarm): BaseCallTransportObject {
  return (
    farm.get_ref() as unknown as {
      baseCall: BaseCallTransportObject;
    }
  ).baseCall;
}

function slotWord(slotIndex: number, word: number): number {
  return slotIndex * SLOT_WORDS + word;
}

function createTestFarm(
  unknown_fn?: (arg: unknown) => Promise<unknown> | unknown,
  max_base_calls_limit = 4,
  base_call_allocator_size?: number,
): WASIFarm {
  return new WASIFarm(
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    [new PreopenDirectory("/", new Map())],
    { unknown_fn, max_base_calls_limit, base_call_allocator_size },
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

test("custom allocator carries a payload larger than the default through an actual Worker", async () => {
  const payloadLength = 11 * 1024 * 1024;
  const payload = "x".repeat(payloadLength);

  const callback = (arg: unknown) => {
    assert.deepStrictEqual(arg, { kind: "large-response" });
    return { payload };
  };
  const defaultFarm = createTestFarm(callback);
  const expandedFarm = createTestFarm(callback, 4, 12 * 1024 * 1024);
  const defaultWorker = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );
  const expandedWorker = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );

  try {
    const rejected = await runWorker(
      defaultWorker,
      { wasiRef: defaultFarm.get_ref(), arg: { kind: "large-response" } },
      60_000,
    );
    assert.strictEqual(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.error, /OutOfMemory/i);

    const accepted = await runWorker(
      expandedWorker,
      { wasiRef: expandedFarm.get_ref(), arg: { kind: "large-response" } },
      60_000,
    );
    assert.strictEqual(accepted.ok, true);
    if (accepted.ok) {
      const value = accepted.value as { payload: string };
      assert.strictEqual(value.payload.length, payloadLength);
      assert.strictEqual(value.payload[0], "x");
      assert.strictEqual(value.payload.at(-1), "x");
    }
  } finally {
    defaultWorker.terminate();
    expandedWorker.terminate();
    destroyFarm(defaultFarm);
    destroyFarm(expandedFarm);
  }
});

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

test("two Animals sequentially reuse one farm", async () => {
  const calls: unknown[] = [];
  const farm = createTestFarm((arg) => {
    calls.push(arg);
    return `${String(arg)}-ok`;
  });
  const first = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );
  const second = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );

  try {
    assert.deepStrictEqual(
      await runWorker(first, { wasiRef: farm.get_ref(), arg: "first" }),
      { ok: true, value: "first-ok" },
    );
    first.terminate();
    assert.deepStrictEqual(
      await runWorker(second, { wasiRef: farm.get_ref(), arg: "second" }),
      { ok: true, value: "second-ok" },
    );
    assert.deepStrictEqual(calls, ["first", "second"]);
  } finally {
    first.terminate();
    second.terminate();
    destroyFarm(farm);
  }
});

test("concurrent unknown callbacks complete in reverse order without cross-talk", async () => {
  const resolvers = new Map<string, (value: string) => void>();
  const farm = createTestFarm((arg) => {
    if (typeof arg !== "string") {
      throw new TypeError("expected a string callback argument");
    }
    return new Promise<string>((resolve) => {
      resolvers.set(arg, resolve);
    });
  });
  const first = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );
  const second = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );

  try {
    const completionOrder: string[] = [];
    const firstCall = runWorker(first, {
      wasiRef: farm.get_ref(),
      arg: "first",
    }).then((result) => {
      completionOrder.push("first");
      return result;
    });
    const secondCall = runWorker(second, {
      wasiRef: farm.get_ref(),
      arg: "second",
    }).then((result) => {
      completionOrder.push("second");
      return result;
    });
    void firstCall.catch(() => undefined);
    void secondCall.catch(() => undefined);

    await waitUntil(() => resolvers.size === 2);
    resolvers.get("second")?.("second-result");
    assert.deepStrictEqual(await secondCall, {
      ok: true,
      value: "second-result",
    });
    resolvers.get("first")?.("first-result");
    assert.deepStrictEqual(await firstCall, {
      ok: true,
      value: "first-result",
    });
    assert.deepStrictEqual(completionOrder, ["second", "first"]);
  } finally {
    first.terminate();
    second.terminate();
    destroyFarm(farm);
  }
});

test("callback throw reaches only its caller", async () => {
  const bothStarted = deferred<void>();
  let started = 0;
  const farm = createTestFarm(async (arg) => {
    started++;
    if (started === 2) {
      bothStarted.resolve();
    }
    await bothStarted.promise;
    if (arg === "throw") {
      throw new Error("isolated callback boom");
    }
    return `${String(arg)}-ok`;
  });
  const throwing = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );
  const succeeding = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );

  try {
    const [thrown, succeeded] = await Promise.all([
      runWorker(throwing, { wasiRef: farm.get_ref(), arg: "throw" }),
      runWorker(succeeding, { wasiRef: farm.get_ref(), arg: "succeed" }),
    ]);
    assert.strictEqual(thrown.ok, false);
    if (!thrown.ok) {
      assert.match(thrown.error, /isolated callback boom/);
    }
    assert.deepStrictEqual(succeeded, { ok: true, value: "succeed-ok" });
  } finally {
    throwing.terminate();
    succeeding.terminate();
    destroyFarm(farm);
  }
});

test("farm destroy wakes a running caller and discards late completion", async () => {
  let callbackStarted = false;
  const lateResult = deferred<unknown>();
  let callbackFinished = false;
  const farm = createTestFarm(async (arg) => {
    assert.strictEqual(arg, "late");
    callbackStarted = true;
    const result = await lateResult.promise;
    callbackFinished = true;
    return result;
  }, 1);
  const transport = getBaseCallTransport(farm);
  const slots = new Int32Array(transport.slots);
  const allocatorWords = new Int32Array(
    transport.allocator.share_arrays_memory,
  );
  const caller = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );

  try {
    const call = runWorker(caller, {
      wasiRef: farm.get_ref(),
      arg: "late",
    });
    await waitUntil(() => callbackStarted);
    await waitUntil(
      () => Atomics.load(slots, slotWord(1, SLOT_STATE)) === RUNNING,
    );

    farm.destroy();
    const result = await call;
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /destroyed/i);
    }

    lateResult.resolve({ late: true });
    await waitUntil(() => callbackFinished);

    assert.strictEqual(Atomics.load(slots, slotWord(1, SLOT_STATE)), FREE);
    assert.strictEqual(Atomics.load(allocatorWords, 2), 0);
    assert.strictEqual(
      Atomics.load(slots, slotWord(1, SLOT_RESPONSE_POINTER)),
      0,
    );
    assert.strictEqual(
      Atomics.load(slots, slotWord(1, SLOT_RESPONSE_LENGTH)),
      0,
    );
  } finally {
    caller.terminate();
    destroyFarm(farm);
  }
});

test("a force-terminated caller keeps its slot until farm destroy", async () => {
  let callbackStarted = false;
  const lateResult = deferred<unknown>();
  let callbackFinished = false;
  const farm = createTestFarm(async (arg) => {
    assert.strictEqual(arg, "terminated");
    callbackStarted = true;
    const result = await lateResult.promise;
    callbackFinished = true;
    return result;
  }, 1);
  const transport = getBaseCallTransport(farm);
  const slots = new Int32Array(transport.slots);
  const allocatorWords = new Int32Array(
    transport.allocator.share_arrays_memory,
  );
  const caller = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );

  try {
    const call = runWorker(
      caller,
      { wasiRef: farm.get_ref(), arg: "terminated" },
      1_000,
    );
    void call.catch(() => undefined);
    await waitUntil(() => callbackStarted);
    await waitUntil(
      () => Atomics.load(slots, slotWord(1, SLOT_STATE)) === RUNNING,
    );

    caller.terminate();
    await assert.rejects(call, /timed out/i);
    assert.strictEqual(Atomics.load(slots, slotWord(1, SLOT_STATE)), RUNNING);

    farm.destroy();
    assert.ok(
      [FREE, CANCELLED].includes(Atomics.load(slots, slotWord(1, SLOT_STATE))),
    );
    lateResult.resolve({ late: true });
    await waitUntil(() => callbackFinished);

    for (let slotIndex = 0; slotIndex <= transport.userSlotCount; slotIndex++) {
      const state = Atomics.load(slots, slotWord(slotIndex, SLOT_STATE));
      assert.ok([FREE, CANCELLED].includes(state));
      assert.strictEqual(
        Atomics.load(slots, slotWord(slotIndex, SLOT_RESPONSE_POINTER)),
        0,
      );
      assert.strictEqual(
        Atomics.load(slots, slotWord(slotIndex, SLOT_RESPONSE_LENGTH)),
        0,
      );
      assert.strictEqual(
        Atomics.load(slots, slotWord(slotIndex, SLOT_ERROR_POINTER)),
        0,
      );
      assert.strictEqual(
        Atomics.load(slots, slotWord(slotIndex, SLOT_ERROR_LENGTH)),
        0,
      );
    }
    assert.strictEqual(Atomics.load(allocatorWords, 2), 0);
  } finally {
    caller.terminate();
    destroyFarm(farm);
  }
});
