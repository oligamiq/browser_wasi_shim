import { strace, WASIFarmAnimal } from "../../dist/index.js";

const { promise, resolve } = Promise.withResolvers();
import("../node_modules/@oligami/shared-object/dist/index.js").then(resolve);

let cat_wasi;
let cat_inst;
let cat_wasm;
let cat_shared;

let rewrite_wasi;
let rewrite_inst;
let rewrite_wasm;
let rewrite_shared;

onmessage = async function (e) {
	const { wasi_refs } = e.data;

	if (wasi_refs) {
		cat_wasm = await WebAssembly.compileStreaming(fetch("./cat.wasm"));

		cat_wasi = new WASIFarmAnimal(
			wasi_refs,
			["cat"], // args
			[], // env
			{
				debug: false,
			},
		);

		// Memory is rewritten at this time.
		cat_inst = await WebAssembly.instantiate(cat_wasm, {
			wasi_snapshot_preview1: cat_wasi.wasiImport,
		});

		await promise;

		const cat_memory_reset = cat_inst.exports.memory.buffer;
		const cat_memory_reset_view = new Uint8Array(cat_memory_reset).slice();

		cat_shared = new SharedObject.SharedObject((...args) => {
			// If I don't reset memory, I get some kind of error.
			cat_wasi.args = ["cat", ...args];
			const memory_view = new Uint8Array(cat_inst.exports.memory.buffer);
			memory_view.set(cat_memory_reset_view);
			cat_wasi.start(cat_inst);
		}, "cat");

		rewrite_wasm = await WebAssembly.compileStreaming(fetch("./rewrite.wasm"));

		rewrite_wasi = new WASIFarmAnimal(
			wasi_refs,
			["rewrite"], // args
			[], // env
			{
				debug: false,
			},
		);

		// Memory is rewritten at this time.
		rewrite_inst = await WebAssembly.instantiate(rewrite_wasm, {
			wasi_snapshot_preview1: rewrite_wasi.wasiImport,
		});

		const rewrite_memory_reset = rewrite_inst.exports.memory.buffer;
		const rewrite_memory_reset_view = new Uint8Array(
			rewrite_memory_reset,
		).slice();

		rewrite_shared = new SharedObject.SharedObject((...args) => {
			// If I don't reset memory, I get some kind of error.
			rewrite_wasi.args = ["rewrite", ...args];
			const memory_view = new Uint8Array(rewrite_inst.exports.memory.buffer);
			memory_view.set(rewrite_memory_reset_view);
			rewrite_wasi.start(rewrite_inst);
		}, "rewrite");

		postMessage({ ready: true });
	}
};
