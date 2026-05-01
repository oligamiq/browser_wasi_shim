// Worker that runs eternal_loop.wasm with threads
import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { WASIFarmAnimal } from "../../src/index.ts";
import { set_fake_worker, sendPingsAndCountPongs } from "./common.ts";

set_fake_worker();

parentPort.on("message", async (e) => {
  const { wasi_ref } = e;

  console.log("[Worker] Loading eternal_loop.wasm");

  const wasm = await WebAssembly.compile(
    readFileSync("./examples/destroy/eternal_loop.wasm") as BufferSource,
  );

  console.log("[Worker] Creating WASIFarmAnimal with thread spawner");

  const wasi = new WASIFarmAnimal(wasi_ref, [], [], {
    can_thread_spawn: true,
    thread_spawn_worker_url: "./examples/destroy_node/thread_spawn.ts",
    thread_spawn_wasm: wasm,
    worker_background_worker_url:
      "./examples/destroy_node/worker_background_worker.ts",
  });

  console.log("[Worker] Waiting for background worker...");
  await wasi.wait_worker_background_worker();
  console.log("[Worker] Background worker ready");

  const inst = await WebAssembly.instantiate(wasm, {
    env: {
      ...wasi.get_share_memory(),
    },
    wasi: wasi.wasiThreadImport,
    wasi_snapshot_preview1: wasi.wasiImport,
  });

  console.log("[Worker] Starting eternal loop with threads");
  parentPort.postMessage({ started: true });

  // Start WASM in background
  setTimeout(() => {
    try {
      wasi.start(
        inst as unknown as {
          exports: { memory: WebAssembly.Memory; _start: () => unknown };
        },
      );
      console.log("[Worker] WASM completed (unexpected!)");
    } catch (error) {
      console.log("[Worker] WASM terminated (expected after destroy)");
    }
  }, 100);

  // Wait for commands
  await new Promise<void>((resolve) => {
    const messageHandler = async (msg: any) => {
      if (msg.command === "ping_before_destroy") {
        console.log("[Worker] Sending pings BEFORE destroy");
        const responders = await sendPingsAndCountPongs(10, 100);
        console.log(`[Worker] Got pongs from ${responders.size} workers`);
        parentPort.postMessage({ pongs_before_destroy: responders.size });
        parentPort.off("message", messageHandler);
        resolve();
      }
    };
    parentPort.on("message", messageHandler);
  });

  // Wait for destroy command
  await new Promise<void>((resolve) => {
    const messageHandler = (msg: any) => {
      if (msg.command === "destroy") {
        console.log("[Worker] Calling destroy()");
        wasi.destroy();
        console.log("[Worker] destroy() completed");
        parentPort.postMessage({ destroyed: true });
        parentPort.off("message", messageHandler);
        resolve();
      }
    };
    parentPort.on("message", messageHandler);
  });

  // Wait for ping_after_destroy command
  await new Promise<void>((resolve) => {
    const messageHandler = async (msg: any) => {
      if (msg.command === "ping_after_destroy") {
        console.log("[Worker] Sending pings AFTER destroy");
        const responders = await sendPingsAndCountPongs(10, 100);
        console.log(`[Worker] Got pongs from ${responders.size} workers`);
        parentPort.postMessage({ pongs_after_destroy: responders.size });
        parentPort.off("message", messageHandler);
        resolve();
      }
    };
    parentPort.on("message", messageHandler);
  });
});
