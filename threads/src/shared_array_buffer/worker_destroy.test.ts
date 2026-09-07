import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import { WASIFarmAnimal } from "../animals.ts";
import { DestroyerHandle } from "../destroyer_handle.ts";
import { AllocatorUseArrayBuffer } from "./allocator.ts";
import { ThreadSpawner, thread_spawn_on_worker } from "./thread_spawn.ts";
import { WorkerBackground } from "./worker_background/worker.ts";
import { WorkerBackgroundRef } from "./worker_background/worker_background_ref.ts";
import type { WorkerBackgroundRefObject } from "./worker_background/worker_export.ts";
import {
  WorkerBackgroundRefObjectConstructor,
  WorkerCommandState,
  wakeWorkerCommandActivity,
} from "./worker_background/worker_export.ts";
import {
  beginDestroy,
  createDestroyStatus,
  DESTROY_FAILURE_CODE,
  DESTROY_REQUESTER_STATUS,
  DESTROY_WAKE_EPOCH,
  markDestroyed,
  markRequesterClosing,
  readLifecycle,
  readRequesterAnimalId,
  RequesterStatus,
  waitForDestroyTerminal,
  WorkerDestroyError,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "./worker_lifecycle.ts";
import {
  completeWorkerRequest,
  createWorkerRequestView,
  RuntimeCompletion,
  WORKER_REQUEST_BYTES,
  WORKER_REQUEST_FAILURE,
  WORKER_REQUEST_STATE,
  WorkerRequestFailure,
  WorkerRequestState,
} from "./worker_request.ts";

const REAL_COORDINATOR_URL = new URL(
  "./worker_background/worker.ts",
  import.meta.url,
).href;

function createTestThreadSpawner(
  backgroundUrl: string,
  workerUrl = new URL("./test_workers/noop_worker.ts", import.meta.url).href,
): ThreadSpawner {
  return new ThreadSpawner(
    workerUrl,
    [],
    undefined,
    16_777_216,
    undefined,
    undefined,
    backgroundUrl,
  );
}

async function cleanupSpawner(spawner: ThreadSpawner): Promise<void> {
  spawner.destroy();
  await withTimeout(spawner.async_destroy(), "coordinator cleanup").catch(
    () => undefined,
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

async function captureDestroyError(
  promise: Promise<unknown>,
): Promise<WorkerDestroyError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WorkerDestroyError);
    return error;
  }
  assert.fail("expected WorkerDestroyError");
}

type WorkerMessageHandler = ((event: MessageEvent) => unknown) | null;
type WorkerErrorHandler = ((event: ErrorEvent) => unknown) | null;
type TestWorkerRecord = {
  worker?: Worker;
  animal_id: number;
  retired: boolean;
  worker_id: number;
  request_view?: Int32Array;
};

class FakeWorker {
  static instances: FakeWorker[] = [];
  static constructorError: Error | undefined;
  static onPostMessage:
    | ((worker: FakeWorker, value: unknown) => void)
    | undefined;
  static onTerminate: ((worker: FakeWorker) => void) | undefined;

  onmessage: WorkerMessageHandler = null;
  onmessageerror: WorkerMessageHandler = null;
  onerror: WorkerErrorHandler = null;
  terminateCount = 0;
  readonly postedMessages: unknown[] = [];

  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {
    if (FakeWorker.constructorError !== undefined) {
      throw FakeWorker.constructorError;
    }
    FakeWorker.instances.push(this);
  }

  postMessage(value: unknown): void {
    this.postedMessages.push(value);
    FakeWorker.onPostMessage?.(this, value);
  }

  terminate(): void {
    this.terminateCount += 1;
    FakeWorker.onTerminate?.(this);
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitError(message: string): void {
    this.onerror?.({
      message,
      preventDefault: () => undefined,
    } as unknown as ErrorEvent);
  }

  emitMessageError(): void {
    this.onmessageerror?.({ data: undefined } as MessageEvent);
  }
}

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalClose = Object.getOwnPropertyDescriptor(globalThis, "close");
const originalPostMessage = Object.getOwnPropertyDescriptor(
  globalThis,
  "postMessage",
);

function installFakeWorker(): void {
  FakeWorker.instances = [];
  FakeWorker.constructorError = undefined;
  FakeWorker.onPostMessage = undefined;
  FakeWorker.onTerminate = undefined;
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
    writable: true,
  });
  Object.defineProperty(globalThis, "close", {
    configurable: true,
    value: () => undefined,
    writable: true,
  });
}

function restoreGlobal(
  name: "Worker" | "close" | "postMessage",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, name);
  } else {
    Object.defineProperty(globalThis, name, descriptor);
  }
}

afterEach(() => {
  restoreGlobal("Worker", originalWorker);
  restoreGlobal("close", originalClose);
  restoreGlobal("postMessage", originalPostMessage);
  FakeWorker.instances = [];
  FakeWorker.constructorError = undefined;
  FakeWorker.onPostMessage = undefined;
  FakeWorker.onTerminate = undefined;
});

function createBackgroundHarness(): {
  allocator: AllocatorUseArrayBuffer;
  background: WorkerBackground<Record<string, never>>;
  destroyView: Int32Array;
  lockView: Int32Array;
  reference: WorkerBackgroundRefObject;
  signatureView: Int32Array;
} {
  const destroyStatus = createDestroyStatus();
  const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
  const allocator = AllocatorUseArrayBuffer.init_self(reference.allocator);
  const background = new WorkerBackground<Record<string, never>>(
    {},
    destroyStatus,
    reference.lock,
    allocator,
    reference.signature_input,
  );
  return {
    allocator,
    background,
    destroyView: new Int32Array(destroyStatus),
    lockView: new Int32Array(reference.lock),
    reference,
    signatureView: new Int32Array(reference.signature_input),
  };
}

type WorkerBackgroundInternals = {
  allocate_animal_id: () => number;
  animal_workers: Map<number, TestWorkerRecord>;
  create_start_worker: (signatureView: Int32Array) => void;
  create_worker: (signatureView: Int32Array) => void;
  free_animal_ids: number[];
  kill_animal: (animalId: number) => void;
  next_animal_id: number;
  pending_animal_workers: Map<number, TestWorkerRecord>;
  register_handlers: (record: TestWorkerRecord, isStart: boolean) => void;
  start_worker?: TestWorkerRecord;
  worker_animals: Map<number, number>;
  workers: Array<TestWorkerRecord | undefined>;
};

function getBackgroundInternals(
  background: WorkerBackground<Record<string, never>>,
): WorkerBackgroundInternals {
  return background as unknown as WorkerBackgroundInternals;
}

function prepareWorkerCommand(
  harness: ReturnType<typeof createBackgroundHarness>,
  opcode: 1 | 2,
): { requestView: Int32Array; releaseRequest: () => void } {
  const address = new SharedArrayBuffer(8);
  const [requestAllocationPtr, requestAllocationLen] =
    harness.allocator.block_write(
      new Uint8Array(WORKER_REQUEST_BYTES + 3),
      address,
      0,
    );
  const requestPtr = (requestAllocationPtr + 3) & ~3;
  const requestView = createWorkerRequestView(
    harness.allocator.share_arrays_memory,
    requestPtr,
    WORKER_REQUEST_BYTES,
  );
  const [urlPtr, urlLen] = harness.allocator.block_write(
    new TextEncoder().encode("fake:animal"),
    address,
    0,
  );
  const [objectPtr, objectLen] = harness.allocator.block_write(
    new TextEncoder().encode("{}"),
    address,
    0,
  );
  Atomics.store(harness.signatureView, 0, opcode);
  Atomics.store(harness.signatureView, 1, urlPtr);
  Atomics.store(harness.signatureView, 2, urlLen);
  Atomics.store(harness.signatureView, 3, 1);
  Atomics.store(harness.signatureView, 4, objectPtr);
  Atomics.store(harness.signatureView, 5, objectLen);
  Atomics.store(harness.signatureView, 6, requestPtr);
  Atomics.store(harness.signatureView, 7, WORKER_REQUEST_BYTES);
  return {
    requestView,
    releaseRequest: () =>
      harness.allocator.free(requestAllocationPtr, requestAllocationLen),
  };
}

function createAnimalWorker(
  harness: ReturnType<typeof createBackgroundHarness>,
  opcode: 1 | 2 = 1,
): {
  bootstrap: { animal_id?: number; worker_id?: number };
  releaseRequest: () => void;
  requestView: Int32Array;
  worker: FakeWorker;
} {
  const command = prepareWorkerCommand(harness, opcode);
  const internals = getBackgroundInternals(harness.background);
  if (opcode === 1) {
    internals.create_worker(harness.signatureView);
  } else {
    internals.create_start_worker(harness.signatureView);
  }
  const worker = FakeWorker.instances.at(-1);
  assert.ok(worker !== undefined);
  return {
    bootstrap: worker.postedMessages[0] as {
      animal_id?: number;
      worker_id?: number;
    },
    releaseRequest: command.releaseRequest,
    requestView: command.requestView,
    worker,
  };
}

function createManagedAnimal(
  reference: WorkerBackgroundRefObject,
  animalId: number,
): WASIFarmAnimal {
  const spawner = ThreadSpawner.init_self({
    animal_id_counter: new SharedArrayBuffer(4),
    destroy_status: reference.destroy_status,
    share_memory: {},
    wasi_farm_refs_object: [],
    worker_background_ref_object: reference,
    worker_url: "fake:animal",
  });
  return createAnimalWithSpawner(spawner, animalId);
}

function createAnimalWithSpawner(
  spawner: ThreadSpawner,
  animalId?: number,
): WASIFarmAnimal {
  const animal = Object.create(WASIFarmAnimal.prototype) as WASIFarmAnimal;
  Object.assign(animal, {
    animal_id: animalId,
    args: [],
    can_thread_spawn: true,
    env: [],
    fd_map: [],
    id_in_wasi_farm_ref: [],
    inst: undefined,
    thread_spawner: spawner,
    wasi_farm_refs: [],
  });
  return animal;
}

