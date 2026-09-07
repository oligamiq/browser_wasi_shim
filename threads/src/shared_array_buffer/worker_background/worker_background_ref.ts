import { AllocatorUseArrayBuffer } from "../allocator.ts";
import * as Serializer from "../serialize_error.ts";
import {
  DESTROY_FAILURE_CODE,
  DESTROY_WAKE_EPOCH,
  readLifecycle,
  wakeDestroyWaiters,
  WorkerDestroyError,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "../worker_lifecycle.ts";
import {
  cancelRuntimeCompletion,
  claimRuntimeCompletion,
  completeWorkerRequest,
  createWorkerRequestView,
  finishRuntimeCompletion,
  readWorkerRequestWaitSnapshot,
  RuntimeCompletion,
  WORKER_REQUEST_BYTES,
  WORKER_REQUEST_FAILURE,
  WORKER_REQUEST_ID,
  WORKER_REQUEST_STATE,
  WorkerRequestFailure,
  WorkerRequestState,
  WorkerRequestWaitDecision,
} from "../worker_request.ts";
import {
  SIGNATURE_REQUEST_STATUS_LEN,
  SIGNATURE_REQUEST_STATUS_PTR,
  wakeWorkerCommandActivity,
  WORKER_COMMAND_ACK,
  WORKER_COMMAND_ACTIVITY_EPOCH,
  WORKER_COMMAND_MUTEX,
  WORKER_COMMAND_PHASE,
  WORKER_RUNTIME_COMPLETION_OFFSET_BYTES,
  WORKER_RUNTIME_COMPLETION_WORDS,
  WorkerCommandState,
  WorkerTerminationGate,
  reserveWorkerTermination,
  releaseWorkerTermination,
} from "./worker_export.ts";
import type {
  WorkerBackgroundRefObject,
  WorkerOptions,
} from "./worker_export.ts";

type Allocation = {
  ptr: number;
  len: number;
};

type WorkerRequestAllocation = Allocation & {
  allocationPtr: number;
  allocationLen: number;
  view: Int32Array;
};

/**
 * WorkerBackgroundRef provides a thread-safe interface for communicating with
 * the background worker coordination layer.
 *
 * It uses shared memory and atomic operations to request new workers,
 * start threads, and manage thread lifecycles.
 */
export class WorkerBackgroundRef {
  private allocator: AllocatorUseArrayBuffer;
  private lock: SharedArrayBuffer;
  private signature_input: SharedArrayBuffer;
  private destroy_status: SharedArrayBuffer;

  /**
   * Initializes a new WorkerBackgroundRef.
   *
   * @param allocator The shared memory allocator.
   * @param lock The shared buffer for locking the coordination channel.
   * @param signature_input The shared buffer for system call signatures and parameters.
   */
  constructor(
    allocator: AllocatorUseArrayBuffer,
    lock: SharedArrayBuffer,
    signature_input: SharedArrayBuffer,
    destroy_status: SharedArrayBuffer,
  ) {
    this.allocator = allocator;
    this.lock = lock;
    this.signature_input = signature_input;
    this.destroy_status = destroy_status;
  }

  private block_lock_base_func(preparing = true): void {
    const view = new Int32Array(this.lock);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const old = Atomics.compareExchange(view, WORKER_COMMAND_MUTEX, 0, 1);
      if (old === 0) {
        wakeWorkerCommandActivity(view);
        if (preparing)
          Atomics.store(
            view,
            WORKER_COMMAND_PHASE,
            WorkerCommandState.Preparing,
          );
        wakeWorkerCommandActivity(view);
        return;
      }
      const lock = Atomics.wait(view, WORKER_COMMAND_MUTEX, old);
      if (lock === "timed-out") throw new Error("timed-out lock");
    }
  }

  private async async_lock_base_func(preparing = true): Promise<void> {
    const view = new Int32Array(this.lock);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const old = Atomics.compareExchange(view, WORKER_COMMAND_MUTEX, 0, 1);
      if (old === 0) {
        wakeWorkerCommandActivity(view);
        if (preparing)
          Atomics.store(
            view,
            WORKER_COMMAND_PHASE,
            WorkerCommandState.Preparing,
          );
        wakeWorkerCommandActivity(view);
        return;
      }
      const { value } = Atomics.waitAsync(view, WORKER_COMMAND_MUTEX, old);
      if ((await value) === "timed-out") throw new Error("timed-out lock");
    }
  }

  private call_base_func(): void {
    const view = new Int32Array(this.lock);
    Atomics.store(view, WORKER_COMMAND_ACK, 1);
    Atomics.store(view, WORKER_COMMAND_PHASE, WorkerCommandState.Published);
    wakeWorkerCommandActivity(view);
  }

  // wait base_func
  private block_wait_base_func(): void {
    const view = new Int32Array(this.lock);
    const lock = Atomics.wait(view, WORKER_COMMAND_ACK, 1);
    if (lock === "timed-out") {
      throw new Error("timed-out lock");
    }
  }

  private async async_wait_base_func(): Promise<void> {
    const view = new Int32Array(this.lock);
    const { value } = Atomics.waitAsync(view, WORKER_COMMAND_ACK, 1);
    if ((await value) === "timed-out") {
      throw new Error("timed-out lock");
    }
  }

  // release base_func
  private release_base_func(): void {
    const view = new Int32Array(this.lock);
    if (
      Atomics.compareExchange(
        view,
        WORKER_COMMAND_PHASE,
        WorkerCommandState.Preparing,
        WorkerCommandState.Idle,
      ) === WorkerCommandState.Preparing
    ) {
      wakeWorkerCommandActivity(view);
    }
    for (;;) {
      const state = Atomics.load(view, WORKER_COMMAND_MUTEX);
      if (
        state !== WorkerTerminationGate.Caller &&
        state !== WorkerTerminationGate.CallerReserved
      ) {
        throw new Error(
          "worker command caller does not own the termination gate",
        );
      }
      const next =
        state === WorkerTerminationGate.CallerReserved
          ? WorkerTerminationGate.Reserved
          : WorkerTerminationGate.Free;
      if (
        Atomics.compareExchange(view, WORKER_COMMAND_MUTEX, state, next) ===
        state
      )
        break;
    }
    wakeWorkerCommandActivity(view);
    Atomics.notify(view, WORKER_COMMAND_MUTEX);
  }

  private encode_post_object(postObj: unknown): Uint8Array {
    const serialized = JSON.stringify(postObj === undefined ? {} : postObj);
    if (serialized === undefined) {
      throw new TypeError("worker post data must be JSON serializable");
    }
    return new TextEncoder().encode(serialized);
  }

  get_object(): WorkerBackgroundRefObject {
    return {
      allocator: this.allocator.get_object(),
      lock: this.lock,
      signature_input: this.signature_input,
      destroy_status: this.destroy_status,
    };
  }

  notify_destroy(): void {
    wakeWorkerCommandActivity(new Int32Array(this.lock));
  }

  private lifecycle_error(destroyView: Int32Array): WorkerDestroyError {
    const code =
      readLifecycle(destroyView) === WorkerLifecycle.Failed
        ? (Atomics.load(
            destroyView,
            DESTROY_FAILURE_CODE,
          ) as WorkerDestroyFailureCode)
        : WorkerDestroyFailureCode.Protocol;
    return new WorkerDestroyError(code);
  }

  private assert_running(): void {
    const destroyView = new Int32Array(this.destroy_status);
    if (readLifecycle(destroyView) !== WorkerLifecycle.Running) {
      throw this.lifecycle_error(destroyView);
    }
  }

  private block_allocate(data: Uint8Array): Allocation {
    const address = new SharedArrayBuffer(8);
    const [ptr, len] = this.allocator.block_write(data, address, 0);
    return { ptr, len };
  }

  private async async_allocate(data: Uint8Array): Promise<Allocation> {
    const address = new SharedArrayBuffer(8);
    const [ptr, len] = await this.allocator.async_write(data, address, 0);
    return { ptr, len };
  }

  private block_allocate_worker_request(): WorkerRequestAllocation {
    const allocation = this.block_allocate(
      new Uint8Array(WORKER_REQUEST_BYTES + 3),
    );
    const ptr = (allocation.ptr + 3) & ~3;
    return {
      allocationPtr: allocation.ptr,
      allocationLen: allocation.len,
      ptr,
      len: WORKER_REQUEST_BYTES,
      view: new Int32Array(
        this.allocator.share_arrays_memory,
        ptr,
        WORKER_REQUEST_BYTES / 4,
      ),
    };
  }

  private async async_allocate_worker_request(): Promise<WorkerRequestAllocation> {
    const allocation = await this.async_allocate(
      new Uint8Array(WORKER_REQUEST_BYTES + 3),
    );
    const ptr = (allocation.ptr + 3) & ~3;
    return {
      allocationPtr: allocation.ptr,
      allocationLen: allocation.len,
      ptr,
      len: WORKER_REQUEST_BYTES,
      view: new Int32Array(
        this.allocator.share_arrays_memory,
        ptr,
        WORKER_REQUEST_BYTES / 4,
      ),
    };
  }

  private read_worker_request(view: Int32Array): WorkerRef {
    const state = Atomics.load(view, WORKER_REQUEST_STATE);
    if (state === WorkerRequestState.Ready) {
      return new WorkerRef(Atomics.load(view, WORKER_REQUEST_ID));
    }
    if (
      state !== WorkerRequestState.Failed &&
      state !== WorkerRequestState.Cancelled
    ) {
      throw new Error(`worker request is not terminal: ${state}`);
    }
    const failure = Atomics.load(view, WORKER_REQUEST_FAILURE);
    throw new Error(
      `worker request failed: ${WorkerRequestFailure[failure as WorkerRequestFailure] ?? "Unknown"}`,
    );
  }

  private block_wait_worker_request(requestView: Int32Array): WorkerRef {
    const destroyView = new Int32Array(this.destroy_status);
    for (;;) {
      const {
        lifecycle,
        requestState: state,
        decision,
      } = readWorkerRequestWaitSnapshot(requestView, destroyView);
      if (decision === WorkerRequestWaitDecision.RequestTerminal) {
        return this.read_worker_request(requestView);
      }
      if (decision === WorkerRequestWaitDecision.LifecycleFailed) {
        throw this.lifecycle_error(destroyView);
      }
      if (decision === WorkerRequestWaitDecision.LifecycleDestroyed) {
        throw new WorkerDestroyError(WorkerDestroyFailureCode.Protocol);
      }

      const epoch = Atomics.load(destroyView, DESTROY_WAKE_EPOCH);
      if (
        Atomics.load(requestView, WORKER_REQUEST_STATE) === state &&
        readLifecycle(destroyView) === lifecycle &&
        Atomics.load(destroyView, DESTROY_WAKE_EPOCH) === epoch
      ) {
        const result = Atomics.wait(destroyView, DESTROY_WAKE_EPOCH, epoch);
        if (result === "timed-out") throw new Error("atomic wait timed out");
      }
    }
  }

  private async async_wait_worker_request(
    requestView: Int32Array,
  ): Promise<WorkerRef> {
    const destroyView = new Int32Array(this.destroy_status);
    for (;;) {
      const {
        lifecycle,
        requestState: state,
        decision,
      } = readWorkerRequestWaitSnapshot(requestView, destroyView);
      if (decision === WorkerRequestWaitDecision.RequestTerminal) {
        return this.read_worker_request(requestView);
      }
      if (decision === WorkerRequestWaitDecision.LifecycleFailed) {
        throw this.lifecycle_error(destroyView);
      }
      if (decision === WorkerRequestWaitDecision.LifecycleDestroyed) {
        throw new WorkerDestroyError(WorkerDestroyFailureCode.Protocol);
      }

      const epoch = Atomics.load(destroyView, DESTROY_WAKE_EPOCH);
      if (
        Atomics.load(requestView, WORKER_REQUEST_STATE) === state &&
        readLifecycle(destroyView) === lifecycle &&
        Atomics.load(destroyView, DESTROY_WAKE_EPOCH) === epoch
      ) {
        const { value } = Atomics.waitAsync(
          destroyView,
          DESTROY_WAKE_EPOCH,
          epoch,
        );
        const result = value instanceof Promise ? await value : value;
        if (result === "timed-out") throw new Error("atomic wait timed out");
      }
    }
  }

  /**
   * Requests the creation of a new worker thread.
   *
   * @param url The URL of the worker script.
   * @param options Configuration options for the worker.
   * @param post_obj Optional initialization data to send to the worker.
   * @returns A WorkerRef representing the newly created worker.
   */
  new_worker(
    url: string,
    options?: WorkerOptions,
    post_obj?: unknown,
  ): WorkerRef {
    return this.block_create_worker(url, options, post_obj, 1);
  }

  private block_create_worker(
    url: string,
    options: WorkerOptions | undefined,
    post_obj: unknown,
    opcode: 1 | 2,
  ): WorkerRef {
    this.assert_running();
    const data = this.encode_post_object(post_obj);
    let request: WorkerRequestAllocation | undefined;
    let urlAllocation: Allocation | undefined;
    let objectAllocation: Allocation | undefined;
    let published = false;
    try {
      this.block_lock_base_func();
      try {
        this.assert_running();
        request = this.block_allocate_worker_request();
        urlAllocation = this.block_allocate(new TextEncoder().encode(url));
        objectAllocation = this.block_allocate(data);
        const view = new Int32Array(this.signature_input);
        Atomics.store(view, 0, opcode);
        Atomics.store(view, 1, urlAllocation.ptr);
        Atomics.store(view, 2, urlAllocation.len);
        Atomics.store(view, 3, options?.type === "module" ? 1 : 0);
        Atomics.store(view, 4, objectAllocation.ptr);
        Atomics.store(view, 5, objectAllocation.len);
        Atomics.store(view, SIGNATURE_REQUEST_STATUS_PTR, request.ptr);
        Atomics.store(view, SIGNATURE_REQUEST_STATUS_LEN, request.len);
        published = true;
        this.call_base_func();
        this.block_wait_base_func();
      } finally {
        this.release_base_func();
      }

      return this.block_wait_worker_request(request.view);
    } finally {
      if (!published) {
        if (urlAllocation !== undefined) {
          this.allocator.free(urlAllocation.ptr, urlAllocation.len);
        }
        if (objectAllocation !== undefined) {
          this.allocator.free(objectAllocation.ptr, objectAllocation.len);
        }
      }
      if (request !== undefined)
        this.allocator.free(request.allocationPtr, request.allocationLen);
    }
  }

  async async_start_on_thread(
    url: string,
    options: WorkerOptions | undefined,
    post_obj: unknown,
  ) {
    this.assert_running();
    const data = this.encode_post_object(post_obj);
    let request: WorkerRequestAllocation | undefined;
    let urlAllocation: Allocation | undefined;
    let objectAllocation: Allocation | undefined;
    let published = false;
    try {
      await this.async_lock_base_func();
      try {
        this.assert_running();
        request = await this.async_allocate_worker_request();
        urlAllocation = await this.async_allocate(
          new TextEncoder().encode(url),
        );
        objectAllocation = await this.async_allocate(data);
        const view = new Int32Array(this.signature_input);
        Atomics.store(view, 0, 2);
        Atomics.store(view, 1, urlAllocation.ptr);
        Atomics.store(view, 2, urlAllocation.len);
        Atomics.store(view, 3, options?.type === "module" ? 1 : 0);
        Atomics.store(view, 4, objectAllocation.ptr);
        Atomics.store(view, 5, objectAllocation.len);
        Atomics.store(view, SIGNATURE_REQUEST_STATUS_PTR, request.ptr);
        Atomics.store(view, SIGNATURE_REQUEST_STATUS_LEN, request.len);
        published = true;
        this.call_base_func();
        await this.async_wait_base_func();
      } finally {
        this.release_base_func();
      }

      await this.async_wait_worker_request(request.view);
    } finally {
      if (!published) {
        if (urlAllocation !== undefined) {
          this.allocator.free(urlAllocation.ptr, urlAllocation.len);
        }
        if (objectAllocation !== undefined) {
          this.allocator.free(objectAllocation.ptr, objectAllocation.len);
        }
      }
      if (request !== undefined)
        this.allocator.free(request.allocationPtr, request.allocationLen);
    }
  }

  block_start_on_thread(
    url: string,
    options: WorkerOptions | undefined,
    post_obj: unknown,
  ) {
    this.block_create_worker(url, options, post_obj, 2);
  }

  /**
   * Reconstructs a reference from a transferred object.
   *
   * @param sl The serialized reference state.
   * @returns A new WorkerBackgroundRef instance.
   */
  static init_self(sl: WorkerBackgroundRefObject): WorkerBackgroundRef {
    return new WorkerBackgroundRef(
      AllocatorUseArrayBuffer.init_self(sl.allocator),
      sl.lock,
      sl.signature_input,
      sl.destroy_status,
    );
  }

  done_notify(code: number, owner = false): void {
    // Only the local ThreadSpawner owner can bypass exclusion: the coordinator
    // cannot kill it, and a browser main thread cannot block on Atomics.wait.
    if (!owner) this.block_lock_base_func(false);
    try {
      const notify_view = new Int32Array(
        this.lock,
        WORKER_RUNTIME_COMPLETION_OFFSET_BYTES,
        WORKER_RUNTIME_COMPLETION_WORDS,
      );
      if (!claimRuntimeCompletion(notify_view)) {
        console.error("what happened?");
        return;
      }
      Atomics.store(notify_view, 1, code);
      finishRuntimeCompletion(
        notify_view,
        RuntimeCompletion.Exit,
        new Int32Array(this.destroy_status),
      );
    } finally {
      if (!owner) this.release_base_func();
    }
  }

  cancel_runtime_completion(): boolean {
    return cancelRuntimeCompletion(
      new Int32Array(
        this.lock,
        WORKER_RUNTIME_COMPLETION_OFFSET_BYTES,
        WORKER_RUNTIME_COMPLETION_WORDS,
      ),
      new Int32Array(this.destroy_status),
    );
  }

  async async_wait_done_or_error(): Promise<number> {
    const notify_view = new Int32Array(
      this.lock,
      WORKER_RUNTIME_COMPLETION_OFFSET_BYTES,
      WORKER_RUNTIME_COMPLETION_WORDS,
    );
    const destroyView = new Int32Array(this.destroy_status);
    for (;;) {
      const epoch = Atomics.load(destroyView, DESTROY_WAKE_EPOCH);
      const lifecycle = readLifecycle(destroyView);
      const state = Atomics.load(notify_view, 0);
      if (
        state !== RuntimeCompletion.Waiting &&
        state !== RuntimeCompletion.Completing
      ) {
        if (state !== RuntimeCompletion.Error)
          return this.read_runtime_completion(notify_view, state);
        await this.async_lock_base_func(false);
        try {
          return this.read_runtime_completion(
            notify_view,
            Atomics.load(notify_view, 0),
          );
        } finally {
          this.release_base_func();
        }
      }
      if (
        lifecycle === WorkerLifecycle.Failed ||
        lifecycle === WorkerLifecycle.Destroyed
      )
        throw this.lifecycle_error(destroyView);
      const { value } = Atomics.waitAsync(
        destroyView,
        DESTROY_WAKE_EPOCH,
        epoch,
      );
      const result = value instanceof Promise ? await value : value;
      if (result === "timed-out") throw new Error("timed-out");
    }
  }

  block_wait_done_or_error(): number {
    const notify_view = new Int32Array(
      this.lock,
      WORKER_RUNTIME_COMPLETION_OFFSET_BYTES,
      WORKER_RUNTIME_COMPLETION_WORDS,
    );
    const destroyView = new Int32Array(this.destroy_status);
    for (;;) {
      const epoch = Atomics.load(destroyView, DESTROY_WAKE_EPOCH);
      const lifecycle = readLifecycle(destroyView);
      const state = Atomics.load(notify_view, 0);
      if (
        state !== RuntimeCompletion.Waiting &&
        state !== RuntimeCompletion.Completing
      ) {
        if (state !== RuntimeCompletion.Error)
          return this.read_runtime_completion(notify_view, state);
        this.block_lock_base_func(false);
        try {
          return this.read_runtime_completion(
            notify_view,
            Atomics.load(notify_view, 0),
          );
        } finally {
          this.release_base_func();
        }
      }
      if (
        lifecycle === WorkerLifecycle.Failed ||
        lifecycle === WorkerLifecycle.Destroyed
      )
        throw this.lifecycle_error(destroyView);
      const result = Atomics.wait(destroyView, DESTROY_WAKE_EPOCH, epoch);
      if (result === "timed-out") throw new Error("timed-out");
    }
  }

  private read_runtime_completion(
    notifyView: Int32Array,
    state: number,
  ): number {
    if (state === RuntimeCompletion.Done) return 0;
    if (state === RuntimeCompletion.Exit) return Atomics.load(notifyView, 1);
    if (state === RuntimeCompletion.Cancelled) {
      throw this.lifecycle_error(new Int32Array(this.destroy_status));
    }
    if (state !== RuntimeCompletion.Error) {
      if (state === RuntimeCompletion.ErrorConsumed) {
        throw new Error("runtime error payload was already consumed");
      }
      throw new Error(`unknown runtime completion state: ${state}`);
    }

    if (
      Atomics.compareExchange(
        notifyView,
        0,
        RuntimeCompletion.Error,
        RuntimeCompletion.Completing,
      ) !== RuntimeCompletion.Error
    ) {
      return this.read_runtime_completion(
        notifyView,
        Atomics.load(notifyView, 0),
      );
    }

    try {
      const ptr = Atomics.load(notifyView, 1);
      const size = Atomics.load(notifyView, 2);
      const errorBuffer = this.allocator.take_memory(ptr, size);
      const errorText = new TextDecoder().decode(errorBuffer);
      const serialized = JSON.parse(errorText) as Serializer.SerializedError;
      throw Serializer.deserialize(serialized);
    } finally {
      Atomics.store(notifyView, 0, RuntimeCompletion.ErrorConsumed);
      Atomics.notify(notifyView, 0);
      wakeDestroyWaiters(new Int32Array(this.destroy_status));
    }
  }

  private cancel_command_request(reclaimPayloads: boolean): void {
    const signatureView = new Int32Array(this.signature_input);
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
      console.error(error);
    }

    if (reclaimPayloads) {
      for (const [pointerIndex, lengthIndex] of [
        [1, 2],
        [4, 5],
      ] as const) {
        try {
          this.allocator.take_memory(
            Atomics.load(signatureView, pointerIndex),
            Atomics.load(signatureView, lengthIndex),
          );
        } catch (error) {
          console.error(error);
        }
      }
    }

    if (requestView !== undefined) {
      completeWorkerRequest(
        requestView,
        WorkerRequestState.Cancelled,
        WorkerRequestFailure.Destroyed,
        0,
        new Int32Array(this.destroy_status),
      );
    }
  }

  private acknowledge_failed_command(lockView: Int32Array): void {
    Atomics.store(lockView, WORKER_COMMAND_PHASE, WorkerCommandState.Idle);
    wakeWorkerCommandActivity(lockView);
    Atomics.store(lockView, WORKER_COMMAND_ACK, 0);
    Atomics.notify(lockView, WORKER_COMMAND_ACK, 1);
  }

  async recover_failed_coordinator_command(): Promise<void> {
    const lockView = new Int32Array(this.lock);
    for (;;) {
      reserveWorkerTermination(lockView);
      const epoch = Atomics.load(lockView, WORKER_COMMAND_ACTIVITY_EPOCH);
      const state = Atomics.load(lockView, WORKER_COMMAND_PHASE);
      const mutex = Atomics.load(lockView, WORKER_COMMAND_MUTEX);
      // The owner has stopped the failed coordinator. Only coordinator-owned
      // states can be reclaimed; a live caller must release its own ownership.
      if (
        state === WorkerCommandState.Idle &&
        (mutex === WorkerTerminationGate.Reserved ||
          mutex === WorkerTerminationGate.Coordinator)
      ) {
        releaseWorkerTermination(lockView);
        return;
      }
      if (state === WorkerCommandState.Published) {
        if (
          Atomics.compareExchange(
            lockView,
            WORKER_COMMAND_PHASE,
            WorkerCommandState.Published,
            WorkerCommandState.Claimed,
          ) !== WorkerCommandState.Published
        ) {
          continue;
        }
        wakeWorkerCommandActivity(lockView);
        try {
          this.cancel_command_request(true);
        } finally {
          this.acknowledge_failed_command(lockView);
        }
        continue;
      }
      if (state === WorkerCommandState.Claimed) {
        try {
          this.cancel_command_request(false);
        } finally {
          this.acknowledge_failed_command(lockView);
        }
        continue;
      }
      if (
        state !== WorkerCommandState.Idle &&
        state !== WorkerCommandState.Preparing
      ) {
        throw new Error(`unknown worker command state: ${state}`);
      }
      if (
        Atomics.load(lockView, WORKER_COMMAND_PHASE) !== state ||
        Atomics.load(lockView, WORKER_COMMAND_MUTEX) !== mutex ||
        Atomics.load(lockView, WORKER_COMMAND_ACTIVITY_EPOCH) !== epoch
      ) {
        continue;
      }
      const { value } = Atomics.waitAsync(
        lockView,
        WORKER_COMMAND_ACTIVITY_EPOCH,
        epoch,
      );
      const result = value instanceof Promise ? await value : value;
      if (result === "timed-out") throw new Error("timed-out");
    }
  }

  terminate_all_workers(): void {
    this.assert_running();
    this.block_lock_base_func();
    try {
      this.assert_running();
      const view = new Int32Array(this.signature_input);
      Atomics.store(view, 0, 3);
      this.call_base_func();
      this.block_wait_base_func();
    } finally {
      this.release_base_func();
    }
  }

  // Return acknowledges acceptance. Termination follows the caller's gate release.
  kill_animal(id: number): void {
    this.assert_running();
    this.block_lock_base_func();
    try {
      this.assert_running();
      const view = new Int32Array(this.signature_input);
      Atomics.store(view, 0, 4);
      Atomics.store(view, 1, id);
      this.call_base_func();
      this.block_wait_base_func();
    } finally {
      this.release_base_func();
    }
  }
}

/**
 * WorkerRef represents a handle to a worker thread managed by the background
 * coordination layer.
 */
export class WorkerRef {
  private id: number;

  constructor(id: number) {
    this.id = id;
  }

  get_id(): number {
    return this.id;
  }
}
