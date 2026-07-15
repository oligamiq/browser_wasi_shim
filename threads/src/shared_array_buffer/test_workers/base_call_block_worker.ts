import {
  BaseCallOpcode,
  BaseCallRefUseArrayBuffer,
  type BaseCallTransportObject,
} from "../base_call.ts";

self.onmessage = (event: MessageEvent<BaseCallTransportObject>) => {
  const ref = BaseCallRefUseArrayBuffer.init_self(event.data);
  try {
    ref.block_call(BaseCallOpcode.DestroyPark, new Uint8Array());
    postMessage({ type: "result" });
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    postMessage({
      type: "error",
      error: { name: normalized.name, message: normalized.message },
    });
  }
};

export {};