describe("ThreadSpawner coordinator ownership", () => {
  test("owner recovers a crashed coordinator-owned termination gate", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const spawner = createTestThreadSpawner("fake:coordinator");
    const lock = new Int32Array(
      spawner.get_object().worker_background_ref_object.lock,
    );
    Atomics.store(lock, 0, 4);
    FakeWorker.instances[0]!.emitError("crashed inside termination batch");
    try {
      const error = await captureDestroyError(
        withTimeout(spawner.async_destroy(), "coordinator-owned recovery", 250),
      );
      assert.strictEqual(
        error.code,
        WorkerDestroyFailureCode.CoordinatorRuntime,
      );
      assert.strictEqual(Atomics.load(lock, 0), 0);
    } finally {
      Atomics.store(lock, 0, 0);
      wakeWorkerCommandActivity(lock);
    }
  });

  test("owner synchronous done_notify never blocks on the termination gate", () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const spawner = createTestThreadSpawner("fake:coordinator");
    const lock = new Int32Array(
      spawner.get_object().worker_background_ref_object.lock,
    );
    Atomics.store(lock, 0, 4);
    const wait = Atomics.wait;
    Atomics.wait = () => {
      throw new Error("owner must not block");
    };
    try {
      spawner.done_notify(37);
      assert.strictEqual(Atomics.load(lock, 3), RuntimeCompletion.Exit);
      assert.strictEqual(Atomics.load(lock, 4), 37);
      assert.strictEqual(Atomics.load(lock, 0), 4);
    } finally {
      Atomics.wait = wait;
      Atomics.store(lock, 0, 0);
    }
  });

  test("coordinator bootstrap failure stays rejected", async () => {
    const spawner = createTestThreadSpawner(
      new URL("./test_workers/failing_worker_background.ts", import.meta.url)
        .href,
    );

    try {
      const first = await captureDestroyError(
        withTimeout(
          spawner.wait_worker_background_worker(),
          "first bootstrap rejection",
        ),
      );
      const second = await captureDestroyError(
        withTimeout(
          spawner.wait_worker_background_worker(),
          "repeated bootstrap rejection",
        ),
      );
      assert.strictEqual(
        first.code,
        WorkerDestroyFailureCode.CoordinatorBootstrap,
      );
      assert.strictEqual(second.code, first.code);
      assert.match(
        first.cause instanceof Error ? first.cause.message : "",
        /coordinator bootstrap failed/,
      );
    } finally {
      await cleanupSpawner(spawner);
    }
  });

  test("normal and repeated destroy share finalization and reject new work", async () => {
    const spawner = createTestThreadSpawner(REAL_COORDINATOR_URL);
    try {
      await withTimeout(
        spawner.wait_worker_background_worker(),
        "coordinator readiness",
      );

      spawner.destroy();
      spawner.destroy();
      const first = spawner.async_destroy();
      const second = spawner.async_destroy();
      await withTimeout(Promise.all([first, second]), "coordinator destroy");

      assert.strictEqual(
        readLifecycle(new Int32Array(spawner.get_object().destroy_status)),
        WorkerLifecycle.Destroyed,
      );
      assert.throws(
        () => spawner.thread_spawn(0, [], [], []),
        WorkerDestroyError,
      );
    } finally {
      await cleanupSpawner(spawner);
    }
  });

  test("destroy before ready reaches Destroyed", async () => {
    const spawner = createTestThreadSpawner(REAL_COORDINATOR_URL);
    try {
      spawner.destroy();
      await withTimeout(spawner.async_destroy(), "destroy before ready");
      assert.strictEqual(
        readLifecycle(new Int32Array(spawner.get_object().destroy_status)),
        WorkerLifecycle.Destroyed,
      );
    } finally {
      await cleanupSpawner(spawner);
    }
  });

  test("owner observes handle destroy before real coordinator ready without owner destroy", async () => {
    const spawner = createTestThreadSpawner(REAL_COORDINATOR_URL);
    const internals = spawner as unknown as {
      worker_background_worker?: Worker;
    };
    const coordinator = internals.worker_background_worker!;
    const terminate = coordinator.terminate.bind(coordinator);
    let terminations = 0;
    coordinator.terminate = () => {
      terminations += 1;
      terminate();
    };
    const ready = spawner.wait_worker_background_worker().then(
      () => ({ resolved: true, error: undefined }),
      (error: unknown) => ({ resolved: false, error }),
    );
    const handle = spawner.create_destroyer();
    try {
      handle.destroy();
      await withTimeout(handle.async_destroy(), "handle destroy completion");
      const result = await withTimeout(ready, "owner ready settlement", 250);
      assert.strictEqual(result.resolved, false);
      assert.ok(result.error instanceof WorkerDestroyError);
      assert.strictEqual(result.error.code, WorkerDestroyFailureCode.Protocol);
      await waitFor(
        () => internals.worker_background_worker === undefined,
        "owner releases coordinator",
      );
      assert.strictEqual(terminations, 1);
      await handle.async_destroy();
      assert.strictEqual(terminations, 1);
      assert.throws(
        () => spawner.check_worker_background_worker(),
        WorkerDestroyError,
      );
    } finally {
      handle.destroy();
      await withTimeout(handle.async_destroy(), "handle test cleanup").catch(
        () => undefined,
      );
      if (terminations === 0) terminate();
    }
  });

  test("handle destroy keeps the generated URL until coordinator bootstrap settles", async () => {
    installFakeWorker();
    const revoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
      revoke(url);
    };
    const spawner = new ThreadSpawner("unused", []);
    const handle = spawner.create_destroyer();
    const ready = spawner
      .wait_worker_background_worker()
      .catch(() => undefined);
    try {
      handle.destroy();
      await withTimeout(ready, "owner readiness rejection");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(revoked, []);

      FakeWorker.instances[0]?.emitMessage("ready");
      assert.deepStrictEqual(revoked, [FakeWorker.instances[0]?.url]);
    } finally {
      markDestroyed(new Int32Array(spawner.get_object().destroy_status));
      await handle.async_destroy();
      await spawner.async_destroy();
      URL.revokeObjectURL = revoke;
      revoke(String(FakeWorker.instances[0]?.url));
    }
  });

  test("handle destroy before ready succeeds with the default generated coordinator", async () => {
    const spawner = new ThreadSpawner("unused", []);
    const internals = spawner as unknown as {
      worker_background_worker?: Worker;
    };
    const handle = spawner.create_destroyer();
    const ready = spawner
      .wait_worker_background_worker()
      .catch(() => undefined);
    try {
      handle.destroy();
      await withTimeout(
        handle.async_destroy(),
        "generated coordinator destroy",
      );
      await withTimeout(ready, "generated coordinator readiness settlement");
      await waitFor(
        () => internals.worker_background_worker === undefined,
        "generated coordinator owner cleanup",
      );
      assert.strictEqual(
        readLifecycle(new Int32Array(spawner.get_object().destroy_status)),
        WorkerLifecycle.Destroyed,
      );
    } finally {
      await cleanupSpawner(spawner);
    }
  });

  test("synchronous coordinator postMessage failure rejects readiness", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = () => {
      throw new Error("postMessage failed");
    };
    const spawner = createTestThreadSpawner("fake:coordinator");

    const error = await captureDestroyError(
      spawner.wait_worker_background_worker(),
    );
    assert.strictEqual(
      error.code,
      WorkerDestroyFailureCode.CoordinatorBootstrap,
    );
    assert.strictEqual(FakeWorker.instances[0]?.terminateCount, 1);
  });

  test("invalid ready message is a bootstrap failure", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage({ msg: "ready" });
    const spawner = createTestThreadSpawner("fake:coordinator");

    const error = await captureDestroyError(
      spawner.wait_worker_background_worker(),
    );
    assert.strictEqual(
      error.code,
      WorkerDestroyFailureCode.CoordinatorBootstrap,
    );
  });

  test("coordinator error after ready is a runtime failure", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const spawner = createTestThreadSpawner("fake:coordinator");
    await spawner.wait_worker_background_worker();

    FakeWorker.instances[0]?.emitError("runtime failed");

    const error = await captureDestroyError(spawner.async_destroy());
    assert.strictEqual(error.code, WorkerDestroyFailureCode.CoordinatorRuntime);
  });

  test("coordinator failure settles a runtime waiter with its stable failure", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const spawner = createTestThreadSpawner("fake:coordinator");
    await spawner.wait_worker_background_worker();
    const completion = new Int32Array(
      spawner.get_object().worker_background_ref_object.lock,
      12,
      3,
    );
    const runtimeWait = withTimeout(
      spawner.async_wait_done_or_error(),
      "coordinator failure runtime completion",
      250,
    );

    FakeWorker.instances[0]?.emitError("runtime failed with waiter");

    const [destroyError, runtimeError] = await Promise.all([
      captureDestroyError(spawner.async_destroy()),
      captureDestroyError(runtimeWait),
    ]);
    assert.strictEqual(
      destroyError.code,
      WorkerDestroyFailureCode.CoordinatorRuntime,
    );
    assert.strictEqual(runtimeError.code, destroyError.code);
    assert.strictEqual(
      Atomics.load(completion, 0),
      RuntimeCompletion.Cancelled,
    );
  });

  test("coordinator failure preserves an existing runtime terminal result", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const spawner = createTestThreadSpawner("fake:coordinator");
    await spawner.wait_worker_background_worker();
    const completion = new Int32Array(
      spawner.get_object().worker_background_ref_object.lock,
      12,
      3,
    );
    spawner.done_notify(37);
    const runtimeResult = spawner.async_wait_done_or_error();

    FakeWorker.instances[0]?.emitError("runtime failed after completion");

    const destroyError = await captureDestroyError(spawner.async_destroy());
    assert.strictEqual(
      destroyError.code,
      WorkerDestroyFailureCode.CoordinatorRuntime,
    );
    assert.strictEqual(await runtimeResult, 37);
    assert.strictEqual(Atomics.load(completion, 0), RuntimeCompletion.Exit);
    assert.strictEqual(Atomics.load(completion, 1), 37);
  });

  test("crashed coordinator leaves Completing intact but rejects its runtime waiter", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const spawner = createTestThreadSpawner("fake:coordinator");
    const reference = spawner.get_object().worker_background_ref_object;
    const completion = new Int32Array(reference.lock, 12, 3);
    Atomics.store(completion, 0, RuntimeCompletion.Completing);
    const waiting = captureDestroyError(
      withTimeout(
        spawner.async_wait_done_or_error(),
        "Completing coordinator failure",
        250,
      ),
    );
    FakeWorker.instances[0]!.emitError("publisher crashed");
    const error = await waiting;
    assert.strictEqual(error.code, WorkerDestroyFailureCode.CoordinatorRuntime);
    assert.strictEqual(
      Atomics.load(completion, 0),
      RuntimeCompletion.Completing,
    );
  });

  test("coordinator errors remain fatal after destroy starts", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const spawner = createTestThreadSpawner("fake:coordinator");
    await spawner.wait_worker_background_worker();

    spawner.destroy();
    FakeWorker.instances[0]?.emitError("failed during teardown");

    const error = await captureDestroyError(spawner.async_destroy());
    assert.strictEqual(error.code, WorkerDestroyFailureCode.CoordinatorRuntime);
  });

  test("genuine teardown detaches and terminates the coordinator once", async () => {
    const spawner = createTestThreadSpawner(REAL_COORDINATOR_URL);
    try {
      await withTimeout(
        spawner.wait_worker_background_worker(),
        "coordinator readiness",
      );
      const coordinator = (
        spawner as unknown as { worker_background_worker?: Worker }
      ).worker_background_worker;
      assert.ok(coordinator !== undefined);
      const terminate = coordinator.terminate.bind(coordinator);
      let terminateCount = 0;
      coordinator.terminate = () => {
        assert.strictEqual(coordinator.onmessage, null);
        assert.strictEqual(coordinator.onerror, null);
        assert.strictEqual(coordinator.onmessageerror, null);
        terminateCount += 1;
        terminate();
      };

      spawner.destroy();
      await Promise.all([spawner.async_destroy(), spawner.async_destroy()]);

      assert.strictEqual(
        readLifecycle(new Int32Array(spawner.get_object().destroy_status)),
        WorkerLifecycle.Destroyed,
      );
      assert.strictEqual(terminateCount, 1);
    } finally {
      await cleanupSpawner(spawner);
    }
  });

  test("bootstrap failure acknowledges a command published before ready", async () => {
    installFakeWorker();
    const spawner = createTestThreadSpawner("fake:coordinator");
    const internals = spawner as unknown as {
      worker_background_ref: WorkerBackgroundRef;
      worker_background_ref_object: { lock: SharedArrayBuffer };
    };
    const operation = internals.worker_background_ref.async_start_on_thread(
      "fake:child",
      { type: "module" },
      {},
    );
    const lockView = new Int32Array(
      internals.worker_background_ref_object.lock,
    );
    await waitFor(
      () => Atomics.load(lockView, 1) === 0,
      "pre-ready command publication",
    );

    FakeWorker.instances[0]?.emitError("bootstrap failed with pending command");

    await assert.rejects(
      withTimeout(operation, "pre-ready command acknowledgement"),
      /Destroyed/,
    );
    const readinessError = await captureDestroyError(
      spawner.wait_worker_background_worker(),
    );
    assert.strictEqual(
      readinessError.code,
      WorkerDestroyFailureCode.CoordinatorBootstrap,
    );
    assert.strictEqual(Atomics.load(lockView, 2), 0);
  });

  test("coordinator failure recovers a claimed command and settles its caller", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const spawner = createTestThreadSpawner("fake:coordinator");
    await spawner.wait_worker_background_worker();
    const internals = spawner as unknown as {
      worker_background_ref: WorkerBackgroundRef;
      worker_background_ref_object: WorkerBackgroundRefObject;
    };
    const reference = internals.worker_background_ref_object;
    const allocator = AllocatorUseArrayBuffer.init_self(reference.allocator);
    const allocatorView = new Int32Array(allocator.share_arrays_memory);
    const lockView = new Int32Array(reference.lock);
    const signatureView = new Int32Array(reference.signature_input);
    const operation = internals.worker_background_ref.async_start_on_thread(
      "fake:child",
      { type: "module" },
      {},
    );
    await waitFor(
      () => Atomics.load(lockView, 1) === WorkerCommandState.Published,
      "claimed command publication",
    );
    Atomics.store(lockView, 1, WorkerCommandState.Claimed);
    allocator.take_memory(
      Atomics.load(signatureView, 1),
      Atomics.load(signatureView, 2),
    );
    allocator.take_memory(
      Atomics.load(signatureView, 4),
      Atomics.load(signatureView, 5),
    );

    try {
      FakeWorker.instances[0]?.emitError("failed with claimed command");

      await assert.rejects(
        withTimeout(operation, "claimed command recovery", 250),
        /Destroyed/,
      );
      const failure = await captureDestroyError(spawner.async_destroy());
      assert.strictEqual(
        failure.code,
        WorkerDestroyFailureCode.CoordinatorRuntime,
      );
      assert.strictEqual(Atomics.load(lockView, 2), 0);
      assert.strictEqual(Atomics.load(lockView, 0), 0);
      assert.strictEqual(Atomics.load(allocatorView, 1), 0);
      assert.strictEqual(FakeWorker.instances[0]?.terminateCount, 1);
    } finally {
      Atomics.store(lockView, 1, WorkerCommandState.Idle);
      Atomics.store(lockView, 2, 0);
      wakeWorkerCommandActivity(lockView);
      Atomics.notify(lockView, 2);
      await operation.catch(() => undefined);
    }
  });

  test("synchronous operations do not require coordinator readiness", () => {
    installFakeWorker();
    const spawner = createTestThreadSpawner("fake:coordinator");
    const internals = spawner as unknown as {
      worker_background_ref: WorkerBackgroundRef;
      worker_background_ref_object: WorkerBackgroundRefObject;
    };
    const allocator = AllocatorUseArrayBuffer.init_self(
      internals.worker_background_ref_object.allocator,
    );
    const signatureView = new Int32Array(
      internals.worker_background_ref_object.signature_input,
    );
    const refInternals = internals.worker_background_ref as unknown as {
      block_wait_base_func: () => void;
      call_base_func: () => void;
    };
    refInternals.call_base_func = () => {
      const requestView = createWorkerRequestView(
        allocator.share_arrays_memory,
        Atomics.load(signatureView, 6),
        Atomics.load(signatureView, 7),
      );
      allocator.take_memory(
        Atomics.load(signatureView, 1),
        Atomics.load(signatureView, 2),
      );
      allocator.take_memory(
        Atomics.load(signatureView, 4),
        Atomics.load(signatureView, 5),
      );
      completeWorkerRequest(
        requestView,
        WorkerRequestState.Ready,
        WorkerRequestFailure.None,
        41,
        new Int32Array(spawner.get_object().destroy_status),
      );
    };
    refInternals.block_wait_base_func = () => undefined;

    assert.strictEqual(spawner.thread_spawn(0, [], [], []), 41);
  });

  test("non-owner signatures retain requester plumbing", () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const owner = createTestThreadSpawner("fake:coordinator");
    const attached = ThreadSpawner.init_self(owner.get_object());

    assert.strictEqual(owner.owns_worker_background_worker, true);
    assert.strictEqual(attached.owns_worker_background_worker, false);
    assert.ok(attached.create_destroyer(17) instanceof DestroyerHandle);
  });
});

