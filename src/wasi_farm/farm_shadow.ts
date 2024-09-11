import { Fd } from "../fd";
import { WASIFarm, WASIFarmRef } from "../index";
import { Options } from "../wasi";
import { make_shadow_worker_blob_url } from "./make_shadow_worker_blob";

export class WASIFarmShadow {
  private worker: Worker;

  private get_ref_promise: Array<(value: WASIFarmRef | PromiseLike<WASIFarmRef>) => void> = [];

  constructor(
    fds: Array<Fd>,
    options: Options = {},
  ) {
    const farm = WASIFarm(fds, options);
    const worker = new Worker(make_shadow_worker_blob_url());
    worker.postMessage({
      msg: "create",
      data: farm,
    });

    worker.onmessage = (event) => {
      const message: {
        msg: "ref";
        data: unknown;
      } = event.data;

      if (message.msg === "ref") {
        const ref = message.data as WASIFarmRef;
        this.get_ref_promise[0](ref);
        this.get_ref_promise.shift();
      }
    };

    this.worker = worker;
  }

  async get_ref(): Promise<WASIFarmRef> {
    const promise = new Promise<WASIFarmRef>((resolve) => {
      this.get_ref_promise.push(resolve);
    });
    this.worker.postMessage({ msg: "ref" });
    return promise;
  }
}
