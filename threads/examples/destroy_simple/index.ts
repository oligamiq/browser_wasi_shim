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

  log("=== Testing DestroyerHandle.destroy() ===\n");
  log("Flow:");
  log("1. Main creates WASIFarm");
  log("2. Worker creates WASIFarmAnimal with thread spawn");
  log("3. Create DestroyerHandle via create_destroyer()");
  log("4. Worker calls destroy() to terminate\n");

  try {
    // Main thread creates WASIFarm with I/O
    const current_directory = new Map<string, Inode>();
    current_directory.set(
      "test.txt",
      new File(new TextEncoder().encode("Test content")),
    );
    current_directory.set("test_dir", new Directory(new Map()));

    const wasi_farm = new WASIFarm(
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered((msg) => log(`[WASI stdout] ${msg}`)),
      ConsoleStdout.lineBuffered((msg) => log(`[WASI stderr] ${msg}`)),
      [new PreopenDirectory(".", current_directory)],
    );
    log("✓ Main: WASIFarm created");

    const wasi_ref = await wasi_farm.get_ref();
    log("✓ Main: wasi_ref obtained");

    const wasi_ref2 = await wasi_farm.get_ref();
    log("✓ Main: second wasi_ref obtained\n");

    // Worker: create WASIFarmAnimal and test destroy
    const worker = new Worker("./test_runner.ts", { type: "module" });

    const timeout = setTimeout(() => {
      log("✗ Test timeout - destroy did not complete");
      worker.terminate();
    }, 15000);

    worker.onmessage = async (event) => {
      console.log("[Main] Message received:", event.data);

      if (event.data.started) {
        log("✓ Worker: Test started");
      }

      if (event.data.destroyed) {
        clearTimeout(timeout);
        log("✓ Worker: destroy() called successfully");
        log("✓ Worker: All threads terminated\n");

        log("✓ Main: WASIFarm resources ready for cleanup");
        worker.terminate();

        setTimeout(() => {
          log("=== TEST COMPLETED SUCCESSFULLY ===");
        }, 100);
      }

      if (event.data.error) {
        clearTimeout(timeout);
        log(`✗ Worker error: ${event.data.error}`);
      }
    };

    worker.postMessage({ wasi_ref, wasi_ref2 });
  } catch (error) {
    log(`✗ Main error: ${error}`);
  }
});
