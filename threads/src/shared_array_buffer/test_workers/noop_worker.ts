globalThis.onmessage = (event: MessageEvent<{ animal_id: number }>) => {
  globalThis.postMessage({ msg: "ready", animal_id: event.data.animal_id });
};
