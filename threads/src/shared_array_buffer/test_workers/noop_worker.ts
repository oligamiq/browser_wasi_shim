globalThis.onmessage = () => {
  globalThis.postMessage({ msg: "ready", animal_id: 0 });
};
