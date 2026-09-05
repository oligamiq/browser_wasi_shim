import { DestroyerHandle } from "../../destroyer_handle.ts";
import type { DestroyerHandleObject } from "../../destroyer_handle.ts";

globalThis.onmessage = async (event: MessageEvent<DestroyerHandleObject>) => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  DestroyerHandle.init_self(event.data).destroy();
  globalThis.postMessage("destroyed");
};
