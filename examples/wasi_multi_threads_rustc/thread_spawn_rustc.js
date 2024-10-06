import { thread_spawn_on_worker, WASIFarmAnimal } from "../../dist/index.js";

let wasm;
let wasi;
async function rustc_init(sl_object, fd_map) {
	console.log("rustc_init");
	for (const fd_and_wasi_ref_n of fd_map) {
		console.log("fd_and_wasi_ref_n", fd_and_wasi_ref_n);
	}

	wasm = await WebAssembly.compileStreaming(
		fetch("./rust_wasm/rustc_llvm_with_lld/rustc_opt.wasm"),
	);

	const override_fd_map = new Array(sl_object.wasi_farm_refs_object.length);

	// Possibly null (undefined)
	for (const fd_and_wasi_ref_n of fd_map) {
		// biome-ignore lint/suspicious/noDoubleEquals: <explanation>
		if (fd_and_wasi_ref_n == undefined) {
			continue;
		}
		const [fd, wasi_ref_n] = fd_and_wasi_ref_n;
		if (override_fd_map[wasi_ref_n] === undefined) {
			override_fd_map[wasi_ref_n] = [];
		}
		override_fd_map[wasi_ref_n].push(fd);
	}

	wasi = new WASIFarmAnimal(
		sl_object.wasi_farm_refs_object,
		[], // args
		[
			"RUST_MIN_STACK=16777216",
			"RUSTC_SYSROOT=/sysroot-with-lld",
			"CARGO_LOG=debug",
		],
		// env
		{
			// debug: true,
			can_thread_spawn: true,
			thread_spawn_worker_url: new URL("./thread_spawn.js", import.meta.url)
				.href,
			thread_spawn_wasm: wasm,
			hand_override_fd_map: fd_map,
		},
		override_fd_map,
	);

	await wasi.wait_worker_background_worker();

	wasi.get_share_memory().grow(200);

	console.log("wasi.fd_map", wasi.fd_map);
	for (const fd_and_wasi_ref_n of wasi.fd_map) {
		console.log("fd_and_wasi_ref_n", fd_and_wasi_ref_n);
	}
}

self.onmessage = async (event) => {
	console.log("event.data", event.data);
	await rustc_init(event.data.sl_object, event.data.fd_map);

	const call_rustc = (memory) => {
		const ret = {
			extend_imports: {
				wasm_run: (json_ptr, json_len) => {
					console.log("rustc");
					console.log("json_ptr", json_ptr);
					console.log("json_len", json_len);
					const json = new Uint8Array(
						memory.buffer,
						json_ptr,
						json_len,
					).slice();
					const json_str = new TextDecoder().decode(json);
					const { args, env, target } = JSON.parse(json_str);
					const args_str = args.join(" ");
					const env_str = env.join(" ");
					console.log(`${args_str} ${env_str}`);

					if (args[0] === "rustc") {
						try {
							wasi.args = args;

							wasi.block_start_on_thread();
							return 0;
						} catch (e) {
							console.error(e);
							return -1;
						}
					} else {
						try {
							if (target !== "wasm32-wasi" && target !== "wasm32-wasip1") {
								throw new Error("target must be wasm32-wasip1");
							}

							const ret = wasi.wasm_run(args[0], args);
							return ret;
						} catch (e) {
							console.error(e);
							return -1;
						}
					}
				},
			},
		};
		return ret;
	};
	await thread_spawn_on_worker(event.data, call_rustc);
};
