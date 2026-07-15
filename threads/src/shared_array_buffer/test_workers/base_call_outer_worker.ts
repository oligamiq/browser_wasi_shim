import { WASIFarmAnimal } from "../../animals.ts";
import type { WASIFarmRefObject } from "../../index.ts";

type WorkerRequest = { wasiRef: WASIFarmRefObject; arg?: unknown };
type WorkerResult = { ok: true; value: unknown } | { ok: false; error: string };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  let result: WorkerResult;
  try {
    const animal = new WASIFarmAnimal(event.data.wasiRef, [], []);
    const arg = "arg" in event.data ? event.data.arg : { kind: "outer" };
    result = {
      ok: true,
      value: animal.call_unknown_fn(0, arg),
    };
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  self.postMessage(result);
};

export {};
