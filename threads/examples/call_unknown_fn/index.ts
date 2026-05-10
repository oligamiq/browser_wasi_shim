import {
  ConsoleStdout,
  File,
  type Inode,
  OpenFile,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "../../src";

const outputEl = document.getElementById("output") as HTMLPreElement;
const runBtn = document.getElementById("run-test") as HTMLButtonElement;

function log(msg: string, className?: string) {
  console.log(msg);
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = `${msg}\n`;
  outputEl.appendChild(span);
}

runBtn.addEventListener("click", async () => {
  outputEl.textContent = "";

  log("=== Starting call_unknown_fn Test ===");

  try {
    // 1. Define unknown_fn on the main thread
    const unknown_fn = async (arg: any) => {
      log(`[Main] unknown_fn invoked with: ${JSON.stringify(arg)}`);

      // Simulate some async processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      const response = {
        status: "success",
        received: arg,
        timestamp: Date.now(),
        note: "Hello from Main Thread!",
      };

      log(`[Main] Sending response: ${JSON.stringify(response)}`);
      return response;
    };

    // 2. Create WASIFarm with the unknown_fn
    const wasi_farm = new WASIFarm(
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered((msg) => log(`[WASI stdout] ${msg}`)),
      ConsoleStdout.lineBuffered((msg) => log(`[WASI stderr] ${msg}`)),
      [new PreopenDirectory(".", new Map<string, Inode>())],
      {
        unknown_fn,
      },
    );
    log("✓ Main: WASIFarm created with unknown_fn");

    const wasi_ref = await wasi_farm.get_ref();

    // 3. Start worker thread
    const worker = new Worker("./test_runner.ts", { type: "module" });

    worker.onmessage = (event) => {
      if (event.data.type === "log") {
        log(event.data.message);
      } else if (event.data.type === "done") {
        log("\n=== TEST COMPLETED SUCCESSFULLY ===", "success");
        worker.terminate();
      } else if (event.data.type === "error") {
        log(`\n✗ Error: ${event.data.message}`, "error");
        worker.terminate();
      }
    };

    worker.postMessage({ wasi_ref });
  } catch (error) {
    log(`✗ Main error: ${error}`, "error");
  }
});
