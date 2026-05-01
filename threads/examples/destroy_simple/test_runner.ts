import { WASIFarmAnimal, DestroyerHandle } from "../../src";

try {
  console.log("[TestRunner] Initialized");

  self.onmessage = async (e) => {
    if (e.data.wasi_ref && e.data.wasi_ref2) {
      console.log("[TestRunner] Received wasi_refs from main thread");

      try {
        // Create WASIFarmAnimal - basic setup without WASM execution
        const wasi = new WASIFarmAnimal(
          [e.data.wasi_ref, e.data.wasi_ref2],
          [],
          [],
          {},
        );

        console.log("[TestRunner] WASIFarmAnimal created");
        self.postMessage({ started: true });

        // Test: Simulate a simple destroy scenario
        // For a simple test, we just create and destroy the animal
        console.log("[TestRunner] Testing destroy on basic WASIFarmAnimal");

        // Cleanup
        wasi.destroy();
        console.log("[TestRunner] WASIFarmAnimal destroyed successfully");

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
