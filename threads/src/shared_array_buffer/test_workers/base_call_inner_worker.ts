import { WASIFarmAnimal } from "../../animals.ts";
import type { WASIFarmRefObject } from "../../index.ts";

type WorkerRequest = { wasiRef: WASIFarmRefObject };
type WorkerResult = { ok: true; value: unknown } | { ok: false; error: string };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  let result: WorkerResult;
  try {
    const animal = new WASIFarmAnimal(event.data.wasiRef, [], []);
    result = {
      ok: true,
      value: animal.call_unknown_fn(0, { kind: "inner" }),
    };
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  self.postMessage(result);
};

export {};
