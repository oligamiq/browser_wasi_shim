import { WASIFarmAnimal } from "../../dist/wasi_farm/animals.js";
import { WASIFarmRefUseArrayBuffer } from "../../dist/wasi_farm/shared_array_buffer/ref.js";

self.onmessage = async function (e) {
    console.log("e: ", e);
    const wasi_ref_shadow = e.data;
    console.log("wasi_ref: ", wasi_ref_shadow);
    try {
        new SharedArrayBuffer(4);
        this.can_array_buffer = true;
    } catch (_) {
        this.can_array_buffer = false;
    }
    console.log("can_array_buffer: ", this.can_array_buffer);

    let wasi_ref;
    if (this.can_array_buffer) {
        wasi_ref = new WASIFarmRefUseArrayBuffer(
            wasi_ref_shadow.allocator,
            wasi_ref_shadow.lock_fds,
            wasi_ref_shadow.fd_func_sig,
        );
        console.log("wasi_ref: ", wasi_ref);
    }

    const wasi = new WASIFarmAnimal(
        wasi_ref,
        [""], // args
        [""], // env
        // options
    );
    console.log("wasi: ", wasi);
    let wasm = await fetch("./echo_and_rewrite.wasm");
    let buff = await wasm.arrayBuffer();
    let { instance } = await WebAssembly.instantiate(buff, {
      "wasi_snapshot_preview1": wasi.wasiImport,
    });
    wasi.start(instance);
}
