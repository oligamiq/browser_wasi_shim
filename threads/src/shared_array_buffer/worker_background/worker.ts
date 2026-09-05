//// <reference types="@better-typescript-lib/webworker" />

// A dedicated coordinator Worker creates subworkers because callers may be
// blocked in Wasm and unable to use postMessage directly.

import { AllocatorUseArrayBuffer } from "../allocator.js";
import * as Serializer from "../serialize_error.js";
import {
  beginDestroy,
  DESTROY_REQUESTER_STATUS,
  DESTROY_WAKE_EPOCH,
  markDestroyed,
  markDestroyFailed,
  markRequesterClosing,
  readLifecycle,
  readRequesterAnimalId,
  RequesterStatus,
  wakeDestroyWaiters,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "../worker_lifecycle.js";
import {
  claimRuntimeCompletion,
  completeWorkerRequest,
  createWorkerRequestView,
  finishRuntimeCompletion,
  RuntimeCompletion,
  WorkerRequestFailure,
  WorkerRequestState,
} from "../worker_request.js";
import {
  SIGNATURE_REQUEST_STATUS_LEN,
  SIGNATURE_REQUEST_STATUS_PTR,
} from "./worker_export.js";
import type { WorkerBackgroundRefObject } from "./worker_export.js";

type WorkerRecord = {
  worker: Worker;
  request_view?: Int32Array;
  worker_id: number;
};

type WorkerCommand = {
  obj: Record<string, unknown>;
  requestView: Int32Array;
  url: string;
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class WorkerBackground<T> {
  private override_object: T;
  private allocator: AllocatorUseArrayBuffer;
  private lock: SharedArrayBuffer;
  private signature_input: SharedArrayBuffer;
  private destroy_status: SharedArrayBuffer;
  private workers: Array<WorkerRecord | undefined> = [undefined];
  // @ts-expect-error retained so the coordinator loop remains strongly held.
  private listen_holder: Promise<void>;
  private start_worker?: WorkerRecord;
  private animal_workers = new Map<number, WorkerRecord>();
  private teardown_promise?: Promise<void>;
  private teardown_failure?: WorkerDestroyFailureCode;
  private teardown_error?: unknown;
  private teardown_requester?: WorkerRecord;
  private schedule_timeout: typeof setTimeout = setTimeout;
  private cancel_timeout: typeof clearTimeout = clearTimeout;

  constructor(
    override_object: T,
    destroy_status: SharedArrayBuffer,
    lock?: SharedArrayBuffer,
    allocator?: AllocatorUseArrayBuffer,
    signature_input?: SharedArrayBuffer,
  ) {
    this.override_object = override_object;
    this.destroy_status = destroy_status;
    this.lock = lock ?? new SharedArrayBuffer(24);
    const initialLockView = new Int32Array(this.lock);
    if (
      Atomics.load(initialLockView, 1) === 0 &&
      Atomics.load(initialLockView, 2) === 0
    ) {
      Atomics.store(initialLockView, 1, 1);
    }
    this.allocator =
      allocator ??
      new AllocatorUseArrayBuffer(new SharedArrayBuffer(10 * 1024));
    this.signature_input = signature_input ?? new SharedArrayBuffer(32);
    this.listen_holder = this.listen();
  }

  static init_self<T>(
    override_object: T,
    worker_background_ref_object: WorkerBackgroundRefObject,
  ): WorkerBackground<T> {
    return new WorkerBackground(
      override_object,
      worker_background_ref_object.destroy_status,
      worker_background_ref_object.lock,
      AllocatorUseArrayBuffer.init_self(worker_background_ref_object.allocator),
      worker_background_ref_object.signature_input,
    );
  }

  private assign_worker_id(): number {
    for (let i = 1; i < this.workers.length; i++) {
      if (this.workers[i] === undefined) return i;
    }
    this.workers.push(undefined);
    return this.workers.length - 1;
  }

  private ref(): WorkerBackgroundRefObject {
    return {
      allocator: this.allocator.get_object(),
      lock: this.lock,
      signature_input: this.signature_input,
      destroy_status: this.destroy_status,
    };
  }

  private remove_record(record: WorkerRecord): void {
    if (record.worker_id > 0 && this.workers[record.worker_id] === record) {
      this.workers[record.worker_id] = undefined;
    }
    if (record.worker_id === 0 && this.start_worker === record) {
      this.start_worker = undefined;
    }
    for (const [animalId, animalRecord] of this.animal_workers) {
      if (animalRecord === record) this.animal_workers.delete(animalId);
    }
  }

  private is_active_record(record: WorkerRecord): boolean {
    return record.worker_id === 0
      ? this.start_worker === record
      : this.workers[record.worker_id] === record;
  }

  private mark_inactive_requester_closing(record: WorkerRecord): boolean {
    if (this.teardown_requester !== record) return false;
    markRequesterClosing(new Int32Array(this.destroy_status));
    return true;
  }

  private detach_handlers(record: WorkerRecord): void {
    record.worker.onmessage = null;
    record.worker.onerror = null;
    record.worker.onmessageerror = null;
  }

  private terminate_registered_workers(): void {
    const records = new Set<WorkerRecord>();
    for (const record of this.workers) {
      if (record !== undefined) records.add(record);
    }
    if (this.start_worker !== undefined) records.add(this.start_worker);
    const destroyView = new Int32Array(this.destroy_status);
    for (const record of records) {
      const requestView = record.request_view;
      record.request_view = undefined;
      if (requestView !== undefined) {
        completeWorkerRequest(
          requestView,
          WorkerRequestState.Cancelled,
          WorkerRequestFailure.Destroyed,
          record.worker_id,
          destroyView,
        );
      }
      this.detach_handlers(record);
      record.worker.terminate();
    }
    this.workers = [undefined];
    this.start_worker = undefined;
    this.animal_workers.clear();
  }

  private cancel_runtime(): void {
    const completionView = new Int32Array(this.lock, 12);
    if (claimRuntimeCompletion(completionView)) {
      finishRuntimeCompletion(completionView, RuntimeCompletion.Cancelled);
    }
  }

  private teardown(): Promise<void> {
    this.teardown_promise ??= Promise.resolve().then(() =>
      this.teardown_inner(),
    );
    return this.teardown_promise;
  }

  private fail_runtime(
    error: unknown,
    code = WorkerDestroyFailureCode.CoordinatorRuntime,
  ): void {
    this.teardown_failure ??= code;
    this.teardown_error ??= error;
    beginDestroy(new Int32Array(this.destroy_status));
    Atomics.notify(new Int32Array(this.lock), 1);
    void this.teardown();
  }

  private record_teardown_error(error: unknown): void {
    this.teardown_failure ??= WorkerDestroyFailureCode.CoordinatorRuntime;
    console.error(error);
  }

  private async wait_for_requester_closing(view: Int32Array): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const closing = (async () => {
      for (;;) {
        const statusBefore = Atomics.load(view, DESTROY_REQUESTER_STATUS);
        if (statusBefore === RequesterStatus.Closing) return;
        const epoch = Atomics.load(view, DESTROY_WAKE_EPOCH);
        const statusAfter = Atomics.load(view, DESTROY_REQUESTER_STATUS);
        if (statusAfter === RequesterStatus.Closing) return;
        if (statusAfter !== statusBefore) continue;
        const { value } = Atomics.waitAsync(view, DESTROY_WAKE_EPOCH, epoch);
        const result = value instanceof Promise ? await value : value;
        if (result === "timed-out") throw new Error("atomic wait timed out");
      }
    })();
    const deadline = new Promise<void>((resolve) => {
      timeout = this.schedule_timeout(resolve, 1_000);
    });

    await Promise.race([closing, deadline]);
    if (timeout !== undefined) this.cancel_timeout(timeout);
  }

  private async teardown_inner(): Promise<void> {
    const destroyView = new Int32Array(this.destroy_status);
    const requesterId = readRequesterAnimalId(destroyView);
    const requester =
      requesterId === undefined
        ? undefined
        : this.animal_workers.get(requesterId);
    const records = new Set<WorkerRecord>();
    for (const record of this.workers) {
      if (record !== undefined) records.add(record);
    }
    if (this.start_worker !== undefined) records.add(this.start_worker);
    for (const record of this.animal_workers.values()) records.add(record);
    this.teardown_requester = requester;

    this.workers = [undefined];
    this.start_worker = undefined;
    this.animal_workers.clear();

    if (this.teardown_error !== undefined) {
      try {
        await this.publish_runtime_error(this.teardown_error);
      } catch (error) {
        this.record_teardown_error(error);
      }
    }

    for (const record of records) {
      const requestView = record.request_view;
      record.request_view = undefined;
      if (requestView !== undefined) {
        try {
          completeWorkerRequest(
            requestView,
            WorkerRequestState.Cancelled,
            WorkerRequestFailure.Destroyed,
            record.worker_id,
            destroyView,
          );
        } catch (error) {
          this.record_teardown_error(error);
        }
      }
      if (record !== requester) {
        try {
          this.detach_handlers(record);
          record.worker.terminate();
        } catch (error) {
          this.record_teardown_error(error);
        }
      }
    }

    try {
      this.cancel_runtime();
    } catch (error) {
      this.record_teardown_error(error);
    }

    if (requester !== undefined) {
      Atomics.store(
        destroyView,
        DESTROY_REQUESTER_STATUS,
        RequesterStatus.RequesterDrained,
      );
      wakeDestroyWaiters(destroyView);
      try {
        await this.wait_for_requester_closing(destroyView);
      } catch (error) {
        this.record_teardown_error(error);
      }
      try {
        this.detach_handlers(requester);
        requester.worker.terminate();
      } catch (error) {
        this.record_teardown_error(error);
      }
    }
    this.teardown_requester = undefined;

    try {
      if (this.teardown_failure === undefined) {
        markDestroyed(destroyView);
      } else {
        markDestroyFailed(destroyView, this.teardown_failure);
      }
    } catch (error) {
      this.teardown_failure ??= WorkerDestroyFailureCode.CoordinatorRuntime;
      try {
        if (readLifecycle(destroyView) === WorkerLifecycle.Running) {
          beginDestroy(destroyView);
        }
        markDestroyFailed(destroyView, this.teardown_failure);
      } catch (terminalError) {
        console.error(error, terminalError);
      }
    }
    globalThis.close();
  }

  private complete_request_ready(record: WorkerRecord): boolean {
    if (!this.is_active_record(record)) {
      record.worker.terminate();
      return false;
    }
    const requestView = record.request_view;
    record.request_view = undefined;
    if (requestView === undefined) return false;

    const destroyView = new Int32Array(this.destroy_status);
    const running = readLifecycle(destroyView) === WorkerLifecycle.Running;
    const accepted = completeWorkerRequest(
      requestView,
      running ? WorkerRequestState.Ready : WorkerRequestState.Cancelled,
      running ? WorkerRequestFailure.None : WorkerRequestFailure.Destroyed,
      record.worker_id,
      destroyView,
    );
    if (!accepted || !running) {
      this.remove_record(record);
      record.worker.terminate();
      return false;
    }
    return true;
  }

  private complete_request_failure(
    record: WorkerRecord,
    failure: WorkerRequestFailure,
  ): void {
    if (!this.is_active_record(record)) {
      record.worker.terminate();
      return;
    }
    const requestView = record.request_view;
    record.request_view = undefined;
    if (requestView !== undefined) {
      completeWorkerRequest(
        requestView,
        WorkerRequestState.Failed,
        failure,
        record.worker_id,
        new Int32Array(this.destroy_status),
      );
    }
    this.remove_record(record);
    record.worker.terminate();
  }

  private publish_runtime_exit(code: number): void {
    const completionView = new Int32Array(this.lock, 12);
    if (!claimRuntimeCompletion(completionView)) return;
    Atomics.store(completionView, 1, code);
    finishRuntimeCompletion(completionView, RuntimeCompletion.Exit);
  }

  private publish_runtime_done(): void {
    const completionView = new Int32Array(this.lock, 12);
    if (!claimRuntimeCompletion(completionView)) return;
    finishRuntimeCompletion(completionView, RuntimeCompletion.Done);
  }

  private async publish_runtime_error(value: unknown): Promise<void> {
    const completionView = new Int32Array(this.lock, 12);
    let allocation: [number, number] | undefined;
    try {
      const serialized = Serializer.serialize(asError(value));
      allocation = await this.allocator.async_write(
        new TextEncoder().encode(JSON.stringify(serialized)),
        new SharedArrayBuffer(8),
        0,
      );
      if (!claimRuntimeCompletion(completionView)) {
        this.allocator.free(allocation[0], allocation[1]);
        return;
      }
      Atomics.store(completionView, 1, allocation[0]);
      Atomics.store(completionView, 2, allocation[1]);
      finishRuntimeCompletion(completionView, RuntimeCompletion.Error);
    } catch (error) {
      if (allocation !== undefined) {
        this.allocator.free(allocation[0], allocation[1]);
      }
      console.error(error);
    }
  }

  private take_allocation(pointer: number, length: number): ArrayBuffer {
    return this.allocator.take_memory(pointer, length);
  }

  private read_command(signatureView: Int32Array): WorkerCommand {
    const requestPointer = Atomics.load(
      signatureView,
      SIGNATURE_REQUEST_STATUS_PTR,
    );
    const requestLength = Atomics.load(
      signatureView,
      SIGNATURE_REQUEST_STATUS_LEN,
    );
    let requestView: Int32Array | undefined;
    let requestError: unknown;
    try {
      requestView = createWorkerRequestView(
        this.allocator.share_arrays_memory,
        requestPointer,
        requestLength,
      );
    } catch (error) {
      requestError = error;
    }

    let urlBuffer: ArrayBuffer | undefined;
    let objectBuffer: ArrayBuffer | undefined;
    let payloadError: unknown;
    try {
      urlBuffer = this.take_allocation(
        Atomics.load(signatureView, 1),
        Atomics.load(signatureView, 2),
      );
    } catch (error) {
      payloadError = error;
    }
    try {
      objectBuffer = this.take_allocation(
        Atomics.load(signatureView, 4),
        Atomics.load(signatureView, 5),
      );
    } catch (error) {
      payloadError ??= error;
    }

    if (requestError !== undefined) throw requestError;
    if (payloadError !== undefined) {
      completeWorkerRequest(
        requestView!,
        WorkerRequestState.Failed,
        WorkerRequestFailure.Protocol,
        0,
        new Int32Array(this.destroy_status),
      );
      throw payloadError;
    }

    const url = new TextDecoder().decode(urlBuffer!);
    try {
      return {
        obj: JSON.parse(new TextDecoder().decode(objectBuffer!)) as Record<
          string,
          unknown
        >,
        requestView: requestView!,
        url,
      };
    } catch (error) {
      completeWorkerRequest(
        requestView!,
        WorkerRequestState.Failed,
        WorkerRequestFailure.Protocol,
        0,
        new Int32Array(this.destroy_status),
      );
      throw error;
    }
  }

  private cancel_published_command(signatureView: Int32Array): void {
    const opcode = Atomics.load(signatureView, 0);
    if (opcode !== 1 && opcode !== 2) return;

    let requestView: Int32Array | undefined;
    try {
      requestView = createWorkerRequestView(
        this.allocator.share_arrays_memory,
        Atomics.load(signatureView, SIGNATURE_REQUEST_STATUS_PTR),
        Atomics.load(signatureView, SIGNATURE_REQUEST_STATUS_LEN),
      );
    } catch (error) {
      this.teardown_failure ??= WorkerDestroyFailureCode.Protocol;
      console.error(error);
    }

    for (const [pointerIndex, lengthIndex] of [
      [1, 2],
      [4, 5],
    ] as const) {
      try {
        this.take_allocation(
          Atomics.load(signatureView, pointerIndex),
          Atomics.load(signatureView, lengthIndex),
        );
      } catch (error) {
        this.teardown_failure ??= WorkerDestroyFailureCode.Protocol;
        console.error(error);
      }
    }

    if (requestView !== undefined) {
      try {
        completeWorkerRequest(
          requestView,
          WorkerRequestState.Cancelled,
          WorkerRequestFailure.Destroyed,
          0,
          new Int32Array(this.destroy_status),
        );
      } catch (error) {
        this.record_teardown_error(error);
      }
    }
  }

  private acknowledge_command(lockView: Int32Array): void {
    Atomics.store(lockView, 1, 1);
    Atomics.store(lockView, 2, 0);
    Atomics.notify(lockView, 2, 1);
  }

  private register_handlers(record: WorkerRecord, isStart: boolean): void {
    record.worker.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (!this.is_active_record(record)) {
        if (this.teardown_requester === record) {
          if (
            data !== null &&
            typeof data === "object" &&
            ((data as { msg?: string }).msg === "error" ||
              (data as { msg?: string }).msg === "exit")
          ) {
            this.mark_inactive_requester_closing(record);
          }
          return;
        }
        record.worker.terminate();
        return;
      }
      if (data === null || typeof data !== "object") {
        if (record.request_view !== undefined) {
          this.complete_request_failure(record, WorkerRequestFailure.Protocol);
        }
        this.fail_runtime(new Error("invalid worker message"));
        return;
      }

      const message = data as {
        animal_id?: number;
        code?: number;
        error?: unknown;
        msg?: string;
      };
      if (message.msg === "ready") {
        if (!isStart && !this.complete_request_ready(record)) return;
        if (message.animal_id !== undefined) {
          this.animal_workers.set(message.animal_id, record);
        }
        return;
      }

      if (message.msg === "done") {
        if (record.request_view !== undefined) {
          this.complete_request_failure(record, WorkerRequestFailure.Protocol);
        } else {
          this.remove_record(record);
          record.worker.terminate();
        }
        if (isStart) {
          this.terminate_registered_workers();
          this.publish_runtime_done();
        }
        return;
      }

      if (message.msg === "error" || message.msg === "exit") {
        if (record.request_view !== undefined) {
          this.complete_request_failure(
            record,
            WorkerRequestFailure.AnimalConstruction,
          );
        }
        this.terminate_registered_workers();
        if (message.msg === "error") {
          void this.publish_runtime_error(
            message.error ?? new Error("worker error"),
          );
        } else {
          this.publish_runtime_exit(message.code ?? 1);
        }
        return;
      }

      if (record.request_view !== undefined) {
        this.complete_request_failure(record, WorkerRequestFailure.Protocol);
      }
      this.fail_runtime(new Error("unknown worker message"));
    };

    record.worker.onerror = (event) => {
      if (!this.is_active_record(record)) {
        if (this.mark_inactive_requester_closing(record)) return;
        record.worker.terminate();
        return;
      }
      event.preventDefault();
      if (record.request_view !== undefined) {
        this.complete_request_failure(record, WorkerRequestFailure.ScriptLoad);
      }
      this.fail_runtime(new Error(event.message));
    };
    record.worker.onmessageerror = () => {
      if (!this.is_active_record(record)) {
        if (this.mark_inactive_requester_closing(record)) return;
        record.worker.terminate();
        return;
      }
      if (record.request_view !== undefined) {
        this.complete_request_failure(record, WorkerRequestFailure.Protocol);
      }
      this.fail_runtime(new Error("worker message could not be decoded"));
    };
  }

  private create_worker(signatureView: Int32Array): void {
    let command: WorkerCommand;
    try {
      command = this.read_command(signatureView);
    } catch (error) {
      this.fail_runtime(error);
      return;
    }

    if (
      readLifecycle(new Int32Array(this.destroy_status)) !==
      WorkerLifecycle.Running
    ) {
      completeWorkerRequest(
        command.requestView,
        WorkerRequestState.Cancelled,
        WorkerRequestFailure.Destroyed,
        0,
        new Int32Array(this.destroy_status),
      );
      return;
    }

    let worker: Worker;
    try {
      worker = new Worker(command.url, {
        type: Atomics.load(signatureView, 3) === 1 ? "module" : "classic",
      });
    } catch (error) {
      completeWorkerRequest(
        command.requestView,
        WorkerRequestState.Failed,
        WorkerRequestFailure.ScriptLoad,
        0,
        new Int32Array(this.destroy_status),
      );
      this.fail_runtime(error);
      return;
    }

    const workerId = this.assign_worker_id();
    const record: WorkerRecord = {
      worker,
      request_view: command.requestView,
      worker_id: workerId,
    };
    this.workers[workerId] = record;
    this.register_handlers(record, false);
    try {
      worker.postMessage({
        ...this.override_object,
        ...command.obj,
        worker_id: workerId,
        worker_background_ref: this.ref(),
      });
    } catch (error) {
      this.complete_request_failure(
        record,
        WorkerRequestFailure.AnimalConstruction,
      );
      this.fail_runtime(error);
    }
  }

  private create_start_worker(signatureView: Int32Array): void {
    let command: WorkerCommand;
    try {
      command = this.read_command(signatureView);
    } catch (error) {
      this.fail_runtime(error);
      return;
    }
    if (
      readLifecycle(new Int32Array(this.destroy_status)) !==
      WorkerLifecycle.Running
    ) {
      completeWorkerRequest(
        command.requestView,
        WorkerRequestState.Cancelled,
        WorkerRequestFailure.Destroyed,
        0,
        new Int32Array(this.destroy_status),
      );
      return;
    }

    let worker: Worker;
    try {
      worker = new Worker(command.url, {
        type: Atomics.load(signatureView, 3) === 1 ? "module" : "classic",
      });
    } catch (error) {
      completeWorkerRequest(
        command.requestView,
        WorkerRequestState.Failed,
        WorkerRequestFailure.ScriptLoad,
        0,
        new Int32Array(this.destroy_status),
      );
      this.fail_runtime(error);
      return;
    }

    const record: WorkerRecord = {
      worker,
      request_view: command.requestView,
      worker_id: 0,
    };
    this.start_worker = record;
    this.register_handlers(record, true);
    try {
      worker.postMessage({
        ...this.override_object,
        ...command.obj,
        worker_background_ref: this.ref(),
      });
    } catch (error) {
      this.complete_request_failure(
        record,
        WorkerRequestFailure.WasmInstantiation,
      );
      this.fail_runtime(error);
      return;
    }
    this.complete_request_ready(record);
  }

  private async listen(): Promise<void> {
    const lockView = new Int32Array(this.lock);
    const signatureView = new Int32Array(this.signature_input);
    const destroyView = new Int32Array(this.destroy_status);
    Atomics.store(lockView, 0, 0);

    for (;;) {
      if (readLifecycle(destroyView) !== WorkerLifecycle.Running) {
        if (
          Atomics.load(lockView, 1) === 0 ||
          Atomics.load(lockView, 2) === 1
        ) {
          try {
            this.cancel_published_command(signatureView);
          } finally {
            this.acknowledge_command(lockView);
          }
        }
        await this.teardown();
        return;
      }

      const waiter = Atomics.waitAsync(lockView, 1, 1);
      if (readLifecycle(destroyView) !== WorkerLifecycle.Running) {
        if (waiter.value instanceof Promise) {
          Atomics.notify(lockView, 1);
          await waiter.value;
        }
        if (
          Atomics.load(lockView, 1) === 0 ||
          Atomics.load(lockView, 2) === 1
        ) {
          try {
            this.cancel_published_command(signatureView);
          } finally {
            this.acknowledge_command(lockView);
          }
        }
        await this.teardown();
        return;
      }

      const { value } = waiter;
      const result = value instanceof Promise ? await value : value;
      if (result === "timed-out") throw new Error("timed-out");

      if (readLifecycle(destroyView) !== WorkerLifecycle.Running) {
        if (
          Atomics.load(lockView, 1) === 0 ||
          Atomics.load(lockView, 2) === 1
        ) {
          try {
            this.cancel_published_command(signatureView);
          } finally {
            this.acknowledge_command(lockView);
          }
        }
        await this.teardown();
        return;
      }

      if (Atomics.load(lockView, 1) !== 0) continue;

      try {
        switch (Atomics.load(signatureView, 0)) {
          case 1:
            this.create_worker(signatureView);
            break;
          case 2:
            this.create_start_worker(signatureView);
            break;
          case 3:
            this.terminate_registered_workers();
            break;
          case 4: {
            const animalId = Atomics.load(signatureView, 1);
            const record = this.animal_workers.get(animalId);
            if (record !== undefined) {
              record.worker.postMessage({
                msg: "kill_animal",
                animal_id: animalId,
              });
              if (this.animal_workers.get(animalId) === record) {
                this.animal_workers.delete(animalId);
              }
            }
            break;
          }
          default:
            this.fail_runtime(
              new Error("unknown worker background command"),
              WorkerDestroyFailureCode.Protocol,
            );
        }
      } catch (error) {
        this.fail_runtime(error);
      } finally {
        this.acknowledge_command(lockView);
      }
    }
  }
}

// biome-ignore lint/complexity/noUnusedVariables: keeps the coordinator alive.
let worker_background: WorkerBackground<unknown>;

globalThis.onmessage = (event: MessageEvent) => {
  globalThis.onmessage = () => undefined;
  const { override_object, worker_background_ref_object } = event.data;
  worker_background = WorkerBackground.init_self(
    override_object,
    worker_background_ref_object,
  );
  void worker_background;
  postMessage("ready");
};
