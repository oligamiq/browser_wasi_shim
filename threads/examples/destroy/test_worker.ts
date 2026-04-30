import { WASIFarmAnimal } from "../../src";

self.onmessage = async (e) => {
  const { wasi_ref, wasi_ref2 } = e.data;

  console.log("[TestWorker] Loading eternal_loop.wasm");

  try {
    const wasmResponse = await fetch("./eternal_loop.wasm");
    const wasmBuffer = await wasmResponse.arrayBuffer();

    console.log("[TestWorker] Starting wasm_runner worker");

    // Spawn wasm_runner to execute eternal_loop.wasm
    const wasmRunner = new Worker("./wasm_runner.ts", { type: "module" });

    wasmRunner.onmessage = (msg) => {
      if (msg.data.ready) {
        console.log("[TestWorker] wasm_runner ready, eternal loop started");
        self.postMessage({ started: true, destroyer: msg.data.destroyer });
      }
    };

    wasmRunner.onerror = (error) => {
      console.error("[TestWorker] wasm_runner error:", error);
      self.postMessage({ error: String(error) });
    };

    wasmRunner.postMessage({ wasi_ref, wasi_ref2, wasm_binary: wasmBuffer });

  } catch (error) {
    console.error("[TestWorker] Error:", error);
    self.postMessage({ error: String(error) });
  }
};
