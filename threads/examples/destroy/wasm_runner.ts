// WASM runner - runs eternal_loop.wasm with WASIFarmAnimal
import { WASIFarmAnimal } from "../../src";

self.onmessage = async (e) => {
  const { wasi_ref, wasi_ref2, wasm_binary } = e.data;

  console.log("[WasmRunner] Received configuration");

  try {
    const wasm = await WebAssembly.compile(wasm_binary);

    console.log("[WasmRunner] Creating WASIFarmAnimal");

    const wasi = new WASIFarmAnimal([wasi_ref2, wasi_ref], [], [], {
      can_thread_spawn: true,
      thread_spawn_worker_url: new URL("./thread_spawn.ts", import.meta.url)
        .href,
      thread_spawn_wasm: wasm,
      worker_background_worker_url: new URL(
        "./worker_background.ts",
        import.meta.url,
      ).href,
    });

    console.log("[WasmRunner] Waiting for background worker...");
    await wasi.wait_worker_background_worker();
    console.log("[WasmRunner] Background worker ready");

    const inst = await WebAssembly.instantiate(wasm, {
      env: {
        ...wasi.get_share_memory(),
      },
      wasi: wasi.wasiThreadImport,
      wasi_snapshot_preview1: wasi.wasiImport,
    });

    console.log("[WasmRunner] Starting eternal loop with threads");
    const destroyer = wasi.create_destroyer();
    self.postMessage({ ready: true, destroyer: destroyer.get_object() });

    // This will run forever until destroy() is called
    try {
      wasi.start(
        inst as unknown as {
          exports: { memory: WebAssembly.Memory; _start: () => unknown };
        },
      );
      console.log("[WasmRunner] WASM completed (unexpected!)");
    } catch (error) {
      console.log("[WasmRunner] WASM terminated (expected after destroy)");
    }
  } catch (error) {
    console.error("[WasmRunner] Error:", error);
    self.postMessage({ error: String(error) });
  }
};
