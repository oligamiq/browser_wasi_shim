import { WorkerBackgroundRef } from "../worker_background/worker_background_ref.ts";
import { RuntimeCompletion } from "../worker_request.ts";
import {
  beginDestroy,
  DESTROY_REQUESTER_STATUS,
  DESTROY_WAKE_EPOCH,
  RequesterStatus,
} from "../worker_lifecycle.ts";

globalThis.onmessage = async (event) => {
  const {
    control: sharedControl,
    worker_background_ref: reference,
    animal_id,
    mode: requestedMode,
  } = event.data;
  const signals = new Int32Array(
    sharedControl ?? event.data.sl_object.share_memory.control.buffer,
  );
  const mode = requestedMode ?? event.data.args[0];
  const ref = WorkerBackgroundRef.init_self(reference);
  const internals = ref as unknown as {
    call_base_func: () => void;
    release_base_func: () => void;
    block_lock_base_func: (preparing?: boolean) => void;
    allocator: {
      write_inner: (
        ...args: [Uint8Array, SharedArrayBuffer, number]
      ) => [number, number];
      free: (ptr: number, len: number) => void;
    };
  };
  const pause = () => {
    Atomics.store(signals, 1, 1);
    Atomics.notify(signals, 1);
    Atomics.wait(signals, 2, 0);
  };
  postMessage({ msg: "ready", animal_id });
  if (mode === "error") {
    await Atomics.waitAsync(signals, 3, 0).value;
    postMessage({
      msg: "error",
      animal_id,
      error: new Error("ordinary error"),
    });
    return;
  }
  if (mode === "requester") {
    await Atomics.waitAsync(signals, 11, 0).value;
    const destroy = new Int32Array(reference.destroy_status);
    beginDestroy(destroy, animal_id);
    ref.notify_destroy();
    while (
      Atomics.load(destroy, DESTROY_REQUESTER_STATUS) !==
      RequesterStatus.RequesterDrained
    ) {
      const epoch = Atomics.load(destroy, DESTROY_WAKE_EPOCH);
      if (
        Atomics.load(destroy, DESTROY_REQUESTER_STATUS) !==
        RequesterStatus.RequesterDrained
      )
        await Atomics.waitAsync(destroy, DESTROY_WAKE_EPOCH, epoch).value;
    }
    Atomics.store(
      signals,
      9,
      Atomics.load(new Int32Array(reference.lock), 0) + 1,
    );
    Atomics.notify(signals, 9);
    await Atomics.waitAsync(signals, 10, 0).value;
    const acquire = internals.block_lock_base_func.bind(ref);
    internals.block_lock_base_func = (preparing) => {
      acquire(preparing);
      pause();
    };
    // Teardown already cancelled runtime completion; the short update is still gated.
    console.error = () => undefined;
    ref.done_notify(37);
  } else if (mode === "sibling") {
    await Atomics.waitAsync(signals, 5, 0).value;
    ref.new_worker(new URL("./noop_worker.ts", import.meta.url).href);
    Atomics.store(signals, 6, 1);
    Atomics.notify(signals, 6);
  } else if (mode === "allocating") {
    const write = internals.allocator.write_inner.bind(internals.allocator);
    internals.allocator.write_inner = (...args) => {
      pause();
      return write(...args);
    };
    try {
      ref.new_worker(new URL("./noop_worker.ts", import.meta.url).href);
    } catch {}
  } else if (mode === "preparing") {
    const publish = internals.call_base_func.bind(ref);
    internals.call_base_func = () => {
      pause();
      publish();
    };
    try {
      ref.new_worker(new URL("./noop_worker.ts", import.meta.url).href);
    } catch {}
  } else if (mode === "selfkill") {
    const release = internals.release_base_func.bind(ref);
    internals.release_base_func = () => {
      pause();
      release();
    };
    ref.kill_animal(animal_id);
  } else if (mode === "publish" || mode === "consume") {
    const compare = Atomics.compareExchange;
    Atomics.compareExchange = ((
      view: Int32Array,
      index: number,
      expected: number,
      replacement: number,
    ) => {
      const old = compare(view, index, expected, replacement);
      if (
        view.buffer === reference.lock &&
        view.byteOffset === 12 &&
        index === 0 &&
        replacement === RuntimeCompletion.Completing &&
        old === expected &&
        mode === "publish"
      )
        pause();
      return old;
    }) as typeof Atomics.compareExchange;
    if (mode === "consume") {
      const free = internals.allocator.free.bind(internals.allocator);
      internals.allocator.free = (ptr, len) => {
        pause();
        free(ptr, len);
      };
    }
    try {
      if (mode === "publish") ref.done_notify(37);
      else await ref.async_wait_done_or_error();
    } catch {
    } finally {
      Atomics.compareExchange = compare;
    }
  }
  Atomics.store(signals, 4, 1);
  Atomics.notify(signals, 4);
};
