import {
  ConsoleStdout,
  File,
  OpenFile,
  PreopenDirectory,
  WASI,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "../../src/index.ts";

async function runOnMainThread() {
  console.log(
    "--- Testing WASI (non-threads) on Main Thread (should fallback to busy-wait) ---",
  );
  const wasi = new WASI(
    ["sleep.wasm", "500"],
    [],
    [
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered((msg) =>
        console.log(`[Main WASI stdout] ${msg}`),
      ),
      ConsoleStdout.lineBuffered((msg) =>
        console.warn(`[Main WASI stderr] ${msg}`),
      ),
    ],
  );

  const wasm = await fetch("./sleep.wasm");
  const { instance } = await WebAssembly.instantiate(await wasm.arrayBuffer(), {
    wasi_snapshot_preview1: wasi.wasiImport,
  });

  console.log("Main Thread: Starting sleep for 500ms...");
  const start = performance.now();
  wasi.start(instance as any);
  console.log(`Main Thread: Finished in ${performance.now() - start}ms`);
}

async function runInWorker() {
  console.log(
    "\n--- Testing WASIFarmAnimal in Worker (should use Atomics.wait) ---",
  );
  const farm = new WASIFarm(
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((msg) =>
      console.log(`[Worker WASI stdout] ${msg}`),
    ),
    ConsoleStdout.lineBuffered((msg) =>
      console.warn(`[Worker WASI stderr] ${msg}`),
    ),
    [],
  );

  const wasi_ref = await farm.get_ref();
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });

  worker.postMessage({ wasi_ref });
}

await runOnMainThread();
await runInWorker();
