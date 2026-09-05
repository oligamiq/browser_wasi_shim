import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import { DestroyerHandle } from "../destroyer_handle.ts";
import { AllocatorUseArrayBuffer } from "./allocator.ts";
import { ThreadSpawner } from "./thread_spawn.ts";
import { WorkerBackground } from "./worker_background/worker.ts";
import { WorkerBackgroundRef } from "./worker_background/worker_background_ref.ts";
import { WorkerBackgroundRefObjectConstructor } from "./worker_background/worker_export.ts";
import {
  beginDestroy,
  createDestroyStatus,
  DESTROY_FAILURE_CODE,
  DESTROY_REQUESTER_STATUS,
  DESTROY_WAKE_EPOCH,
  markDestroyed,
  readLifecycle,
  RequesterStatus,
  waitForDestroyTerminal,
  WorkerDestroyError,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "./worker_lifecycle.ts";
import {
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

function createTestThreadSpawner(backgroundUrl: string): ThreadSpawner {
  return new ThreadSpawner(
    new URL("./test_workers/noop_worker.ts", import.meta.url).href,
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
  worker: Worker;
  worker_id: number;
  request_view?: Int32Array;
};

class FakeWorker {
  static instances: FakeWorker[] = [];
  static onPostMessage:
    | ((worker: FakeWorker, value: unknown) => void)
    | undefined;
  static onTerminate: ((worker: FakeWorker) => void) | undefined;

  onmessage: WorkerMessageHandler = null;
  onmessageerror: WorkerMessageHandler = null;
  onerror: WorkerErrorHandler = null;
  terminateCount = 0;

  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(value: unknown): void {
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

function installFakeWorker(): void {
  FakeWorker.instances = [];
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
  name: "Worker" | "close",
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
  FakeWorker.instances = [];
  FakeWorker.onPostMessage = undefined;
  FakeWorker.onTerminate = undefined;
});

function createBackgroundHarness(): {
  allocator: AllocatorUseArrayBuffer;
  background: WorkerBackground<Record<string, never>>;
  destroyView: Int32Array;
  lockView: Int32Array;
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
    signatureView: new Int32Array(reference.signature_input),
  };
}

describe("ThreadSpawner coordinator ownership", () => {
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

  test("intentional coordinator termination remains Destroyed and occurs once", async () => {
    installFakeWorker();
    FakeWorker.onPostMessage = (worker) => worker.emitMessage("ready");
    FakeWorker.onTerminate = (worker) => worker.emitError("terminated");
    const spawner = createTestThreadSpawner("fake:coordinator");
    await spawner.wait_worker_background_worker();
    const destroyView = new Int32Array(spawner.get_object().destroy_status);

    spawner.destroy();
    markDestroyed(destroyView);
    await Promise.all([spawner.async_destroy(), spawner.async_destroy()]);

    assert.strictEqual(readLifecycle(destroyView), WorkerLifecycle.Destroyed);
    assert.strictEqual(FakeWorker.instances[0]?.terminateCount, 1);
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

describe("WorkerBackground teardown races", () => {
  test("destroy wake does not replay a stale opcode", async () => {
    installFakeWorker();
    const { destroyView, lockView, signatureView } = createBackgroundHarness();
    Atomics.store(signatureView, 0, 1);

    beginDestroy(destroyView);
    Atomics.notify(lockView, 1);
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
      epoch + 3,
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
      Atomics.notify(lockView, 1);
      await withTimeout(
        waitForDestroyTerminal(destroyView),
        "runtime preservation",
      );

      assert.strictEqual(Atomics.load(lockView, 3), terminal);
    }
  });

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
    const completion = new Int32Array(reference.lock, 12);
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

  test("retained requester Closing wakes teardown before its deadline", async () => {
    installFakeWorker();
    const { background, destroyView, lockView } = createBackgroundHarness();
    const requester = new FakeWorker("fake:requester");
    const record: TestWorkerRecord = {
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
    Atomics.notify(lockView, 1);
    await waitFor(
      () =>
        Atomics.load(destroyView, DESTROY_REQUESTER_STATUS) ===
        RequesterStatus.RequesterDrained,
      "requester drained",
    );
    const epoch = Atomics.load(destroyView, DESTROY_WAKE_EPOCH);
    requester.emitMessage({ msg: "exit", code: 1 });
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
    const { allocator, background, destroyView, lockView } =
      createBackgroundHarness();
    const request = new Int32Array(new SharedArrayBuffer(WORKER_REQUEST_BYTES));
    const worker = new FakeWorker("fake:invalid");
    const record: TestWorkerRecord = {
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
    assert.strictEqual(Atomics.load(lockView, 3), RuntimeCompletion.Error);
    const errorPointer = Atomics.load(lockView, 4);
    const errorLength = Atomics.load(lockView, 5);
    assert.ok(errorPointer > 0);
    allocator.free(errorPointer, errorLength);
  });
});
