self.onmessage = async function (e) {
    console.log("e: ", e);
    const wasi_ref = e.data;
    console.log("wasi_ref: ", wasi_ref);
    let wasm = await fetch("./echo_and_rewrite.wasm");
    let buff = await wasm.arrayBuffer();
    // let { instance } = await WebAssembly.instantiate(buff, {
    //   "wasi_snapshot_preview1": wasi.wasiImport,
    // });
    // wasi.start(instance);
}
