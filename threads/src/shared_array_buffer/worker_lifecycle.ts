export const DESTROY_STATUS_BYTES = 16;
export const DESTROY_CONTROL = 0;
export const DESTROY_REQUESTER_STATUS = 1;
export const DESTROY_FAILURE_CODE = 2;
export const DESTROY_WAKE_EPOCH = 3;

const LIFECYCLE_MASK = 0b11;
const REQUESTER_SHIFT = 2;
const MAX_ANIMAL_ID = 2 ** 30 - 2;

export enum WorkerLifecycle {
  Running = 0,
  Destroying = 1,
  Destroyed = 2,
  Failed = 3,
}

export enum RequesterStatus {
  None = 0,
  RequesterDrained = 1,
  Closing = 2,
}

export enum WorkerDestroyFailureCode {
  None = 0,
  CoordinatorBootstrap = 1,
  CoordinatorRuntime = 2,
  WorkerBootstrap = 3,
  Protocol = 4,
}

export class WorkerDestroyError extends Error {
  constructor(readonly code: WorkerDestroyFailureCode) {
    super(`worker destroy failed: ${WorkerDestroyFailureCode[code]}`);
    this.name = "WorkerDestroyError";
  }
}

export function createDestroyStatus(): SharedArrayBuffer {
  return new SharedArrayBuffer(DESTROY_STATUS_BYTES);
}

function requesterCode(animalId?: number): number {
  if (animalId === undefined) return 0;
  if (!Number.isInteger(animalId) || animalId < 0 || animalId > MAX_ANIMAL_ID) {
    throw new RangeError(`animal_id must be in 0..${MAX_ANIMAL_ID}`);
  }
  return animalId + 1;
}

function encodeControl(lifecycle: WorkerLifecycle, animalId?: number): number {
  return (requesterCode(animalId) << REQUESTER_SHIFT) | lifecycle;
}

export function readLifecycle(view: Int32Array): WorkerLifecycle {
  return Atomics.load(view, DESTROY_CONTROL) & LIFECYCLE_MASK;
}

export function readRequesterAnimalId(view: Int32Array): number | undefined {
  const code = Atomics.load(view, DESTROY_CONTROL) >>> REQUESTER_SHIFT;
  return code === 0 ? undefined : code - 1;
}

export function beginDestroy(view: Int32Array, animalId?: number): boolean {
  const control = encodeControl(WorkerLifecycle.Destroying, animalId);
  const won =
    Atomics.compareExchange(
      view,
      DESTROY_CONTROL,
      WorkerLifecycle.Running,
      control,
    ) === WorkerLifecycle.Running;
  if (won) wakeDestroyWaiters(view);
  return won;
}

export function wakeDestroyWaiters(view: Int32Array): void {
  Atomics.add(view, DESTROY_WAKE_EPOCH, 1);
  Atomics.notify(view, DESTROY_WAKE_EPOCH);
}

function finishDestroy(view: Int32Array, next: WorkerLifecycle): void {
  for (;;) {
    const control = Atomics.load(view, DESTROY_CONTROL);
    const lifecycle = control & LIFECYCLE_MASK;
    if (
      lifecycle === WorkerLifecycle.Destroyed ||
      lifecycle === WorkerLifecycle.Failed
    ) {
      return;
    }
    if (lifecycle !== WorkerLifecycle.Destroying) {
      throw new WorkerDestroyError(WorkerDestroyFailureCode.Protocol);
    }
    const replacement = (control & ~LIFECYCLE_MASK) | next;
    if (
      Atomics.compareExchange(view, DESTROY_CONTROL, control, replacement) ===
      control
    ) {
      wakeDestroyWaiters(view);
      return;
    }
  }
}

export function markDestroyed(view: Int32Array): void {
  finishDestroy(view, WorkerLifecycle.Destroyed);
}

export function markDestroyFailed(
  view: Int32Array,
  code: WorkerDestroyFailureCode,
): void {
  const lifecycle = readLifecycle(view);
  if (
    lifecycle === WorkerLifecycle.Destroyed ||
    lifecycle === WorkerLifecycle.Failed
  ) {
    return;
  }
  if (lifecycle === WorkerLifecycle.Running) {
    throw new WorkerDestroyError(WorkerDestroyFailureCode.Protocol);
  }
  Atomics.compareExchange(
    view,
    DESTROY_FAILURE_CODE,
    WorkerDestroyFailureCode.None,
    code,
  );
  finishDestroy(view, WorkerLifecycle.Failed);
}

async function waitForWake(
  view: Int32Array,
  expectedEpoch: number,
): Promise<void> {
  const { value } = Atomics.waitAsync(view, DESTROY_WAKE_EPOCH, expectedEpoch);
  const result = value instanceof Promise ? await value : value;
  if (result === "timed-out") throw new Error("atomic wait timed out");
}

export async function waitForDestroyTerminal(view: Int32Array): Promise<void> {
  for (;;) {
    const lifecycle = readLifecycle(view);
    if (lifecycle === WorkerLifecycle.Destroyed) return;
    if (lifecycle === WorkerLifecycle.Failed) {
      throw new WorkerDestroyError(
        Atomics.load(view, DESTROY_FAILURE_CODE) as WorkerDestroyFailureCode,
      );
    }
    const epoch = Atomics.load(view, DESTROY_WAKE_EPOCH);
    if (readLifecycle(view) === lifecycle) await waitForWake(view, epoch);
  }
}

export async function waitForRequesterDrained(view: Int32Array): Promise<void> {
  while (
    Atomics.load(view, DESTROY_REQUESTER_STATUS) === RequesterStatus.None
  ) {
    const lifecycle = readLifecycle(view);
    if (lifecycle === WorkerLifecycle.Failed) {
      throw new WorkerDestroyError(
        Atomics.load(view, DESTROY_FAILURE_CODE) as WorkerDestroyFailureCode,
      );
    }
    if (lifecycle === WorkerLifecycle.Destroyed) return;
    const epoch = Atomics.load(view, DESTROY_WAKE_EPOCH);
    if (
      Atomics.load(view, DESTROY_REQUESTER_STATUS) === RequesterStatus.None &&
      readLifecycle(view) === lifecycle
    ) {
      await waitForWake(view, epoch);
    }
  }
}

export function markRequesterClosing(view: Int32Array): void {
  Atomics.store(view, DESTROY_REQUESTER_STATUS, RequesterStatus.Closing);
  wakeDestroyWaiters(view);
}
