import { WASIFarmAnimal } from "../../dist/index.js";

const { promise, resolve } = Promise.withResolvers();
import("../node_modules/@oligami/shared-object/dist/index.js").then(resolve);

let wasi;
let wasm;
let shared;

onmessage = async function (e) {
	const { wasi_refs } = e.data;

	if (wasi_refs) {
		wasm = await WebAssembly.compileStreaming(
			fetch("./rust_wasm/rustc_llvm_with_lld/cargo_opt.wasm"),
		);

		wasi = new WASIFarmAnimal(
			wasi_refs,
			[], // args
			[
				"RUST_MIN_STACK=16777216",
				"HOME=/home/wasi",
				"CARGO_LOG=info",
				"RUST_BACKTRACE=full",
				"CARGO=cargo",
				// This is made up of forced patches. Usually not available.
				"RUSTC_SYSROOT=/sysroot-with-lld",
				"LD_LIBRARY_PATH=/lib",
				"PATH=/bin:/usr/bin:/usr/local/bin:/home/wasi/.cargo/bin",
				// "CARGO_INCREMENTAL=0",
				// "CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse",
			], // env
			{
				// debug: true,
				can_thread_spawn: true,
				thread_spawn_worker_url: new URL(
					"./thread_spawn_rustc.js",
					import.meta.url,
				).href,
				// thread_spawn_worker_url: "./thread_spawn.js",
				thread_spawn_wasm: wasm,
				extend_imports: true,
			},
		);

		await wasi.wait_worker_background_worker();

		wasi.get_share_memory().grow(200);

		console.log("Waiting for worker background worker...");

		await promise;

		shared = new SharedObject.SharedObject((...args) => {
			console.log("wasi.start");
			wasi.args = ["cargo", ...args];
			wasi.block_start_on_thread();
			console.log("wasi.start done");
		}, "cargo");

		postMessage({ ready: true });
	}
};
