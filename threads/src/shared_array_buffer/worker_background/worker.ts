//// <reference types="@better-typescript-lib/webworker" />

// A dedicated coordinator Worker creates subworkers because callers may be
// blocked in Wasm and unable to use postMessage directly.

import { AllocatorUseArrayBuffer } from "../allocator.js";
import * as Serializer from "../serialize_error.js";
import { readLifecycle, WorkerLifecycle } from "../worker_lifecycle.js";
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

class WorkerBackground<T> {
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
      record.worker.terminate();
    }
    this.workers = [undefined];
    this.start_worker = undefined;
    this.animal_workers.clear();
  }

  private destroy(): void {
    const completionView = new Int32Array(this.lock, 12);
    if (claimRuntimeCompletion(completionView)) {
      finishRuntimeCompletion(completionView, RuntimeCompletion.Cancelled);
    }
    this.terminate_registered_workers();
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
    if (!claimRuntimeCompletion(completionView)) return;
    try {
      const serialized = Serializer.serialize(asError(value));
      await this.allocator.async_write(
        new TextEncoder().encode(JSON.stringify(serialized)),
        this.lock,
        4,
      );
      finishRuntimeCompletion(completionView, RuntimeCompletion.Error);
    } catch (error) {
      finishRuntimeCompletion(completionView, RuntimeCompletion.Cancelled);
      console.error(error);
    }
  }

  private fail_current_runtime(error: unknown): void {
    this.terminate_registered_workers();
    void this.publish_runtime_error(error);
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

  private register_handlers(record: WorkerRecord, isStart: boolean): void {
    record.worker.onmessage = (event: MessageEvent) => {
      if (!this.is_active_record(record)) {
        record.worker.terminate();
        return;
      }
      const data = event.data;
      if (data === null || typeof data !== "object") {
        if (record.request_view !== undefined) {
          this.complete_request_failure(record, WorkerRequestFailure.Protocol);
        }
        this.fail_current_runtime(new Error("invalid worker message"));
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
      this.fail_current_runtime(new Error("unknown worker message"));
    };

    record.worker.onerror = (event) => {
      if (!this.is_active_record(record)) {
        record.worker.terminate();
        return;
      }
      event.preventDefault();
      if (record.request_view !== undefined) {
        this.complete_request_failure(record, WorkerRequestFailure.ScriptLoad);
      }
      this.fail_current_runtime(new Error(event.message));
    };
    record.worker.onmessageerror = () => {
      if (!this.is_active_record(record)) {
        record.worker.terminate();
        return;
      }
      if (record.request_view !== undefined) {
        this.complete_request_failure(record, WorkerRequestFailure.Protocol);
      }
      this.fail_current_runtime(
        new Error("worker message could not be decoded"),
      );
    };
  }

  private create_worker(signatureView: Int32Array): void {
    let command: WorkerCommand;
    try {
      command = this.read_command(signatureView);
    } catch (error) {
      console.error(error);
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
      this.fail_current_runtime(error);
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
      this.fail_current_runtime(error);
    }
  }

  private create_start_worker(signatureView: Int32Array): void {
    let command: WorkerCommand;
    try {
      command = this.read_command(signatureView);
    } catch (error) {
      console.error(error);
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
      this.fail_current_runtime(error);
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
      this.fail_current_runtime(error);
      return;
    }
    this.complete_request_ready(record);
  }

  private async listen(): Promise<void> {
    const lockView = new Int32Array(this.lock);
    const signatureView = new Int32Array(this.signature_input);
    Atomics.store(lockView, 0, 0);
    Atomics.store(lockView, 1, 1);

    for (;;) {
      const { value } = Atomics.waitAsync(lockView, 1, 1);
      const result = value instanceof Promise ? await value : value;
      if (result === "timed-out") throw new Error("timed-out");

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
          case 5:
            this.destroy();
            break;
        }
      } catch (error) {
        console.error(error);
      } finally {
        Atomics.store(lockView, 1, 1);
        Atomics.store(lockView, 2, 0);
        Atomics.notify(lockView, 2, 1);
      }
    }
  }
}

// biome-ignore lint/complexity/noUnusedVariables: keeps the coordinator alive.
let worker_background: WorkerBackground<unknown>;

globalThis.onmessage = (event: MessageEvent) => {
  const { override_object, worker_background_ref_object } = event.data;
  worker_background = WorkerBackground.init_self(
    override_object,
    worker_background_ref_object,
  );
  void worker_background;
  postMessage("ready");
};
