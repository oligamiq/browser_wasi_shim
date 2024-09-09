onmessage = async function (e) {
    let wasm = await fetch("./echo_and_rewrite.wasm");
    let buff = await wasm.arrayBuffer();
    let { instance } = await WebAssembly.instantiate(buff, {
      "wasi_snapshot_preview1": wasi.wasiImport,
    });
    wasi.start(instance);
}