describe("WASIFarmAnimal destroy lifecycle", () => {
  for (const failed of [false, true]) {
    test(`Animal caches ${failed ? "failed" : "successful"} real spawner destroy across concurrent and later calls`, async () => {
      const spawner = createTestThreadSpawner(
        failed
          ? new URL(
              "./test_workers/failing_worker_background.ts",
              import.meta.url,
            ).href
          : REAL_COORDINATOR_URL,
      );
      const animal = createAnimalWithSpawner(spawner);
      try {
        if (failed)
          await captureDestroyError(
            withTimeout(
              spawner.wait_worker_background_worker(),
              "real bootstrap failure",
            ),
          );
        else
          await withTimeout(
            spawner.wait_worker_background_worker(),
            "real bootstrap ready",
          );
        const first = animal.async_destroy();
        const concurrent = animal.async_destroy();
        if (failed) {
          const errors = await Promise.all([
            captureDestroyError(first),
            captureDestroyError(concurrent),
          ]);
          const later = await captureDestroyError(animal.async_destroy());
          assert.strictEqual(
            later.code,
            WorkerDestroyFailureCode.CoordinatorBootstrap,
          );
          for (const error of errors)
            assert.strictEqual(error.code, later.code);
        } else {
          await withTimeout(
            Promise.all([first, concurrent]),
            "Animal successful destroy",
          );
          await animal.async_destroy();
        }
        assert.strictEqual(
          (animal as unknown as { thread_spawner?: ThreadSpawner })
            .thread_spawner,
          undefined,
        );
      } finally {
        await cleanupSpawner(spawner);
      }
    });
  }

  test("public destroy handles and async destroy join owner finalization", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const spawner = createTestThreadSpawner("fake:coordinator");
    await spawner.wait_worker_background_worker();
    const animal = createAnimalWithSpawner(spawner, 7);
    const handle = animal.init_destroyer(
      spawner.create_destroyer().get_object(),
    );
    assert.ok(handle instanceof DestroyerHandle);

    animal.destroy();
    const completion: Promise<void> = animal.async_destroy();
    assert.ok(completion instanceof Promise);
    const internals = animal as unknown as {
      fd_map: Array<[number, number]>;
      id_in_wasi_farm_ref: number[];
      inst?: unknown;
      thread_spawner?: ThreadSpawner;
      wasi_farm_refs: unknown[];
    };
    assert.strictEqual(internals.thread_spawner, spawner);

    const destroyView = new Int32Array(spawner.get_object().destroy_status);
    markDestroyed(destroyView);
    await completion;
    assert.strictEqual(internals.thread_spawner, undefined);
    assert.strictEqual(internals.inst, undefined);
    assert.deepStrictEqual(internals.wasi_farm_refs, []);
    assert.deepStrictEqual(internals.id_in_wasi_farm_ref, []);
    assert.deepStrictEqual(internals.fd_map, []);
  });

  test("owner IDs stay unbound while managed handles bind their assigned ID", () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const owner = createTestThreadSpawner("fake:coordinator");
    const attached = ThreadSpawner.init_self(owner.get_object());

    assert.strictEqual(
      (
        owner.create_destroyer(17) as unknown as {
          requester_animal_id?: number;
        }
      ).requester_animal_id,
      undefined,
    );
    assert.strictEqual(
      (
        attached.create_destroyer(17) as unknown as {
          requester_animal_id?: number;
        }
      ).requester_animal_id,
      17,
    );

    const rootAnimal = createAnimalWithSpawner(owner, 9);
    const managedAnimal = createAnimalWithSpawner(attached, 23);
    const object = owner.create_destroyer().get_object();
    assert.strictEqual(
      (
        rootAnimal.init_destroyer(object) as unknown as {
          requester_animal_id?: number;
        }
      ).requester_animal_id,
      undefined,
    );
    assert.strictEqual(
      (
        managedAnimal.init_destroyer(object) as unknown as {
          requester_animal_id?: number;
        }
      ).requester_animal_id,
      23,
    );
  });

  test("a transferred destroy handle remains usable after a Worker task", async () => {
    const spawner = createTestThreadSpawner(REAL_COORDINATOR_URL);
    const worker = new Worker(
      new URL("./test_workers/destroy_handle_worker.ts", import.meta.url),
      { type: "module" },
    );
    try {
      await withTimeout(
        spawner.wait_worker_background_worker(),
        "coordinator readiness",
      );
      const used = new Promise<void>((resolve, reject) => {
        worker.onmessage = (event) => {
          if (event.data === "destroyed") resolve();
        };
        worker.onerror = reject;
      });
      worker.postMessage(spawner.create_destroyer().get_object());

      await withTimeout(used, "delayed transferred handle");
      await withTimeout(spawner.async_destroy(), "transferred destroy");
      assert.strictEqual(
        readLifecycle(new Int32Array(spawner.get_object().destroy_status)),
        WorkerLifecycle.Destroyed,
      );
    } finally {
      worker.terminate();
      await cleanupSpawner(spawner);
    }
  });

  test("real coordinator accepts an assigned-ID noop child and destroys cleanly", async () => {
    const spawner = createTestThreadSpawner(REAL_COORDINATOR_URL);
    try {
      await withTimeout(
        spawner.wait_worker_background_worker(),
        "real coordinator readiness",
      );
      const workerId = spawner.thread_spawn(0, [], [], []);
      assert.ok(workerId > 0);
      await withTimeout(spawner.async_destroy(), "real child destroy");
      assert.strictEqual(
        readLifecycle(new Int32Array(spawner.get_object().destroy_status)),
        WorkerLifecycle.Destroyed,
      );
    } finally {
      await cleanupSpawner(spawner);
    }
  });

  test("real coordinator reports a staged pre-ready child failure", async () => {
    const spawner = createTestThreadSpawner(
      REAL_COORDINATOR_URL,
      new URL("./test_workers/startup_failure_worker.ts", import.meta.url).href,
    );
    try {
      await withTimeout(
        spawner.wait_worker_background_worker(),
        "failure coordinator readiness",
      );
      assert.throws(
        () => spawner.thread_spawn(0, [], [], []),
        /AnimalConstruction/,
      );
      await withTimeout(spawner.async_destroy(), "failure child destroy");
    } finally {
      await cleanupSpawner(spawner);
    }
  });

  test("managed async destroy resolves at Drained before scheduled Closing", async () => {
    installFakeWorker();
    let closeCount = 0;
    Object.defineProperty(globalThis, "close", {
      configurable: true,
      value: () => {
        closeCount += 1;
      },
    });
    const { background, destroyView, lockView, reference } =
      createBackgroundHarness();
    const requester = new FakeWorker("fake:requester");
    const record: TestWorkerRecord = {
      animal_id: 23,
      retired: false,
      worker: requester as unknown as Worker,
      worker_id: 1,
    };
    const internals = getBackgroundInternals(background);
    internals.workers = [undefined, record];
    internals.pending_animal_workers.set(23, record);
    internals.worker_animals.set(1, 23);
    internals.register_handlers(record, false);
    const animal = createManagedAnimal(reference, 23);

    const completion = animal.async_destroy();
    await completion;
    assert.strictEqual(
      Atomics.load(destroyView, DESTROY_REQUESTER_STATUS),
      RequesterStatus.RequesterDrained,
    );
    assert.strictEqual(readRequesterAnimalId(destroyView), 23);
    await waitFor(
      () =>
        Atomics.load(destroyView, DESTROY_REQUESTER_STATUS) ===
        RequesterStatus.Closing,
      "scheduled requester close",
    );
    await withTimeout(waitForDestroyTerminal(destroyView), "managed teardown");
    assert.ok(closeCount >= 1);
    assert.strictEqual(requester.terminateCount, 1);
    wakeWorkerCommandActivity(lockView);
  });

  test("start workers publish assigned ready before entering the start function", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    const owner = createTestThreadSpawner("fake:coordinator");
    await owner.wait_worker_background_worker();
    const messages: Array<{ animal_id?: number; msg?: string }> = [];
    Object.defineProperty(globalThis, "postMessage", {
      configurable: true,
      value: (message: { animal_id?: number; msg?: string }) => {
        messages.push(message);
      },
    });

    const animalPrototype = WASIFarmAnimal.prototype as unknown as {
      mapping_fds: () => void;
    };
    const mappingFds = animalPrototype.mapping_fds;
    animalPrototype.mapping_fds = function mappingTestFds(this: {
      fd_map: Array<[number, number]>;
    }): void {
      this.fd_map = [];
    };
    try {
      await thread_spawn_on_worker(
        {
          animal_id: 29,
          args: [],
          env: [],
          fd_map: [],
          sl_object: owner.get_object(),
          start_arg: 0,
          this_is_start: true,
          this_is_thread_spawn: true,
          thread_spawn_wasm: {} as WebAssembly.Module,
          worker_background_ref:
            owner.get_object().worker_background_ref_object,
        },
        async () =>
          ({
            exports: {
              memory: new WebAssembly.Memory({ initial: 1 }),
              _start: () => {
                assert.deepStrictEqual(messages[0], {
                  animal_id: 29,
                  msg: "ready",
                });
              },
            },
          }) as unknown as WebAssembly.Instance,
      );
    } finally {
      animalPrototype.mapping_fds = mappingFds;
    }

    assert.deepStrictEqual(messages, [
      { animal_id: 29, msg: "ready" },
      { animal_id: 29, msg: "done" },
    ]);
  });

  for (const thisIsStart of [false, true]) {
    for (const failure of [
      { name: "constructor", stage: "animal-construction" },
      { name: "async callback", stage: "animal-construction" },
      { name: "instantiate", stage: "wasm-instantiation" },
    ] as const) {
      test(`${thisIsStart ? "start" : "ordinary"} ${failure.name} failure emits one staged terminal error`, async () => {
        installFakeWorker();
        FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
        const owner = createTestThreadSpawner("fake:coordinator");
        await owner.wait_worker_background_worker();
        const messages: Array<{
          animal_id?: number;
          error?: unknown;
          msg?: string;
          stage?: string;
        }> = [];
        Object.defineProperty(globalThis, "postMessage", {
          configurable: true,
          value: (message: (typeof messages)[number]) => messages.push(message),
        });
        const animalPrototype = WASIFarmAnimal.prototype as unknown as {
          mapping_fds: () => void;
        };
        const mappingFds = animalPrototype.mapping_fds;
        animalPrototype.mapping_fds =
          failure.name === "constructor"
            ? () => {
                throw new Error("constructor failed");
              }
            : function mappingTestFds(this: {
                fd_map: Array<[number, number]>;
              }): void {
                this.fd_map = [];
              };
        let callbackCalls = 0;
        let instantiateCalls = 0;
        try {
          const result = await thread_spawn_on_worker(
            {
              animal_id: 29,
              args: [],
              env: [],
              fd_map: [],
              sl_object: owner.get_object(),
              start_arg: 0,
              this_is_start: thisIsStart,
              this_is_thread_spawn: true,
              thread_spawn_wasm: {} as WebAssembly.Module,
              worker_background_ref:
                owner.get_object().worker_background_ref_object,
            },
            async () => {
              instantiateCalls += 1;
              throw new Error("instantiate failed");
            },
            async () => {
              callbackCalls += 1;
              await Promise.resolve();
              if (failure.name === "async callback") {
                throw new Error("callback failed");
              }
            },
          );
          assert.strictEqual(result, undefined);
        } finally {
          animalPrototype.mapping_fds = mappingFds;
        }

        assert.strictEqual(
          callbackCalls,
          failure.name === "constructor" ? 0 : 1,
        );
        assert.strictEqual(
          instantiateCalls,
          failure.name === "instantiate" ? 1 : 0,
        );
        assert.strictEqual(messages.length, 1);
        assert.deepStrictEqual(
          {
            animal_id: messages[0]?.animal_id,
            msg: messages[0]?.msg,
            stage: messages[0]?.stage,
          },
          { animal_id: 29, msg: "error", stage: failure.stage },
        );
        assert.ok(messages[0]?.error instanceof Error);
      });
    }
  }
});

