import { WorkerBackground } from "../worker_background/worker.ts";
import type { WorkerBackgroundRefObject } from "../worker_background/worker_export.ts";

// Bun lacks WorkerGlobalScope.close; the parent explicitly terminates this fixture.
globalThis.close ??= () => undefined;

globalThis.onmessage = (event) => {
  const { reference, control, failAllocation } = event.data as {
    reference: WorkerBackgroundRefObject;
    control: SharedArrayBuffer;
    failAllocation: boolean;
  };
  const signals = new Int32Array(control);
  const background = WorkerBackground.init_self({ control }, reference);
  const internals = background as unknown as {
    terminate_worker: (record: { animal_id: number }) => void;
    publish_runtime_error: (error: unknown) => void;
    allocator: { write_inner: () => never };
    kill_animal: (id: number) => void;
    create_worker: (signature: Int32Array) => void;
  };
  const terminate = internals.terminate_worker.bind(background);
  const create = internals.create_worker.bind(background);
  internals.create_worker = (signature) => {
    create(signature);
    const request = new Int32Array(
      reference.allocator.share_arrays_memory,
      Atomics.load(signature, 6),
      3,
    );
    Atomics.store(signals, 12, Atomics.load(request, 0) + 1);
    Atomics.notify(signals, 12);
  };
  internals.terminate_worker = (record) => {
    Atomics.store(
      signals,
      20 + record.animal_id,
      new Int32Array(reference.lock)[0]! + 1,
    );
    Atomics.notify(signals, 20 + record.animal_id);
    terminate(record);
  };
  const publish = internals.publish_runtime_error.bind(background);
  internals.publish_runtime_error = (error) => {
    if (failAllocation)
      internals.allocator.write_inner = () => {
        throw new Error("forced error allocation failure");
      };
    publish(error);
    Atomics.store(signals, 15, 1);
    Atomics.notify(signals, 15);
  };
  globalThis.onmessage = (message) => {
    if (message.data.kill !== undefined)
      internals.kill_animal(message.data.kill);
    postMessage("probed");
  };
  postMessage("ready");
};
