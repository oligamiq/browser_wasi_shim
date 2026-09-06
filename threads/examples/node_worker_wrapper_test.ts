import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { set_fake_worker as setDestroyWorker } from "./destroy_node/common.ts";
import { set_fake_worker as setChannelWorker } from "./wasi_multi_threads_channel_node/common.ts";

const wrappers = [setDestroyWorker, setChannelWorker];

async function runMain(): Promise<void> {
  const originalClose = Object.getOwnPropertyDescriptor(globalThis, "close");
  const mainGuards = wrappers.map((setup) => {
    try {
      setup();
      return false;
    } catch (error) {
      return error instanceof Error && error.message === "not main thread";
    }
  });
  const workers = await Promise.all(
    wrappers.map(
      (_setup, index) =>
        new Promise<{ closeSource: string; closeType: string }>(
          (resolve, reject) => {
            const worker = new Worker(process.argv[1], { workerData: index });
            worker.once("message", (message) => {
              resolve(message);
              void worker.terminate();
            });
            worker.once("error", reject);
          },
        ),
    ),
  );
  process.stdout.write(
    JSON.stringify({
      mainGuards,
      mainCloseUnchanged:
        Object.getOwnPropertyDescriptor(globalThis, "close") === originalClose,
      workers,
    }),
  );
}

if (isMainThread) {
  void runMain();
} else {
  wrappers[workerData]();
  const close = Reflect.get(globalThis, "close");
  parentPort?.postMessage({
    closeType: typeof close,
    closeSource: String(close),
  });
}
