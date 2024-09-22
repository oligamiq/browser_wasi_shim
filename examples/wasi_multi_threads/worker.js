console.log("worker.js");

import { strace, WASIFarmAnimal } from "../../dist/index.js";

self.onmessage = async (e) => {
  const { wasi_ref } = e.data;

  console.log("worker.js onmessage", e.data);

  const wasi = new WASIFarmAnimal(
    wasi_ref,
    [], // args
    [], // env
    {
      debug: true,
      can_thread_spawn: true,
      thread_spawn_worker_url: (new URL("./thread_spawn.js", import.meta.url)).href,
      // thread_spawn_worker_url: "./thread_spawn.js",
    }
  );

  await wasi.wait_worker_background_worker();

  const wasm = await WebAssembly.compileStreaming(fetch("./multi_thread_echo.wasm"));

  console.log(wasi);

  let inst = await WebAssembly.instantiate(wasm, {
      "env": {
        memory: wasi.get_share_memory(),
      },
      "wasi": strace(wasi.wasiThreadImport, ["thread-spawn"]),
      "wasi_snapshot_preview1": strace(wasi.wasiImport, ["fd_prestat_get"]),
  });

  wasi.start(inst);
}
