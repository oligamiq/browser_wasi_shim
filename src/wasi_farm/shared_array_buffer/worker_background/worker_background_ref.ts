import { AllocatorUseArrayBuffer } from "../allocator.js";
import { WorkerBackgroundRefObject } from "./worker.js";

export class WorkerBackgroundRef {
  private allocator: AllocatorUseArrayBuffer;
  private lock: SharedArrayBuffer;
  private signature_input: SharedArrayBuffer;

  constructor(
    allocator: AllocatorUseArrayBuffer,
    lock: SharedArrayBuffer,
    signature_input: SharedArrayBuffer,
  ) {
    this.allocator = allocator;
    this.lock = lock;
    this.signature_input = signature_input;
  }

  private lock_base_func(): void {
    const view = new Int32Array(this.lock);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const lock = Atomics.wait(view, 0, 1);
      if (lock === "timed-out") {
        throw new Error("timed-out lock");
      }
      const old = Atomics.compareExchange(view, 0, 0, 1);
      if (old !== 0) {
        continue;
      }
      break;
    }
  }

  private call_base_func(): void {
    const view = new Int32Array(this.lock);
    const old = Atomics.exchange(view, 1, 1);
    if (old !== 0) {
      console.error("what happened?");
    }
    Atomics.notify(view, 1, 1);
  }

  // wait base_func
  private wait_base_func(): void {
    const view = new Int32Array(this.lock);
    const lock = Atomics.wait(view, 1, 1);
    if (lock === "timed-out") {
      throw new Error("timed-out lock");
    }
  }

  // release base_func
  private release_base_func(): void {
    const view = new Int32Array(this.lock);
    Atomics.store(view, 0, 0);
    Atomics.notify(view, 0, 1);
  }

  new_worker(
    url: string,
    options?: WorkerOptions,
    post_obj?: unknown,
  ): WorkerRef {
    this.lock_base_func();
    const view = new Int32Array(this.signature_input);
    Atomics.store(view, 0, 1);
    const url_buffer = new TextEncoder().encode(url);
    this.allocator.block_write(url_buffer, this.signature_input, 1);
    Atomics.store(view, 3, options.type === "module" ? 1 : 0);
    const obj_json = JSON.stringify(post_obj);
    const obj_buffer = new TextEncoder().encode(obj_json);
    this.allocator.block_write(obj_buffer, this.signature_input, 4);
    this.call_base_func();
    this.wait_base_func();

    const id = Atomics.load(view, 0);

    this.release_base_func();

    return new WorkerRef(id);
  }

  static init_self(
    sl: WorkerBackgroundRefObject,
  ): WorkerBackgroundRef {
    return new WorkerBackgroundRef(
      AllocatorUseArrayBuffer.init_self(sl.allocator),
      sl.lock,
      sl.signature_input,
    );
  }
}

export class WorkerRef {
  private id: number;

  constructor(id: number) {
    this.id = id;
  }

  get_id(): number {
    return this.id;
  }
}
