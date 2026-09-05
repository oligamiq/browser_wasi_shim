import {
  DESTROY_STATUS_BYTES,
  readLifecycle,
  wakeDestroyWaiters,
  WorkerLifecycle,
} from "./worker_lifecycle.ts";
import { ALLOCATOR_DATA_OFFSET } from "./allocator.ts";

export const WORKER_REQUEST_BYTES = 12;
export const WORKER_REQUEST_STATE = 0;
export const WORKER_REQUEST_FAILURE = 1;
export const WORKER_REQUEST_ID = 2;

export enum WorkerRequestState {
  Pending = 0,
  Completing = 1,
  Ready = 2,
  Failed = 3,
  Cancelled = 4,
}

export enum WorkerRequestFailure {
  None = 0,
  Destroyed = 1,
  ScriptLoad = 2,
  AnimalConstruction = 3,
  WasmInstantiation = 4,
  Protocol = 5,
}

export enum WorkerRequestWaitDecision {
  Wait,
  RequestTerminal,
  LifecycleFailed,
  LifecycleDestroyed,
}

export enum RuntimeCompletion {
  Waiting = 0,
  Error = 1,
  Exit = 2,
  Done = 3,
  Cancelled = 4,
  Completing = 5,
  ErrorConsumed = 6,
}

const RUNTIME_COMPLETION_STATE = 0;

function validateSharedView(
  view: Int32Array,
  expectedBytes: number,
  name: string,
): void {
  if (!(view.buffer instanceof SharedArrayBuffer)) {
    throw new TypeError(`${name} must use SharedArrayBuffer`);
  }
  if (view.byteLength !== expectedBytes) {
    throw new RangeError(`${name} must be exactly ${expectedBytes} bytes`);
  }
}

export function isWorkerRequestTerminal(state: number): boolean {
  return (
    state === WorkerRequestState.Ready ||
    state === WorkerRequestState.Failed ||
    state === WorkerRequestState.Cancelled
  );
}

export function workerRequestWaitDecision(
  requestState: number,
  lifecycle: WorkerLifecycle,
): WorkerRequestWaitDecision {
  if (isWorkerRequestTerminal(requestState)) {
    return WorkerRequestWaitDecision.RequestTerminal;
  }
  if (lifecycle === WorkerLifecycle.Failed) {
    return WorkerRequestWaitDecision.LifecycleFailed;
  }
  if (lifecycle === WorkerLifecycle.Destroyed) {
    return WorkerRequestWaitDecision.LifecycleDestroyed;
  }
  return WorkerRequestWaitDecision.Wait;
}

export function readWorkerRequestWaitSnapshot(
  requestView: Int32Array,
  destroyView: Int32Array,
  afterLifecycleRead?: () => void,
): {
  lifecycle: WorkerLifecycle;
  requestState: number;
  decision: WorkerRequestWaitDecision;
} {
  const lifecycle = readLifecycle(destroyView);
  afterLifecycleRead?.();
  const requestState = Atomics.load(requestView, WORKER_REQUEST_STATE);
  return {
    lifecycle,
    requestState,
    decision: workerRequestWaitDecision(requestState, lifecycle),
  };
}

export function createWorkerRequestView(
  memory: SharedArrayBuffer,
  pointer: number,
  length: number,
): Int32Array {
  if (!Number.isInteger(pointer) || pointer < ALLOCATOR_DATA_OFFSET) {
    throw new RangeError(
      "worker request pointer must be in allocator data memory",
    );
  }
  if (!Number.isInteger(length) || length !== WORKER_REQUEST_BYTES) {
    throw new RangeError(
      `worker request length must be exactly ${WORKER_REQUEST_BYTES}`,
    );
  }
  if (pointer % Int32Array.BYTES_PER_ELEMENT !== 0) {
    throw new RangeError("worker request pointer must be four-byte aligned");
  }
  if (pointer > memory.byteLength - length) {
    throw new RangeError("worker request is outside shared allocator memory");
  }
  return new Int32Array(memory, pointer, WORKER_REQUEST_BYTES / 4);
}

export function claimRuntimeCompletion(view: Int32Array): boolean {
  validateSharedView(view, WORKER_REQUEST_BYTES, "runtime completion view");
  return (
    Atomics.compareExchange(
      view,
      RUNTIME_COMPLETION_STATE,
      RuntimeCompletion.Waiting,
      RuntimeCompletion.Completing,
    ) === RuntimeCompletion.Waiting
  );
}

export function finishRuntimeCompletion(
  view: Int32Array,
  state:
    | RuntimeCompletion.Error
    | RuntimeCompletion.Exit
    | RuntimeCompletion.Done
    | RuntimeCompletion.Cancelled,
): void {
  validateSharedView(view, WORKER_REQUEST_BYTES, "runtime completion view");
  if (
    state !== RuntimeCompletion.Error &&
    state !== RuntimeCompletion.Exit &&
    state !== RuntimeCompletion.Done &&
    state !== RuntimeCompletion.Cancelled
  ) {
    throw new RangeError("runtime completion state must be terminal");
  }
  if (
    Atomics.compareExchange(
      view,
      RUNTIME_COMPLETION_STATE,
      RuntimeCompletion.Completing,
      state,
    ) !== RuntimeCompletion.Completing
  ) {
    throw new Error("runtime completion was not claimed");
  }
  Atomics.notify(view, RUNTIME_COMPLETION_STATE);
}

export function completeWorkerRequest(
  view: Int32Array,
  state:
    | WorkerRequestState.Ready
    | WorkerRequestState.Failed
    | WorkerRequestState.Cancelled,
  failure: WorkerRequestFailure,
  workerId: number,
  destroyView: Int32Array,
): boolean {
  validateSharedView(view, WORKER_REQUEST_BYTES, "worker request view");
  validateSharedView(destroyView, DESTROY_STATUS_BYTES, "destroy status view");
  if (!isWorkerRequestTerminal(state)) {
    throw new RangeError("worker request completion state must be terminal");
  }

  if (
    Atomics.compareExchange(
      view,
      WORKER_REQUEST_STATE,
      WorkerRequestState.Pending,
      WorkerRequestState.Completing,
    ) !== WorkerRequestState.Pending
  ) {
    return false;
  }

  Atomics.store(view, WORKER_REQUEST_FAILURE, failure);
  Atomics.store(view, WORKER_REQUEST_ID, workerId);
  Atomics.store(view, WORKER_REQUEST_STATE, state);
  Atomics.notify(view, WORKER_REQUEST_STATE);
  wakeDestroyWaiters(destroyView);
  return true;
}
