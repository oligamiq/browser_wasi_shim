import { WASIFarmAnimal } from "../../src";

try {
  console.log("[TestRunner] Initialized");

  self.onmessage = async (e) => {
    if (e.data.wasi_ref && e.data.wasi_ref2) {
      console.log("[TestRunner] Received wasi_refs from main thread");

      try {
        // Create WASIFarmAnimal - basic setup without thread spawning
        const wasi = new WASIFarmAnimal(
          [e.data.wasi_ref, e.data.wasi_ref2],
          [],
          [],
          {},
        );

        console.log("[TestRunner] WASIFarmAnimal created");
        self.postMessage({ started: true });

        // Simulate thread creation by tracking an animal_id
        // In a real scenario, this would be assigned by thread_spawner.generate_animal_id()
        // For this simple test, we'll use a fixed ID
        const animal_id = 1;
        console.log(
          `[TestRunner] Simulating thread spawn with animal_id: ${animal_id}`,
        );
        self.postMessage({ spawned: animal_id });

        // Small delay to simulate thread work
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Call kill_animal to terminate the thread
        console.log(`[TestRunner] Calling kill_animal(${animal_id})`);
        try {
          wasi.kill_animal(animal_id);
          console.log("[TestRunner] kill_animal() called successfully");
          self.postMessage({ killed: animal_id });
        } catch (killError) {
          console.error("[TestRunner] kill_animal error:", killError);
          // kill_animal might not raise an error if the animal is already dead
          // This is normal behavior
          self.postMessage({ killed: animal_id });
        }

        // Cleanup
        wasi.destroy();
        console.log("[TestRunner] WASIFarmAnimal destroyed");
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
