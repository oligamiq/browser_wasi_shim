// node --import @swc-node/register/esm-register --enable-source-maps index.ts

import { Worker } from "node:worker_threads";
import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "../../src/index.ts";

console.log("=== Testing WASIFarmAnimal.destroy() ===\n");
console.log("Test flow:");
console.log("1. Create WASIFarm on main thread");
console.log(
  "2. Worker thread creates WASIFarmAnimal and starts eternal_loop.wasm",
);
console.log("3. Main sends ping_before_destroy → count thread workers");
console.log("4. Main sends destroy → worker calls wasi.destroy()");
console.log("5. Main sends ping_after_destroy → count remaining workers\n");

const farm = new WASIFarm(
  // @ts-ignore
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((msg) => console.log(`[WASI stdout] ${msg}`)),
  ConsoleStdout.lineBuffered((msg) => console.warn(`[WASI stderr] ${msg}`)),
  [],
);

const worker = new Worker("./examples/destroy_node/worker.ts");

worker.postMessage({
  wasi_ref: farm.get_ref(),
});

worker.on("message", async (msg) => {
  if (msg.started) {
    console.log("✓ Worker: eternal_loop.wasm started\n");

    // Wait 2 seconds for threads to spawn
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log("=== PHASE 1: Testing workers BEFORE destroy() ===");
    worker.postMessage({ command: "ping_before_destroy" });
  }

  if (msg.pongs_before_destroy !== undefined) {
    const liveThreads = msg.pongs_before_destroy;
    console.log(`✓ Main: Counted ${liveThreads} unique thread workers\n`);

    if (liveThreads === 0) {
      console.error(
        "✗ FAILED: Expected thread workers to exist before destroy()",
      );
      process.exit(1);
    }

    console.log("=== PHASE 2: Calling destroy() ===");
    worker.postMessage({ command: "destroy" });
  }

  if (msg.destroyed) {
    console.log("✓ Worker: destroy() completed\n");

    farm.destroy(); // Terminate WASIFarmPark on the main thread

    // Wait 1 second after destroy
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log("=== PHASE 3: Testing workers AFTER destroy() ===");
    worker.postMessage({ command: "ping_after_destroy" });
  }

  if (msg.pongs_after_destroy !== undefined) {
    const remainingThreads = msg.pongs_after_destroy;
    console.log(`✓ Main: Counted ${remainingThreads} thread workers\n`);

    if (remainingThreads > 0) {
      console.error(
        `✗ FAILED: Expected 0 workers after destroy(), found ${remainingThreads}`,
      );
      process.exit(1);
    }

    console.log("=== TEST SUMMARY ===");
    console.log(`✓ Before destroy():  ${msg.pongs_before_destroy} workers`);
    console.log(`✓ After destroy():   ${remainingThreads} workers`);
    console.log(
      "✓ TEST PASSED: destroy() successfully terminated all workers\n",
    );

    worker.terminate();
    process.exit(0);
  }

  if (msg.error) {
    console.error(`✗ Worker error: ${msg.error}`);
    process.exit(1);
  }
});

worker.on("error", (error) => {
  console.error("✗ Worker error:", error);
  process.exit(1);
});
