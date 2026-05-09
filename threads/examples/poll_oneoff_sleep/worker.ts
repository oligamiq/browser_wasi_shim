import { WASIFarmAnimal } from "../../src/index.ts";

self.onmessage = async (e) => {
  const { wasi_ref } = e.data;

  console.log("[Worker] Received wasi_ref, loading sleep.wasm...");

  const wasi = new WASIFarmAnimal(
    wasi_ref,
    ["sleep.wasm", "1000"], // args: sleep for 1000ms
    []
  );

  const wasm = await fetch("./sleep.wasm");
  const { instance } = await WebAssembly.instantiate(await wasm.arrayBuffer(), {
    wasi_snapshot_preview1: wasi.wasiImport,
  });

  console.log("[Worker] Starting sleep for 1000ms...");
  const start = performance.now();
  wasi.start(instance as any);
  console.log(`[Worker] Finished in ${performance.now() - start}ms`);
};
