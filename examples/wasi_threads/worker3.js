import { WASIFarmAnimal } from "../../dist/wasi_farm/animals.js";

self.onmessage = async function (e) {
    const { wasi_ref } = e.data;

    const wasi = new WASIFarmAnimal(
        wasi_ref,
        ["echo_and_rewrite", "hello.txt", "world", "new_world", "200", "300"], // args
        [""], // env
        // options
    );
    let wasm = await fetch("./echo_and_rewrite.wasm");
    let buff = await wasm.arrayBuffer();
    let { instance } = await WebAssembly.instantiate(buff, {
      "wasi_snapshot_preview1": wasi.wasiImport,
    });
    wasi.start(instance);
}