describe("coordinator Animal registries", () => {
  for (const opcode of [1, 2] as const) {
    for (const completed of [false, true]) {
      test(`kill ready ${opcode === 2 ? "start" : "child"} preserves runtime scope (${completed ? "terminal" : "live"})`, async () => {
        installFakeWorker();
        const harness = createBackgroundHarness();
        const target = createAnimalWorker(harness, opcode);
        const sibling = createAnimalWorker(harness);
        target.worker.emitMessage({
          msg: "ready",
          animal_id: target.bootstrap.animal_id,
        });
        sibling.worker.emitMessage({
          msg: "ready",
          animal_id: sibling.bootstrap.animal_id,
        });
        target.releaseRequest();
        sibling.releaseRequest();
        const ref = WorkerBackgroundRef.init_self(harness.reference);
        if (completed) ref.done_notify(29);
        const waiting = ref.async_wait_done_or_error().then(
          (value) => value,
          (error: unknown) => error,
        );
        try {
          getBackgroundInternals(harness.background).kill_animal(
            target.bootstrap.animal_id!,
          );
          await waitFor(
            () => target.worker.terminateCount === 1,
            "target retirement",
          );
          assert.strictEqual(
            Atomics.load(harness.lockView, 3),
            completed
              ? RuntimeCompletion.Exit
              : opcode === 2
                ? RuntimeCompletion.Cancelled
                : RuntimeCompletion.Waiting,
          );
          if (completed) assert.strictEqual(await waiting, 29);
          else if (opcode === 2)
            assert.ok(
              (await withTimeout(
                waiting,
                "killed start runtime waiter",
              )) instanceof WorkerDestroyError,
            );
          assert.strictEqual(
            readLifecycle(harness.destroyView),
            WorkerLifecycle.Running,
          );
          assert.strictEqual(target.worker.terminateCount, 1);
          assert.strictEqual(sibling.worker.terminateCount, 0);
          assert.strictEqual(
            getBackgroundInternals(harness.background).animal_workers.size,
            1,
          );
        } finally {
          beginDestroy(harness.destroyView);
          wakeWorkerCommandActivity(harness.lockView);
          await withTimeout(
            waitForDestroyTerminal(harness.destroyView),
            "kill test cleanup",
          );
          await waiting;
        }
      });
    }
  }

  test("allocates both ID boundaries and reuses a retired ID", () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const internals = getBackgroundInternals(harness.background);
    assert.strictEqual(internals.allocate_animal_id(), 0);
    internals.next_animal_id = 2 ** 30 - 2;
    assert.strictEqual(internals.allocate_animal_id(), 2 ** 30 - 2);
    assert.throws(
      () => internals.allocate_animal_id(),
      new RangeError("no Animal IDs are available"),
    );
    internals.free_animal_ids.push(0);
    assert.strictEqual(internals.allocate_animal_id(), 0);
  });

  test("pending IDs are distinct and out-of-order ready promotes by record", () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const internals = getBackgroundInternals(harness.background);
    const first = createAnimalWorker(harness);
    const second = createAnimalWorker(harness);
    try {
      assert.deepStrictEqual(
        [first.bootstrap.animal_id, second.bootstrap.animal_id],
        [0, 1],
      );
      assert.strictEqual(internals.pending_animal_workers.size, 2);
      assert.strictEqual(internals.animal_workers.size, 0);

      second.worker.emitMessage({ msg: "ready", animal_id: 1 });
      first.worker.emitMessage({ msg: "ready", animal_id: 0 });

      assert.strictEqual(
        Atomics.load(first.requestView, WORKER_REQUEST_STATE),
        WorkerRequestState.Ready,
      );
      assert.strictEqual(
        Atomics.load(second.requestView, WORKER_REQUEST_STATE),
        WorkerRequestState.Ready,
      );
      assert.strictEqual(internals.animal_workers.get(0)?.worker, first.worker);
      assert.strictEqual(
        internals.animal_workers.get(1)?.worker,
        second.worker,
      );
      assert.strictEqual(internals.pending_animal_workers.size, 0);
    } finally {
      first.releaseRequest();
      second.releaseRequest();
    }
  });

  test("individual kill is selective, idempotent, and reuses the released ID", async () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const internals = getBackgroundInternals(harness.background);
    const first = createAnimalWorker(harness);
    const second = createAnimalWorker(harness);
    try {
      first.worker.emitMessage({ msg: "ready", animal_id: 0 });
      second.worker.emitMessage({ msg: "ready", animal_id: 1 });

      internals.kill_animal(0);
      internals.kill_animal(0);
      await waitFor(
        () => first.worker.terminateCount === 1,
        "selective retirement",
      );

      assert.strictEqual(first.worker.terminateCount, 1);
      assert.strictEqual(second.worker.terminateCount, 0);
      assert.strictEqual(internals.animal_workers.has(0), false);
      assert.strictEqual(
        internals.animal_workers.get(1)?.worker,
        second.worker,
      );
      assert.strictEqual(internals.allocate_animal_id(), 0);
    } finally {
      first.releaseRequest();
      second.releaseRequest();
    }
  });

  test("unknown and pending IDs are no-ops for individual kill", () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const internals = getBackgroundInternals(harness.background);
    const pending = createAnimalWorker(harness);
    try {
      internals.kill_animal(0);
      internals.kill_animal(999);
      assert.strictEqual(pending.worker.terminateCount, 0);
      assert.strictEqual(
        internals.pending_animal_workers.get(0)?.worker,
        pending.worker,
      );
    } finally {
      pending.releaseRequest();
    }
  });

  test("mismatched, stale, and duplicate ready cannot corrupt a reused ID", async () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const internals = getBackgroundInternals(harness.background);
    const first = createAnimalWorker(harness);
    const second = createAnimalWorker(harness);
    const staleHandler = first.worker.onmessage;
    let replacement: ReturnType<typeof createAnimalWorker> | undefined;
    try {
      first.worker.emitMessage({ msg: "ready", animal_id: 1 });
      await waitFor(
        () => first.worker.terminateCount === 1,
        "mismatched retirement",
      );
      assert.strictEqual(first.worker.terminateCount, 1);
      assert.strictEqual(
        internals.pending_animal_workers.get(1)?.worker,
        second.worker,
      );

      replacement = createAnimalWorker(harness);
      assert.strictEqual(replacement.bootstrap.animal_id, 0);
      staleHandler?.({
        data: { msg: "ready", animal_id: 0 },
      } as MessageEvent);
      assert.strictEqual(
        internals.pending_animal_workers.get(0)?.worker,
        replacement.worker,
      );
      assert.strictEqual(internals.free_animal_ids.includes(0), false);

      second.worker.emitMessage({ msg: "ready", animal_id: 1 });
      replacement.worker.emitMessage({ msg: "ready", animal_id: 0 });
      replacement.worker.emitMessage({ msg: "ready", animal_id: 0 });
      await waitFor(
        () => replacement!.worker.terminateCount === 1,
        "duplicate retirement",
      );
      assert.strictEqual(replacement.worker.terminateCount, 1);
      assert.strictEqual(
        internals.animal_workers.get(1)?.worker,
        second.worker,
      );
    } finally {
      first.releaseRequest();
      second.releaseRequest();
      replacement?.releaseRequest();
    }
  });

  test("constructor and postMessage failures release their reservations", async () => {
    installFakeWorker();
    {
      const harness = createBackgroundHarness();
      const internals = getBackgroundInternals(harness.background);
      const command = prepareWorkerCommand(harness, 1);
      FakeWorker.constructorError = new Error("constructor failed");
      internals.create_worker(harness.signatureView);
      FakeWorker.constructorError = undefined;
      await waitFor(
        () => internals.free_animal_ids.length === 1,
        "constructor retirement",
      );
      assert.strictEqual(
        Atomics.load(command.requestView, WORKER_REQUEST_STATE),
        WorkerRequestState.Failed,
      );
      assert.deepStrictEqual(internals.free_animal_ids, [0]);
      assert.strictEqual(internals.pending_animal_workers.size, 0);
      command.releaseRequest();
    }
    {
      const harness = createBackgroundHarness();
      const internals = getBackgroundInternals(harness.background);
      const command = prepareWorkerCommand(harness, 1);
      FakeWorker.onPostMessage = () => {
        throw new Error("postMessage failed");
      };
      internals.create_worker(harness.signatureView);
      FakeWorker.onPostMessage = undefined;
      await waitFor(
        () => internals.free_animal_ids.length === 1,
        "postMessage retirement",
      );
      assert.strictEqual(
        Atomics.load(command.requestView, WORKER_REQUEST_STATE),
        WorkerRequestState.Failed,
      );
      assert.deepStrictEqual(internals.free_animal_ids, [0]);
      assert.strictEqual(internals.pending_animal_workers.size, 0);
      command.releaseRequest();
    }
  });

  test("done, error, and exit retire and release each sender once", async () => {
    installFakeWorker();
    for (const message of [
      { msg: "done", animal_id: 0 },
      { msg: "error", animal_id: 0, error: new Error("failed") },
      { msg: "exit", animal_id: 0, code: 9 },
    ]) {
      const harness = createBackgroundHarness();
      const internals = getBackgroundInternals(harness.background);
      const animal = createAnimalWorker(harness);
      try {
        animal.worker.emitMessage({ msg: "ready", animal_id: 0 });
        const terminalHandler = animal.worker.onmessage;
        animal.worker.emitMessage(message);
        terminalHandler?.({ data: message } as MessageEvent);
        await waitFor(
          () => animal.worker.terminateCount === 1,
          "terminal retirement",
        );
        assert.strictEqual(animal.worker.terminateCount, 1);
        assert.deepStrictEqual(internals.free_animal_ids, [0]);
      } finally {
        animal.releaseRequest();
      }
    }
  });

  test("start worker stays pending until ready and uses common kill retirement", async () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const internals = getBackgroundInternals(harness.background);
    const start = createAnimalWorker(harness, 2);
    try {
      assert.strictEqual(start.bootstrap.animal_id, 0);
      assert.strictEqual(
        Atomics.load(start.requestView, WORKER_REQUEST_STATE),
        WorkerRequestState.Pending,
      );
      assert.strictEqual(
        internals.pending_animal_workers.get(0)?.worker,
        start.worker,
      );

      start.worker.emitMessage({ msg: "ready", animal_id: 0 });
      assert.strictEqual(
        Atomics.load(start.requestView, WORKER_REQUEST_STATE),
        WorkerRequestState.Ready,
      );
      assert.strictEqual(internals.animal_workers.get(0)?.worker, start.worker);
      internals.kill_animal(0);
      await waitFor(
        () => start.worker.terminateCount === 1,
        "start retirement",
      );
      assert.strictEqual(start.worker.terminateCount, 1);
      assert.strictEqual(internals.start_worker, undefined);
      assert.deepStrictEqual(internals.free_animal_ids, [0]);
    } finally {
      start.releaseRequest();
    }
  });

  test("a concurrent second start fails without overwriting the first", () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const internals = getBackgroundInternals(harness.background);
    const first = createAnimalWorker(harness, 2);
    const second = prepareWorkerCommand(harness, 2);
    try {
      internals.create_start_worker(harness.signatureView);
      assert.strictEqual(FakeWorker.instances.length, 1);
      assert.strictEqual(
        Atomics.load(second.requestView, WORKER_REQUEST_STATE),
        WorkerRequestState.Failed,
      );
      assert.strictEqual(
        Atomics.load(second.requestView, WORKER_REQUEST_FAILURE),
        WorkerRequestFailure.Protocol,
      );
      assert.strictEqual(internals.start_worker?.worker, first.worker);
      assert.strictEqual(
        internals.pending_animal_workers.get(0)?.worker,
        first.worker,
      );
      assert.strictEqual(internals.next_animal_id, 1);

      first.worker.emitMessage({ msg: "ready", animal_id: 0 });
      assert.strictEqual(
        Atomics.load(first.requestView, WORKER_REQUEST_STATE),
        WorkerRequestState.Ready,
      );
      assert.strictEqual(internals.animal_workers.get(0)?.worker, first.worker);
    } finally {
      first.releaseRequest();
      second.releaseRequest();
    }
  });

  test("staged pre-ready errors fail and retire only the captured ordinary or start record", async () => {
    for (const opcode of [1, 2] as const) {
      for (const [stage, expectedFailure] of [
        ["animal-construction", WorkerRequestFailure.AnimalConstruction],
        ["wasm-instantiation", WorkerRequestFailure.WasmInstantiation],
      ] as const) {
        installFakeWorker();
        const harness = createBackgroundHarness();
        const internals = getBackgroundInternals(harness.background);
        const survivor = createAnimalWorker(harness);
        survivor.worker.emitMessage({ msg: "ready", animal_id: 0 });
        const target = createAnimalWorker(harness, opcode);
        const terminalHandler = target.worker.onmessage;
        try {
          const terminal = {
            msg: "error",
            animal_id: 1,
            error: new Error(`${stage} failed`),
            stage,
          };
          target.worker.emitMessage(terminal);
          terminalHandler?.({ data: terminal } as MessageEvent);
          await waitFor(
            () => target.worker.terminateCount === 1,
            "staged retirement",
          );

          assert.strictEqual(
            Atomics.load(target.requestView, WORKER_REQUEST_STATE),
            WorkerRequestState.Failed,
          );
          assert.strictEqual(
            Atomics.load(target.requestView, WORKER_REQUEST_FAILURE),
            expectedFailure,
          );
          assert.strictEqual(target.worker.terminateCount, 1);
          assert.strictEqual(survivor.worker.terminateCount, 0);
          assert.strictEqual(
            internals.animal_workers.get(0)?.worker,
            survivor.worker,
          );
          assert.strictEqual(internals.pending_animal_workers.has(1), false);
          assert.deepStrictEqual(internals.free_animal_ids, [1]);
        } finally {
          survivor.releaseRequest();
          target.releaseRequest();
        }
      }
    }
  });

  test("teardown captures pending, live, start, and pending requester records", async () => {
    installFakeWorker();
    const { background, destroyView, lockView } = createBackgroundHarness();
    const internals = getBackgroundInternals(background);
    const makeRecord = (
      animalId: number,
      workerId: number,
    ): TestWorkerRecord => ({
      animal_id: animalId,
      retired: false,
      worker: new FakeWorker(`fake:${animalId}`) as unknown as Worker,
      worker_id: workerId,
    });
    const live = makeRecord(0, 1);
    const requester = makeRecord(1, 2);
    const pending = makeRecord(2, 3);
    const start = makeRecord(3, 0);
    internals.workers = [undefined, live, requester, pending];
    internals.start_worker = start;
    internals.animal_workers.set(0, live);
    internals.pending_animal_workers.set(1, requester);
    internals.pending_animal_workers.set(2, pending);
    internals.pending_animal_workers.set(3, start);
    for (const record of [live, requester, pending, start]) {
      internals.worker_animals.set(record.worker_id, record.animal_id);
      internals.register_handlers(record, record === start);
    }

    beginDestroy(destroyView, 1);
    wakeWorkerCommandActivity(lockView);
    await waitFor(
      () =>
        Atomics.load(destroyView, DESTROY_REQUESTER_STATUS) ===
        RequesterStatus.RequesterDrained,
      "pending requester drained",
    );
    assert.strictEqual(
      (live.worker as unknown as FakeWorker).terminateCount,
      1,
    );
    assert.strictEqual(
      (pending.worker as unknown as FakeWorker).terminateCount,
      1,
    );
    assert.strictEqual(
      (start.worker as unknown as FakeWorker).terminateCount,
      1,
    );
    assert.strictEqual(
      (requester.worker as unknown as FakeWorker).terminateCount,
      0,
    );
    (requester.worker as unknown as FakeWorker).emitMessage({
      msg: "exit",
      animal_id: 1,
      code: 1,
    });
    await withTimeout(
      waitForDestroyTerminal(destroyView),
      "pending requester close",
    );
    assert.strictEqual(
      (requester.worker as unknown as FakeWorker).terminateCount,
      1,
    );
    assert.deepStrictEqual(
      [...internals.free_animal_ids].sort((a, b) => a - b),
      [0, 1, 2, 3],
    );
  });
});

