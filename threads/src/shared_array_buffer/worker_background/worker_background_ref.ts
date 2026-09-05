import { AllocatorUseArrayBuffer } from "../allocator.ts";
import * as Serializer from "../serialize_error.ts";
import {
  DESTROY_FAILURE_CODE,
  DESTROY_WAKE_EPOCH,
  readLifecycle,
  WorkerDestroyError,
  WorkerDestroyFailureCode,
  WorkerLifecycle,
} from "../worker_lifecycle.ts";
import {
  claimRuntimeCompletion,
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

  private block_lock_base_func(): void {
    const view = new Int32Array(this.lock);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const lock = Atomics.wait(view, 0, 1);
      if (lock === "timed-out") {
        throw new Error("timed-out lock");
      }
      const old = Atomics.compareExchange(view, 0, 0, 1);
      if (old === 0) {
        return;
      }
    }
  }

  private async async_lock_base_func(): Promise<void> {
    const view = new Int32Array(this.lock);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value } = Atomics.waitAsync(view, 0, 1);
      if ((await value) === "timed-out") {
        throw new Error("timed-out lock");
      }
      const old = Atomics.compareExchange(view, 0, 0, 1);
      if (old === 0) {
        return;
      }
    }
  }

  private call_base_func(): void {
    const view = new Int32Array(this.lock);
    Atomics.store(view, 2, 1);
    Atomics.store(view, 1, 0);
    Atomics.notify(view, 1, 1);
  }

  // wait base_func
  private block_wait_base_func(): void {
    const view = new Int32Array(this.lock);
    const lock = Atomics.wait(view, 2, 1);
    if (lock === "timed-out") {
      throw new Error("timed-out lock");
    }
  }

  private async async_wait_base_func(): Promise<void> {
    const view = new Int32Array(this.lock);
    const { value } = Atomics.waitAsync(view, 2, 1);
    if ((await value) === "timed-out") {
      throw new Error("timed-out lock");
    }
  }

  // release base_func
  private release_base_func(): void {
    const view = new Int32Array(this.lock);
    Atomics.store(view, 0, 0);
    Atomics.notify(view, 0, 1);
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
    Atomics.notify(new Int32Array(this.lock), 1);
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
    this.assert_running();
    const request = this.block_allocate_worker_request();
    let urlAllocation: Allocation | undefined;
    let objectAllocation: Allocation | undefined;
    let published = false;
    try {
      urlAllocation = this.block_allocate(new TextEncoder().encode(url));
      objectAllocation = this.block_allocate(
        new TextEncoder().encode(JSON.stringify(post_obj)),
      );

      this.block_lock_base_func();
      try {
        this.assert_running();
        const view = new Int32Array(this.signature_input);
        Atomics.store(view, 0, 1);
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
      this.allocator.free(request.allocationPtr, request.allocationLen);
    }
  }

  async async_start_on_thread(
    url: string,
    options: WorkerOptions | undefined,
    post_obj: unknown,
  ) {
    this.assert_running();
    const request = await this.async_allocate_worker_request();
    let urlAllocation: Allocation | undefined;
    let objectAllocation: Allocation | undefined;
    let published = false;
    try {
      urlAllocation = await this.async_allocate(new TextEncoder().encode(url));
      objectAllocation = await this.async_allocate(
        new TextEncoder().encode(JSON.stringify(post_obj)),
      );

      await this.async_lock_base_func();
      try {
        this.assert_running();
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
      this.allocator.free(request.allocationPtr, request.allocationLen);
    }
  }

  block_start_on_thread(
    url: string,
    options: WorkerOptions | undefined,
    post_obj: unknown,
  ) {
    this.assert_running();
    const request = this.block_allocate_worker_request();
    let urlAllocation: Allocation | undefined;
    let objectAllocation: Allocation | undefined;
    let published = false;
    try {
      urlAllocation = this.block_allocate(new TextEncoder().encode(url));
      objectAllocation = this.block_allocate(
        new TextEncoder().encode(JSON.stringify(post_obj)),
      );

      this.block_lock_base_func();
      try {
        this.assert_running();
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
        this.block_wait_base_func();
      } finally {
        this.release_base_func();
      }

      this.block_wait_worker_request(request.view);
    } finally {
      if (!published) {
        if (urlAllocation !== undefined) {
          this.allocator.free(urlAllocation.ptr, urlAllocation.len);
        }
        if (objectAllocation !== undefined) {
          this.allocator.free(objectAllocation.ptr, objectAllocation.len);
        }
      }
      this.allocator.free(request.allocationPtr, request.allocationLen);
    }
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

  done_notify(code: number): void {
    const notify_view = new Int32Array(this.lock, 12);
    if (!claimRuntimeCompletion(notify_view)) {
      console.error("what happened?");
      return;
    }
    Atomics.store(notify_view, 1, code);
    finishRuntimeCompletion(notify_view, RuntimeCompletion.Exit);
  }

  async async_wait_done_or_error(): Promise<number> {
    const notify_view = new Int32Array(this.lock, 12);
    for (;;) {
      const state = Atomics.load(notify_view, 0);
      if (
        state !== RuntimeCompletion.Waiting &&
        state !== RuntimeCompletion.Completing
      ) {
        return this.read_runtime_completion(notify_view, state);
      }
      const { value } = Atomics.waitAsync(notify_view, 0, state);
      const result = value instanceof Promise ? await value : value;
      if (result === "timed-out") throw new Error("timed-out");
    }
  }

  block_wait_done_or_error(): number {
    const notify_view = new Int32Array(this.lock, 12);
    for (;;) {
      const state = Atomics.load(notify_view, 0);
      if (
        state !== RuntimeCompletion.Waiting &&
        state !== RuntimeCompletion.Completing
      ) {
        return this.read_runtime_completion(notify_view, state);
      }
      const result = Atomics.wait(notify_view, 0, state);
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
      throw new Error(`unknown runtime completion state: ${state}`);
    }

    const ptr = Atomics.load(notifyView, 1);
    const size = Atomics.load(notifyView, 2);
    const errorBuffer = this.allocator.take_memory(ptr, size);
    const errorText = new TextDecoder().decode(errorBuffer);
    const serialized = JSON.parse(errorText) as Serializer.SerializedError;
    throw Serializer.deserialize(serialized);
  }

  terminate_all_workers(): void {
    this.block_lock_base_func();
    const view = new Int32Array(this.signature_input);
    Atomics.store(view, 0, 3);
    this.call_base_func();
    this.block_wait_base_func();
    this.release_base_func();
  }

  kill_animal(id: number): void {
    this.block_lock_base_func();
    const view = new Int32Array(this.signature_input);
    Atomics.store(view, 0, 4);
    Atomics.store(view, 1, id);
    this.call_base_func();
    this.block_wait_base_func();
    this.release_base_func();
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
