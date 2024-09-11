import { WASIFarmAnimal } from "../../dist/wasi_farm/animals.js";

self.onmessage = async function (e) {
    const { wasi_ref } = e.data;

    console.log("wasi_ref: ", wasi_ref);

    const wasi = new WASIFarmAnimal(
        wasi_ref,
        ["echo_and_rewrite", "hello.txt", "world", "new_world"], // args
        [""], // env
        // options
    );
    console.log("wasi: ", wasi);
    let wasm = await fetch("./echo_and_rewrite.wasm");
    let buff = await wasm.arrayBuffer();
    console.log("buff: ", buff);
    let { instance } = await WebAssembly.instantiate(buff, {
      "wasi_snapshot_preview1": wasi.wasiImport,
    });
    console.log("instance: ", instance);
    wasi.start(instance);
}
