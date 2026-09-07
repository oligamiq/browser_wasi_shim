import { WorkerBackgroundRef } from "../worker_background/worker_background_ref.ts";

globalThis.onmessage = (event) => {
  const { reference, control, id } = event.data;
  const signals = new Int32Array(control);
  const wait = Atomics.wait;
  Atomics.wait = (view, index, value, timeout) => {
    if (!(view instanceof Int32Array) || typeof value !== "number") {
      throw new Error("expected Int32 gate wait");
    }
    if (view.buffer === reference.lock && index === 0) {
      Atomics.store(signals, 7, Number(value) + 1);
      Atomics.notify(signals, 7);
    }
    return wait(view, index, value, timeout);
  };
  WorkerBackgroundRef.init_self(reference).kill_animal(id);
  Atomics.store(signals, 8, 1);
  Atomics.notify(signals, 8);
};
