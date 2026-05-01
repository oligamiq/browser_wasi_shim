import { WASIFarmAnimal, DestroyerHandle } from "../../src";

try {
  console.log("[TestRunner] Initialized");

  self.onmessage = async (e) => {
    if (e.data.wasi_ref && e.data.wasi_ref2) {
      console.log("[TestRunner] Received wasi_refs from main thread");

      try {
        // Create WASIFarmAnimal with thread spawn support
        const wasi = new WASIFarmAnimal(
          [e.data.wasi_ref, e.data.wasi_ref2],
          [],
          [],
          {
            can_thread_spawn: true,
            thread_spawn_worker_url: new URL(
              "./thread_spawn.ts",
              import.meta.url,
            ).href,
            worker_background_worker_url: new URL(
              "./worker_background.ts",
              import.meta.url,
            ).href,
          },
        );

        console.log("[TestRunner] WASIFarmAnimal created");
        self.postMessage({ started: true });

        // Wait for background worker
        await wasi.wait_worker_background_worker();
        console.log("[TestRunner] Background worker ready");

        // Create destroyer
        const destroyer = wasi.create_destroyer();
        console.log(
          "[TestRunner] DestroyerHandle created, calling destroy()...",
        );

        destroyer.destroy();
        console.log("[TestRunner] destroy() called successfully");

        // Cleanup
        wasi.destroy();
        console.log("[TestRunner] WASIFarmAnimal destroyed");

        self.postMessage({ destroyed: true });
      } catch (error) {
        console.error("[TestRunner] Error:", error);
        self.postMessage({ error: String(error) });
      }
    }
  };
} catch (error) {
  console.error("[TestRunner] Initialization error:", error);
  self.postMessage({ error: String(error) });
}
