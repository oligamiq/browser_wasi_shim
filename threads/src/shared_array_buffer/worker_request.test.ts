import assert from "node:assert";
import { describe, test } from "node:test";
import {
  claimRuntimeCompletion,
  completeWorkerRequest,
  createWorkerRequestView,
  finishRuntimeCompletion,
  isWorkerRequestTerminal,
  RuntimeCompletion,
  WORKER_REQUEST_BYTES,
  WORKER_REQUEST_FAILURE,
  WORKER_REQUEST_ID,
  WORKER_REQUEST_STATE,
  WorkerRequestFailure,
  WorkerRequestState,
  WorkerRequestWaitDecision,
  workerRequestWaitDecision,
} from "./worker_request.ts";
import {
  createDestroyStatus,
  DESTROY_WAKE_EPOCH,
  WorkerLifecycle,
} from "./worker_lifecycle.ts";

function createRequest(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(WORKER_REQUEST_BYTES));
}

describe("worker operation requests", () => {
  test("uses an exact three-word request block", () => {
    assert.strictEqual(WORKER_REQUEST_BYTES, 12);
    assert.strictEqual(WORKER_REQUEST_STATE, 0);
    assert.strictEqual(WORKER_REQUEST_FAILURE, 1);
    assert.strictEqual(WORKER_REQUEST_ID, 2);
  });

  test("publishes ready payload before the terminal state", () => {
    const request = createRequest();
    const destroy = new Int32Array(createDestroyStatus());

    assert.strictEqual(
      completeWorkerRequest(
        request,
        WorkerRequestState.Ready,
        WorkerRequestFailure.None,
        19,
        destroy,
      ),
      true,
    );
    assert.strictEqual(
      Atomics.load(request, WORKER_REQUEST_FAILURE),
      WorkerRequestFailure.None,
    );
    assert.strictEqual(Atomics.load(request, WORKER_REQUEST_ID), 19);
    assert.strictEqual(
      Atomics.load(request, WORKER_REQUEST_STATE),
      WorkerRequestState.Ready,
    );
  });

  test("publishes failure and cancellation payloads", () => {
    const destroy = new Int32Array(createDestroyStatus());
    const failed = createRequest();
    const cancelled = createRequest();

    assert.strictEqual(
      completeWorkerRequest(
        failed,
        WorkerRequestState.Failed,
        WorkerRequestFailure.ScriptLoad,
        7,
        destroy,
      ),
      true,
    );
    assert.deepStrictEqual(Array.from(failed), [
      WorkerRequestState.Failed,
      WorkerRequestFailure.ScriptLoad,
      7,
    ]);

    assert.strictEqual(
      completeWorkerRequest(
        cancelled,
        WorkerRequestState.Cancelled,
        WorkerRequestFailure.Destroyed,
        11,
        destroy,
      ),
      true,
    );
    assert.deepStrictEqual(Array.from(cancelled), [
      WorkerRequestState.Cancelled,
      WorkerRequestFailure.Destroyed,
      11,
    ]);
  });

  test("allows exactly one terminal publisher without payload overwrite", () => {
    const request = createRequest();
    const destroy = new Int32Array(createDestroyStatus());

    assert.strictEqual(
      completeWorkerRequest(
        request,
        WorkerRequestState.Ready,
        WorkerRequestFailure.None,
        9,
        destroy,
      ),
      true,
    );
    assert.strictEqual(
      completeWorkerRequest(
        request,
        WorkerRequestState.Cancelled,
        WorkerRequestFailure.Destroyed,
        99,
        destroy,
      ),
      false,
    );
    assert.deepStrictEqual(Array.from(request), [
      WorkerRequestState.Ready,
      WorkerRequestFailure.None,
      9,
    ]);
  });

  test("treats Completing as nonterminal and rejects another publisher", () => {
    const request = createRequest();
    const destroy = new Int32Array(createDestroyStatus());
    Atomics.store(request, WORKER_REQUEST_STATE, WorkerRequestState.Completing);

    assert.strictEqual(
      isWorkerRequestTerminal(WorkerRequestState.Completing),
      false,
    );
    assert.strictEqual(
      completeWorkerRequest(
        request,
        WorkerRequestState.Failed,
        WorkerRequestFailure.Protocol,
        4,
        destroy,
      ),
      false,
    );
    assert.deepStrictEqual(Array.from(request), [
      WorkerRequestState.Completing,
      WorkerRequestFailure.None,
      0,
    ]);
  });

  test("increments the destroy wake epoch for every accepted completion", () => {
    const request = createRequest();
    const destroy = new Int32Array(createDestroyStatus());
    const epoch = Atomics.load(destroy, DESTROY_WAKE_EPOCH);

    completeWorkerRequest(
      request,
      WorkerRequestState.Ready,
      WorkerRequestFailure.None,
      1,
      destroy,
    );

    assert.strictEqual(Atomics.load(destroy, DESTROY_WAKE_EPOCH), epoch + 1);
  });

  test("validates both views before claiming publication", () => {
    const requestBuffer = new SharedArrayBuffer(WORKER_REQUEST_BYTES + 4);
    const request = new Int32Array(requestBuffer, 0, 2);
    const destroy = new Int32Array(createDestroyStatus());

    assert.throws(
      () =>
        completeWorkerRequest(
          request,
          WorkerRequestState.Ready,
          WorkerRequestFailure.None,
          3,
          destroy,
        ),
      RangeError,
    );
    assert.strictEqual(
      new Int32Array(requestBuffer)[WORKER_REQUEST_STATE],
      WorkerRequestState.Pending,
    );
  });

  test("validates signed request metadata before creating a view", () => {
    const memory = new SharedArrayBuffer(64);

    assert.strictEqual(createWorkerRequestView(memory, 12, 12).byteOffset, 12);
    for (const pointer of [0, 4, 8]) {
      assert.throws(
        () => createWorkerRequestView(memory, pointer, 12),
        RangeError,
      );
    }
    assert.throws(() => createWorkerRequestView(memory, -4, 12), RangeError);
    assert.throws(() => createWorkerRequestView(memory, 14, 12), RangeError);
    assert.throws(() => createWorkerRequestView(memory, 16, -1), RangeError);
    assert.throws(() => createWorkerRequestView(memory, 16, 8), RangeError);
    assert.throws(() => createWorkerRequestView(memory, 56, 12), RangeError);
  });

  test("claims runtime completion before payload and preserves its terminal state", () => {
    const completion = new Int32Array(new SharedArrayBuffer(12));

    assert.strictEqual(claimRuntimeCompletion(completion), true);
    assert.strictEqual(
      Atomics.load(completion, 0),
      RuntimeCompletion.Completing,
    );
    Atomics.store(completion, 1, 27);
    finishRuntimeCompletion(completion, RuntimeCompletion.Exit);

    assert.deepStrictEqual(Array.from(completion), [
      RuntimeCompletion.Exit,
      27,
      0,
    ]);
    assert.strictEqual(claimRuntimeCompletion(completion), false);
    assert.strictEqual(Atomics.load(completion, 0), RuntimeCompletion.Exit);
  });

  test("request terminal state wins over lifecycle terminal state", () => {
    for (const requestState of [
      WorkerRequestState.Ready,
      WorkerRequestState.Failed,
      WorkerRequestState.Cancelled,
    ]) {
      assert.strictEqual(
        workerRequestWaitDecision(requestState, WorkerLifecycle.Failed),
        WorkerRequestWaitDecision.RequestTerminal,
      );
      assert.strictEqual(
        workerRequestWaitDecision(requestState, WorkerLifecycle.Destroyed),
        WorkerRequestWaitDecision.RequestTerminal,
      );
    }
  });

  test("nonterminal requests wait only while lifecycle can still be completed by the coordinator", () => {
    for (const requestState of [
      WorkerRequestState.Pending,
      WorkerRequestState.Completing,
    ]) {
      assert.strictEqual(
        workerRequestWaitDecision(requestState, WorkerLifecycle.Running),
        WorkerRequestWaitDecision.Wait,
      );
      assert.strictEqual(
        workerRequestWaitDecision(requestState, WorkerLifecycle.Destroying),
        WorkerRequestWaitDecision.Wait,
      );
      assert.strictEqual(
        workerRequestWaitDecision(requestState, WorkerLifecycle.Failed),
        WorkerRequestWaitDecision.LifecycleFailed,
      );
      assert.strictEqual(
        workerRequestWaitDecision(requestState, WorkerLifecycle.Destroyed),
        WorkerRequestWaitDecision.LifecycleDestroyed,
      );
    }
  });
});