describe("WorkerBackground teardown races", () => {
  test("native error from a pending retirement is suppressed before returning", async () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const child = createAnimalWorker(harness);
    child.worker.emitMessage({
      msg: "ready",
      animal_id: child.bootstrap.animal_id,
    });
    child.releaseRequest();
    const caller = WorkerBackgroundRef.init_self(
      harness.reference,
    ) as unknown as {
      block_lock_base_func(): void;
      release_base_func(): void;
    };
    caller.block_lock_base_func();
    let suppressed = false;
    try {
      child.worker.emitMessage({
        msg: "done",
        animal_id: child.bootstrap.animal_id,
      });
      assert.strictEqual(child.worker.terminateCount, 0);
      assert.ok(child.worker.onerror);
      child.worker.onerror({
        message: "late error after accepted completion",
        preventDefault: () => {
          suppressed = true;
        },
      } as unknown as ErrorEvent);
      assert.strictEqual(suppressed, true);
      assert.strictEqual(
        readLifecycle(harness.destroyView),
        WorkerLifecycle.Running,
      );
    } finally {
      caller.release_base_func();
      beginDestroy(harness.destroyView);
      wakeWorkerCommandActivity(harness.lockView);
      await withTimeout(
        waitForDestroyTerminal(harness.destroyView),
        "late error cleanup",
      );
    }
    assert.strictEqual(child.worker.terminateCount, 1);
  });

  test("native failure drains a caller prepared before failure and published on a later task", async () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const child = createAnimalWorker(harness);
    child.worker.emitMessage({
      msg: "ready",
      animal_id: child.bootstrap.animal_id,
    });
    child.releaseRequest();
    const command = prepareWorkerCommand(harness, 1);
    const { lockView, destroyView, allocator } = harness;
    let closes = 0;
    globalThis.close = () => {
      closes += 1;
    };
    // The caller passed Running and owns Preparing, but has not published yet.
    assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Running);
    Atomics.store(lockView, 0, 1);
    Atomics.store(lockView, 1, WorkerCommandState.Preparing);
    wakeWorkerCommandActivity(lockView);
    child.worker.emitError("native failure during caller preparation");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const beforePublication = { lifecycle: readLifecycle(destroyView), closes };
    Atomics.store(lockView, 2, 1);
    Atomics.store(lockView, 1, WorkerCommandState.Published);
    wakeWorkerCommandActivity(lockView);
    try {
      await waitFor(
        () => Atomics.load(lockView, 2) === 0,
        "cancelled command ACK",
      );
      assert.strictEqual(
        readLifecycle(destroyView),
        WorkerLifecycle.Destroying,
      );
      assert.strictEqual(closes, 0);
      assert.strictEqual(
        Atomics.load(command.requestView, 0),
        WorkerRequestState.Cancelled,
      );
      assert.strictEqual(
        Atomics.load(new Int32Array(allocator.share_arrays_memory), 1),
        1,
      );
      command.releaseRequest();
      Atomics.store(lockView, 0, 0);
      wakeWorkerCommandActivity(lockView);
      await captureDestroyError(
        withTimeout(waitForDestroyTerminal(destroyView), "quiescent failure"),
      );
      assert.deepStrictEqual(beforePublication, {
        lifecycle: WorkerLifecycle.Destroying,
        closes: 0,
      });
      assert.strictEqual(Atomics.load(lockView, 0), 0);
      assert.strictEqual(
        Atomics.load(new Int32Array(allocator.share_arrays_memory), 1),
        0,
      );
      assert.strictEqual(closes, 1);
    } finally {
      Atomics.store(lockView, 0, 0);
      wakeWorkerCommandActivity(lockView);
    }
  });

  test("matching pending requester late ready remains retained until Closing", async () => {
    installFakeWorker();
    const harness = createBackgroundHarness();
    const requester = createAnimalWorker(harness);
    try {
      beginDestroy(harness.destroyView, 0);
      wakeWorkerCommandActivity(harness.lockView);
      await waitFor(
        () =>
          Atomics.load(harness.destroyView, DESTROY_REQUESTER_STATUS) ===
          RequesterStatus.RequesterDrained,
        "late-ready requester drained",
      );
      assert.strictEqual(
        Atomics.load(requester.requestView, WORKER_REQUEST_STATE),
        WorkerRequestState.Cancelled,
      );
      requester.worker.emitMessage({ msg: "ready", animal_id: 0 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(
        Atomics.load(harness.destroyView, DESTROY_REQUESTER_STATUS),
        RequesterStatus.RequesterDrained,
      );
      assert.strictEqual(requester.worker.terminateCount, 0);

      markRequesterClosing(harness.destroyView);
      await withTimeout(
        waitForDestroyTerminal(harness.destroyView),
        "late-ready close",
      );
      assert.strictEqual(requester.worker.terminateCount, 1);
    } finally {
      requester.releaseRequest();
    }
  });

  for (const message of [{ msg: "ready", animal_id: 24 }, { msg: "ready" }]) {
    test(`${message.animal_id === undefined ? "malformed" : "mismatched"} pending requester late ready closes without deadline wait`, async () => {
      installFakeWorker();
      const harness = createBackgroundHarness();
      const requester = createAnimalWorker(harness);
      try {
        beginDestroy(harness.destroyView, 0);
        wakeWorkerCommandActivity(harness.lockView);
        await waitFor(
          () =>
            Atomics.load(harness.destroyView, DESTROY_REQUESTER_STATUS) ===
            RequesterStatus.RequesterDrained,
          "invalid late-ready requester drained",
        );
        requester.worker.emitMessage(message);
        await withTimeout(
          waitForDestroyTerminal(harness.destroyView),
          "invalid late-ready close",
          250,
        );
        assert.strictEqual(
          Atomics.load(harness.destroyView, DESTROY_REQUESTER_STATUS),
          RequesterStatus.Closing,
        );
        assert.strictEqual(requester.worker.terminateCount, 1);
      } finally {
        requester.releaseRequest();
      }
    });
  }

  test("acknowledged command reaches terminal after only mutex release", async () => {
    installFakeWorker();
    const destroyStatus = createDestroyStatus();
    const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
    const workerRef = WorkerBackgroundRef.init_self(reference);
    const destroyView = new Int32Array(destroyStatus);
    const lockView = new Int32Array(reference.lock);
    const internals = workerRef as unknown as {
      release_base_func: () => void;
    };
    Atomics.store(lockView, 0, 1);
    Atomics.store(lockView, 1, WorkerCommandState.Idle);
    Atomics.store(lockView, 2, 0);
    beginDestroy(destroyView);
    new WorkerBackground(
      {},
      destroyStatus,
      reference.lock,
      AllocatorUseArrayBuffer.init_self(reference.allocator),
      reference.signature_input,
    );
    await Promise.resolve();
    await Promise.resolve();

    internals.release_base_func.call(workerRef);
    try {
      await withTimeout(
        waitForDestroyTerminal(destroyView),
        "mutex release activity",
        250,
      );
      assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Destroyed);
    } finally {
      wakeWorkerCommandActivity(lockView);
    }
  });

  test("command preparation closes the mutex-to-publication teardown gap", () => {
    const destroyStatus = createDestroyStatus();
    const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
    const workerRef = WorkerBackgroundRef.init_self(reference);
    const allocatorView = new Int32Array(
      reference.allocator.share_arrays_memory,
    );
    const lockView = new Int32Array(reference.lock);
    const destroyView = new Int32Array(destroyStatus);
    const internals = workerRef as unknown as {
      block_lock_base_func: () => void;
    };
    const acquire = internals.block_lock_base_func.bind(workerRef);
    let stateAfterAcquisition = -1;
    internals.block_lock_base_func = () => {
      acquire();
      stateAfterAcquisition = Atomics.load(lockView, 1);
      beginDestroy(destroyView);
    };

    assert.throws(
      () => workerRef.new_worker("fake:child", { type: "module" }, {}),
      WorkerDestroyError,
    );
    assert.strictEqual(stateAfterAcquisition, 2);
    assert.strictEqual(Atomics.load(lockView, 1), 1);
    assert.strictEqual(Atomics.load(lockView, 0), 0);
    assert.strictEqual(Atomics.load(allocatorView, 1), 0);
  });

  test("teardown waits for command preparation to finish", async () => {
    installFakeWorker();
    const destroyStatus = createDestroyStatus();
    const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
    const destroyView = new Int32Array(destroyStatus);
    const lockView = new Int32Array(reference.lock);
    Atomics.store(lockView, 1, 2);
    beginDestroy(destroyView);

    new WorkerBackground(
      {},
      destroyStatus,
      reference.lock,
      AllocatorUseArrayBuffer.init_self(reference.allocator),
      reference.signature_input,
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Destroying);

    Atomics.store(lockView, 1, 1);
    wakeWorkerCommandActivity(lockView);
    await withTimeout(
      waitForDestroyTerminal(destroyView),
      "preparation-aware teardown",
    );
    assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Destroyed);
  });

  test("teardown waits when mutex acquisition precedes Preparing", async () => {
    installFakeWorker();
    const destroyStatus = createDestroyStatus();
    const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
    const destroyView = new Int32Array(destroyStatus);
    const lockView = new Int32Array(reference.lock);
    Atomics.store(lockView, 0, 1);
    beginDestroy(destroyView);

    new WorkerBackground(
      {},
      destroyStatus,
      reference.lock,
      AllocatorUseArrayBuffer.init_self(reference.allocator),
      reference.signature_input,
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Destroying);

    Atomics.store(lockView, 1, 2);
    wakeWorkerCommandActivity(lockView);
    Atomics.store(lockView, 1, 1);
    Atomics.store(lockView, 0, 0);
    wakeWorkerCommandActivity(lockView);
    await withTimeout(
      waitForDestroyTerminal(destroyView),
      "mutex-acquisition-aware teardown",
    );
    assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Destroyed);
  });

  test("omitted worker post data is published as valid JSON", () => {
    const destroyStatus = createDestroyStatus();
    const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
    const allocator = AllocatorUseArrayBuffer.init_self(reference.allocator);
    const workerRef = WorkerBackgroundRef.init_self(reference);
    const signatureView = new Int32Array(reference.signature_input);
    const internals = workerRef as unknown as {
      block_wait_base_func: () => void;
      call_base_func: () => void;
    };
    let objectText: string | undefined;
    internals.call_base_func = () => {
      const requestView = createWorkerRequestView(
        allocator.share_arrays_memory,
        Atomics.load(signatureView, 6),
        Atomics.load(signatureView, 7),
      );
      allocator.take_memory(
        Atomics.load(signatureView, 1),
        Atomics.load(signatureView, 2),
      );
      objectText = new TextDecoder().decode(
        allocator.take_memory(
          Atomics.load(signatureView, 4),
          Atomics.load(signatureView, 5),
        ),
      );
      completeWorkerRequest(
        requestView,
        WorkerRequestState.Ready,
        WorkerRequestFailure.None,
        9,
        new Int32Array(destroyStatus),
      );
    };
    internals.block_wait_base_func = () => undefined;

    assert.strictEqual(
      workerRef.new_worker("fake:child", { type: "module" }).get_id(),
      9,
    );
    assert.strictEqual(objectText, "{}");
  });

  test("mutation commands reject once lifecycle teardown starts", () => {
    const destroyStatus = createDestroyStatus();
    const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
    const workerRef = WorkerBackgroundRef.init_self(reference);
    const signatureView = new Int32Array(reference.signature_input);
    const internals = workerRef as unknown as {
      block_wait_base_func: () => void;
      call_base_func: () => void;
    };
    let publications = 0;
    internals.call_base_func = () => {
      publications += 1;
    };
    internals.block_wait_base_func = () => undefined;
    beginDestroy(new Int32Array(destroyStatus));

    assert.throws(() => workerRef.terminate_all_workers(), WorkerDestroyError);
    assert.throws(() => workerRef.kill_animal(3), WorkerDestroyError);
    assert.strictEqual(publications, 0);
    assert.strictEqual(Atomics.load(signatureView, 0), 0);
  });

  test("destroy wake does not replay a stale opcode", async () => {
    installFakeWorker();
    const { destroyView, lockView, signatureView } = createBackgroundHarness();
    Atomics.store(signatureView, 0, 1);

    beginDestroy(destroyView);
    wakeWorkerCommandActivity(lockView);
    await withTimeout(
      waitForDestroyTerminal(destroyView),
      "stale wake teardown",
    );

    assert.strictEqual(FakeWorker.instances.length, 0);
    assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Destroyed);
  });

  test("destroy acknowledges and cancels an in-flight published command", async () => {
    installFakeWorker();
    const destroyStatus = createDestroyStatus();
    const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
    const allocator = AllocatorUseArrayBuffer.init_self(reference.allocator);
    const destroyView = new Int32Array(destroyStatus);
    const lockView = new Int32Array(reference.lock);
    const signatureView = new Int32Array(reference.signature_input);
    const address = new SharedArrayBuffer(8);
    const [requestAllocationPtr, requestAllocationLen] = allocator.block_write(
      new Uint8Array(WORKER_REQUEST_BYTES + 3),
      address,
      0,
    );
    const requestPtr = (requestAllocationPtr + 3) & ~3;
    const requestView = new Int32Array(
      allocator.share_arrays_memory,
      requestPtr,
      WORKER_REQUEST_BYTES / 4,
    );
    const [urlPtr, urlLen] = allocator.block_write(
      new TextEncoder().encode("fake:child"),
      address,
      0,
    );
    const [objectPtr, objectLen] = allocator.block_write(
      new TextEncoder().encode("{}"),
      address,
      0,
    );
    Atomics.store(signatureView, 0, 1);
    Atomics.store(signatureView, 1, urlPtr);
    Atomics.store(signatureView, 2, urlLen);
    Atomics.store(signatureView, 4, objectPtr);
    Atomics.store(signatureView, 5, objectLen);
    Atomics.store(signatureView, 6, requestPtr);
    Atomics.store(signatureView, 7, WORKER_REQUEST_BYTES);
    Atomics.store(lockView, 2, 1);
    Atomics.store(lockView, 1, 0);
    const epoch = Atomics.load(destroyView, DESTROY_WAKE_EPOCH);

    beginDestroy(destroyView);
    new WorkerBackground(
      {},
      destroyStatus,
      reference.lock,
      allocator,
      reference.signature_input,
    );
    await withTimeout(
      waitForDestroyTerminal(destroyView),
      "in-flight teardown",
    );

    assert.strictEqual(
      Atomics.load(requestView, WORKER_REQUEST_STATE),
      WorkerRequestState.Cancelled,
    );
    assert.strictEqual(
      Atomics.load(requestView, WORKER_REQUEST_FAILURE),
      WorkerRequestFailure.Destroyed,
    );
    assert.strictEqual(Atomics.load(lockView, 2), 0);
    assert.strictEqual(
      Atomics.load(destroyView, DESTROY_WAKE_EPOCH),
      epoch + 4,
    );
    assert.strictEqual(
      Atomics.load(new Int32Array(allocator.share_arrays_memory), 1),
      1,
    );
    allocator.free(requestAllocationPtr, requestAllocationLen);
    assert.strictEqual(
      Atomics.load(new Int32Array(allocator.share_arrays_memory), 1),
      0,
    );
  });

  test("runtime terminal results are not overwritten by cancellation", async () => {
    installFakeWorker();
    for (const terminal of [
      RuntimeCompletion.Error,
      RuntimeCompletion.Exit,
      RuntimeCompletion.Done,
    ]) {
      const { destroyView, lockView } = createBackgroundHarness();
      Atomics.store(lockView, 3, terminal);

      beginDestroy(destroyView);
      wakeWorkerCommandActivity(lockView);
      await withTimeout(
        waitForDestroyTerminal(destroyView),
        "runtime preservation",
      );

      assert.strictEqual(Atomics.load(lockView, 3), terminal);
    }
  });

  test("allocator lock abandonment cannot strand runtime failure teardown", async () => {
    installFakeWorker();
    const { allocator, background, destroyView, lockView } =
      createBackgroundHarness();
    const allocatorView = new Int32Array(allocator.share_arrays_memory);
    const internals = background as unknown as {
      fail_runtime: (error: unknown) => void;
    };
    Atomics.store(allocatorView, 0, 1);

    try {
      internals.fail_runtime(new Error("allocator owner exited"));
      const failure = await captureDestroyError(
        withTimeout(
          waitForDestroyTerminal(destroyView),
          "allocator-independent runtime failure",
          250,
        ),
      );

      assert.strictEqual(
        failure.code,
        WorkerDestroyFailureCode.CoordinatorRuntime,
      );
      assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Failed);
      assert.strictEqual(
        Atomics.load(lockView, 3),
        RuntimeCompletion.Cancelled,
      );
    } finally {
      Atomics.store(allocatorView, 0, 0);
      Atomics.notify(allocatorView, 0);
    }
  });

  for (const condition of ["held lock", "exhaustion", "available"] as const) {
    test(`standard runtime error uses bounded publication with ${condition}`, async () => {
      installFakeWorker();
      const harness = createBackgroundHarness();
      const child = createAnimalWorker(harness);
      child.worker.emitMessage({
        msg: "ready",
        animal_id: child.bootstrap.animal_id,
      });
      child.releaseRequest();
      const { allocator, destroyView, lockView, reference } = harness;
      const allocatorView = new Int32Array(allocator.share_arrays_memory);
      let fullAllocation: [number, number] | undefined;
      if (condition === "held lock") Atomics.store(allocatorView, 0, 1);
      if (condition === "exhaustion") {
        fullAllocation = allocator.block_write(
          new Uint8Array(allocator.share_arrays_memory.byteLength - 12),
          new SharedArrayBuffer(8),
          0,
        );
      }
      try {
        child.worker.emitMessage({
          msg: "error",
          animal_id: child.bootstrap.animal_id,
          error: new Error("ordinary detailed runtime error"),
        });
        if (condition === "available") {
          await assert.rejects(
            withTimeout(
              WorkerBackgroundRef.init_self(
                reference,
              ).async_wait_done_or_error(),
              "detailed error",
              250,
            ),
            /ordinary detailed runtime error/,
          );
          assert.strictEqual(
            readLifecycle(destroyView),
            WorkerLifecycle.Running,
          );
        } else {
          const error = await captureDestroyError(
            withTimeout(
              waitForDestroyTerminal(destroyView),
              "bounded error fallback",
              250,
            ),
          );
          assert.strictEqual(
            error.code,
            WorkerDestroyFailureCode.CoordinatorRuntime,
          );
          assert.strictEqual(
            Atomics.load(lockView, 3),
            RuntimeCompletion.Cancelled,
          );
        }
        assert.strictEqual(child.worker.terminateCount, 1);
        assert.strictEqual(
          Atomics.load(allocatorView, 0),
          condition === "held lock" ? 1 : 0,
        );
        assert.strictEqual(
          Atomics.load(allocatorView, 1),
          fullAllocation ? 1 : 0,
        );
      } finally {
        Atomics.store(allocatorView, 0, 0);
        Atomics.notify(allocatorView, 0);
        if (fullAllocation) allocator.free(...fullAllocation);
        beginDestroy(destroyView);
        wakeWorkerCommandActivity(lockView);
        await withTimeout(
          waitForDestroyTerminal(destroyView),
          "error test cleanup",
        ).catch(() => undefined);
      }
    });
  }

  test("runtime error allocation is freed by its consumer", async () => {
    const destroyStatus = createDestroyStatus();
    const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
    const allocator = AllocatorUseArrayBuffer.init_self(reference.allocator);
    const address = new SharedArrayBuffer(8);
    const serialized = JSON.stringify({
      name: "Error",
      message: "runtime failed",
      stack: "Error: runtime failed",
    });
    const [ptr, len] = await allocator.async_write(
      new TextEncoder().encode(serialized),
      address,
      0,
    );
    const completion = new Int32Array(reference.lock, 12, 3);
    Atomics.store(completion, 1, ptr);
    Atomics.store(completion, 2, len);
    Atomics.store(completion, 0, RuntimeCompletion.Error);
    const workerRef = WorkerBackgroundRef.init_self(reference);

    await assert.rejects(
      workerRef.async_wait_done_or_error(),
      /runtime failed/,
    );

    assert.strictEqual(
      Atomics.load(new Int32Array(allocator.share_arrays_memory), 1),
      0,
    );
  });

  test("runtime error payload has exactly one consuming waiter", async () => {
    const destroyStatus = createDestroyStatus();
    const reference = WorkerBackgroundRefObjectConstructor(destroyStatus);
    const allocator = AllocatorUseArrayBuffer.init_self(reference.allocator);
    const address = new SharedArrayBuffer(8);
    const [ptr, len] = await allocator.async_write(
      new TextEncoder().encode(
        JSON.stringify({
          name: "Error",
          message: "single-owner runtime failure",
          stack: "Error: single-owner runtime failure",
        }),
      ),
      address,
      0,
    );
    const completion = new Int32Array(reference.lock, 12, 3);
    Atomics.store(completion, 1, ptr);
    Atomics.store(completion, 2, len);
    Atomics.store(completion, 0, RuntimeCompletion.Error);
    const first = WorkerBackgroundRef.init_self(reference);
    const second = WorkerBackgroundRef.init_self(reference);

    const results = await Promise.allSettled([
      first.async_wait_done_or_error(),
      second.async_wait_done_or_error(),
    ]);

    assert.deepStrictEqual(
      results.map((result) => result.status),
      ["rejected", "rejected"],
    );
    assert.strictEqual(
      Atomics.load(new Int32Array(allocator.share_arrays_memory), 1),
      0,
    );
  });

  test("retained requester Closing wakes teardown before its deadline", async () => {
    installFakeWorker();
    const { background, destroyView, lockView } = createBackgroundHarness();
    const requester = new FakeWorker("fake:requester");
    const record: TestWorkerRecord = {
      animal_id: 23,
      retired: false,
      worker: requester as unknown as Worker,
      worker_id: 1,
    };
    const internals = background as unknown as {
      animal_workers: Map<number, TestWorkerRecord>;
      cancel_timeout: (timeout: ReturnType<typeof setTimeout>) => void;
      register_handlers: (record: TestWorkerRecord, isStart: boolean) => void;
      schedule_timeout: typeof setTimeout;
      workers: Array<TestWorkerRecord | undefined>;
    };
    internals.workers = [undefined, record];
    internals.animal_workers.set(23, record);
    internals.register_handlers(record, false);
    let deadlineFired = false;
    let deadlineCancelled = false;
    internals.schedule_timeout = ((callback: () => void) => {
      return setTimeout(() => {
        deadlineFired = true;
        callback();
      }, 1_000);
    }) as typeof setTimeout;
    internals.cancel_timeout = (timeout) => {
      deadlineCancelled = true;
      clearTimeout(timeout);
    };

    beginDestroy(destroyView, 23);
    wakeWorkerCommandActivity(lockView);
    await waitFor(
      () =>
        Atomics.load(destroyView, DESTROY_REQUESTER_STATUS) ===
        RequesterStatus.RequesterDrained,
      "requester drained",
    );
    const epoch = Atomics.load(destroyView, DESTROY_WAKE_EPOCH);
    requester.emitMessage({ msg: "exit", animal_id: 24, code: 1 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(
      Atomics.load(destroyView, DESTROY_REQUESTER_STATUS),
      RequesterStatus.RequesterDrained,
    );
    requester.emitMessage({ msg: "exit", animal_id: 23, code: 1 });
    await withTimeout(waitForDestroyTerminal(destroyView), "requester closing");

    assert.strictEqual(
      Atomics.load(destroyView, DESTROY_REQUESTER_STATUS),
      RequesterStatus.Closing,
    );
    assert.ok(Atomics.load(destroyView, DESTROY_WAKE_EPOCH) > epoch);
    assert.strictEqual(deadlineFired, false);
    assert.strictEqual(deadlineCancelled, true);
    assert.strictEqual(requester.terminateCount, 1);
  });

  test("request failure is published before stable coordinator failure", async () => {
    installFakeWorker();
    const { background, destroyView, lockView } = createBackgroundHarness();
    const request = new Int32Array(new SharedArrayBuffer(WORKER_REQUEST_BYTES));
    const worker = new FakeWorker("fake:invalid");
    const record: TestWorkerRecord = {
      animal_id: 1,
      retired: false,
      worker: worker as unknown as Worker,
      worker_id: 1,
      request_view: request,
    };
    const internals = background as unknown as {
      register_handlers: (record: TestWorkerRecord, isStart: boolean) => void;
      workers: Array<TestWorkerRecord | undefined>;
    };
    internals.workers = [undefined, record];
    internals.register_handlers(record, false);

    worker.emitMessage("invalid");
    await withTimeout(
      waitForDestroyTerminal(destroyView),
      "runtime failure",
    ).catch(() => undefined);

    assert.strictEqual(
      Atomics.load(request, WORKER_REQUEST_STATE),
      WorkerRequestState.Failed,
    );
    assert.strictEqual(
      Atomics.load(request, WORKER_REQUEST_FAILURE),
      WorkerRequestFailure.Protocol,
    );
    assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Failed);
    assert.strictEqual(
      Atomics.load(destroyView, DESTROY_FAILURE_CODE),
      WorkerDestroyFailureCode.CoordinatorRuntime,
    );
    assert.strictEqual(Atomics.load(lockView, 3), RuntimeCompletion.Cancelled);
  });
});
