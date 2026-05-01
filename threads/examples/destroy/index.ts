import {
  OpenFile,
  File,
  ConsoleStdout,
  PreopenDirectory,
  type Inode,
  Directory,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "../../src";

const outputEl = document.getElementById("output") as HTMLPreElement;
const runBtn = document.getElementById("run-test") as HTMLButtonElement;

function log(msg: string) {
  console.log(msg);
  outputEl.textContent += msg + "\n";
}

runBtn.addEventListener("click", async () => {
  outputEl.textContent = "";

  log("=== Testing WASIFarmAnimal.destroy() ===\n");
  log("Flow:");
  log("1. Main thread creates WASIFarm");
  log("2. Worker thread creates WASIFarmAnimal and starts eternal_loop.wasm");
  log("3. After 20 seconds, test_worker calls destroy()");
  log("4. Watch console - output should stop after destroy()\n");

  // Main thread creates WASIFarm with I/O
  const current_directory = new Map<string, Inode>();
  current_directory.set(
    "hello.txt",
    new File(new TextEncoder().encode("Hello, world!")),
  );
  current_directory.set("hello2", new Directory(new Map()));

  const wasi_farm = new WASIFarm(
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((msg) => log(`[WASI stdout] ${msg}`)),
    ConsoleStdout.lineBuffered((msg) => log(`[WASI stderr] ${msg}`)),
    [new PreopenDirectory(".", current_directory)],
  );
  log("✓ Main: WASIFarm created");

  const wasi_ref = await wasi_farm.get_ref();
  log("✓ Main: wasi_ref obtained\n");

  // Worker 1: provides another WASIFarm reference
  const worker = new Worker("./worker.ts", { type: "module" });

  worker.onmessage = async (event) => {
    if (event.data.destroyed) {
      log("\n✓ Main: destroy() was called by worker.ts");
      log("✓ Main: All threads should now be terminated");
      log("✓ Main: Check console - thread output should have stopped\n");

      wasi_farm.destroy(); // Terminate WASIFarmPark on the main thread

      setTimeout(() => {
        log("=== TEST COMPLETED ===");
        log("If thread output stopped in console after destroy(),");
        log("the test PASSED!");
      }, 2000);
      return;
    }

    if (event.data.wasi_ref) {
      const wasi_ref2 = event.data.wasi_ref;
      log("✓ Main: Worker thread initialized with WASIFarm\n");

      // Test worker: runs eternal_loop.wasm with WASIFarmAnimal
      const testWorker = new Worker("./test_worker.ts", { type: "module" });

      testWorker.onmessage = (e) => {
        if (e.data.started) {
          log("✓ Main: TestWorker started eternal loop");
          log("   Waiting 20 seconds before calling destroy()...");
          log("   Watch console - you should see thread output\n");

          setTimeout(() => {
            log("   Sending destroy command to worker.ts...");
            worker.postMessage({ destroyer: e.data.destroyer });
          }, 20000);
        }

        if (e.data.error) {
          log(`✗ Main: TestWorker error: ${e.data.error}`);
        }
      };

      testWorker.postMessage({ wasi_ref, wasi_ref2 });
    }
  };
});
