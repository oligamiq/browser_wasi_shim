import { WorkerBackground } from "../worker_background/worker.ts";

globalThis.onmessage = (event) => {
  const { override_object, worker_background_ref_object: reference } =
    event.data;
  const signals = new Int32Array(
    override_object.sl_object.share_memory.control.buffer,
  );
  const background = WorkerBackground.init_self(override_object, reference);
  const internals = background as unknown as {
    claim_command: (
      view: Int32Array,
      terminating?: boolean,
    ) => Promise<boolean>;
  };
  const claim = internals.claim_command.bind(background);
  internals.claim_command = async (...args) => {
    const result = await claim(...args);
    if (!result && Atomics.load(new Int32Array(reference.lock), 0) === 4) {
      Atomics.store(signals, 1, 1);
      Atomics.notify(signals, 1);
      await new Promise(() => undefined);
    }
    return result;
  };
  globalThis.onmessage = () => {
    throw new Error("coordinator crashed with termination ownership");
  };
  postMessage("ready");
};
