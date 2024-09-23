// If you create a worker and try to increase the number of threads,
// you will have to use Atomics.wait because they need to be synchronized.
// However, this is essentially impossible because Atomics.wait blocks the threads.
// Therefore, a dedicated worker that creates a subworker (worker in worker) is prepared.
// The request is made using BroadcastChannel.

console.log("worker_background_worker");

import { AllocatorUseArrayBuffer, AllocatorUseArrayBufferObject } from "../allocator.js";

// Note that postMessage, etc.
// cannot be used in a blocking environment such as during wasm execution.
// (at least as far as I have tried)

export type WorkerBackgroundRefObject = {
  allocator: AllocatorUseArrayBufferObject;
  lock: SharedArrayBuffer;
  signature_input: SharedArrayBuffer;
};

class WorkerBackground<T> {
  private override_object: T;
  private allocator: AllocatorUseArrayBuffer;
  private lock: SharedArrayBuffer;
  private signature_input: SharedArrayBuffer;

  private workers: Array<Worker> = [];

  private listen_holder: Promise<void>;

  constructor(
    override_object: T,
  ) {
    this.override_object = override_object;
    this.lock = new SharedArrayBuffer(8);
    this.allocator = new AllocatorUseArrayBuffer(
      new SharedArrayBuffer(10 * 1024),
    );
    this.signature_input = new SharedArrayBuffer(24);
    this.listen_holder = this.listen();
  }

  assign_worker_id(): number {
    for (let i = 0; i < this.workers.length; i++) {
      if (this.workers[i] === undefined) {
        return i;
      }
    }
    this.workers.push(undefined);
    return this.workers.length;
  }

  ref(): WorkerBackgroundRefObject {
    return {
      allocator: this.allocator.get_object(),
      lock: this.lock,
      signature_input: this.signature_input,
    };
  }

  async listen(): Promise<void> {
    const lock_view = new Int32Array(this.lock);
    Atomics.store(lock_view, 0, 0);
    Atomics.store(lock_view, 1, 0);

    const signature_input_view = new Int32Array(this.signature_input);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        let lock: "not-equal" | "timed-out" | "ok";

        const { value } = Atomics.waitAsync(lock_view, 1, 0);
        if ( value instanceof Promise) {
          lock = await value;
        } else {
          lock = value;
        }
        if (lock === "timed-out") {
          throw new Error("timed-out");
        }

        const locked_value = Atomics.load(lock_view, 1);
        if (locked_value !== 1) {
          throw new Error("locked");
        }

        const signature_input = Atomics.load(signature_input_view, 0);
        switcher: switch (signature_input) {
          // create new worker
          case 1: {
            const url_ptr = Atomics.load(signature_input_view, 1);
            const url_len = Atomics.load(signature_input_view, 2);
            const url_buff = this.allocator.get_memory(url_ptr, url_len);
            const url = new TextDecoder().decode(url_buff);
            const is_module = Atomics.load(signature_input_view, 3) === 1;
            const worker = new Worker(url, { type: is_module ? "module" : "classic" });
            const json_ptr = Atomics.load(signature_input_view, 4);
            const json_len = Atomics.load(signature_input_view, 5);
            const json_buff = this.allocator.get_memory(json_ptr, json_len);
            const json = new TextDecoder().decode(json_buff);
            const obj = JSON.parse(json);

            const worker_id = this.assign_worker_id();

            this.workers[worker_id] = worker;

            const { promise, resolve } = Promise.withResolvers<void>();

            worker.onmessage = (e) => {
              const { msg } = e.data;

              if (msg === "ready") {
                console.log("worker ready");
                resolve();
              }

              if (msg === "done") {
                this.workers[worker_id].terminate();
                this.workers[worker_id] = undefined;
              }
            }

            worker.postMessage({
              ...this.override_object,
              ...obj,
              worker_id,
              worker_background_ref: this.ref(),
            })

            await promise;

            Atomics.store(signature_input_view, 0, worker_id);

            break switcher;
          }
        }

        const old_call_lock = Atomics.exchange(lock_view, 1, 0);
        if (old_call_lock !== 1) {
          throw new Error("Lock is already set");
        }
        const num = Atomics.notify(lock_view, 1, 1);
        if (num !== 1) {
          if (num === 0) {
            console.warn("notify failed, waiter is late");
            continue;
          }
          throw new Error("notify failed: " + num);
        }
      } catch (e) {
        console.error(e);
      }
    }
  }
}

console.log("worker_background_worker end");

let worker_background: WorkerBackground<unknown>;

globalThis.onmessage = (e: MessageEvent) => {
  const { override_object } = e.data;
  worker_background = new WorkerBackground(override_object);
  postMessage(worker_background.ref());
}
