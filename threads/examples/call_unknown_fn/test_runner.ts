import { WASIFarmAnimal } from "../../src";

function log(message: string) {
  self.postMessage({ type: "log", message: `[Worker] ${message}` });
}

self.onmessage = async (e) => {
  if (e.data.wasi_ref) {
    log("Received wasi_ref, initializing WASIFarmAnimal...");

    try {
      const wasi = new WASIFarmAnimal(e.data.wasi_ref, [], []);
      log("WASIFarmAnimal created.");

      const payload = {
        action: "ping",
        data: "Hello from Worker!",
        id: 123,
      };

      log(`Calling call_unknown_fn(0, ${JSON.stringify(payload)})...`);

      // Invoke the function on the main thread via WASIFarm
      const result = wasi.call_unknown_fn(0, payload);

      log(`Received result from main thread: ${JSON.stringify(result)}`);

      if (result && (result as any).status === "success") {
        log("Verification successful: Received correct response status.");
        self.postMessage({ type: "done" });
      } else {
        throw new Error("Invalid response received from main thread");
      }
    } catch (error) {
      self.postMessage({ type: "error", message: String(error) });
    }
  }
};
