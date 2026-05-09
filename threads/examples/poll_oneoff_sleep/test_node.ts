import { readFileSync } from "node:fs";
import { ConsoleStdout, File, OpenFile } from "../../../src/index.ts";
import { WASIFarm } from "../../src/index.ts";
import WASI_actual from "../../../src/wasi.ts";

const wasi = new WASI_actual(
  ["sleep.wasm", "500"],
  [],
  [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((msg) => console.log(`[Node WASI stdout] ${msg}`)),
    ConsoleStdout.lineBuffered((msg) => console.warn(`[Node WASI stderr] ${msg}`)),
  ]
);

const wasmBuffer = readFileSync("./poll_oneoff_sleep/sleep.wasm");
const { instance } = await WebAssembly.instantiate(wasmBuffer, {
  wasi_snapshot_preview1: wasi.wasiImport,
});

console.log("Node.js: Starting sleep for 500ms...");
const start = performance.now();
wasi.start(instance as any);
console.log(`Node.js: Finished in ${performance.now() - start}ms`);
