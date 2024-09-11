import { debug } from "../debug.js";
import { Fd } from "../fd.js";
import { Options } from "../wasi.js";
import { WASIFarmPark } from "./park.js";
import { WASIFarmRef } from "./ref.js";
import { WASIFarmParkUseArrayBuffer } from "./shared_array_buffer/park.js";

export class WASIFarm {
  private fds: Array<Fd>;
  private park: WASIFarmPark;

  private can_array_buffer;

  constructor(
    fds: Array<Fd>,
    options: Options = {},
  ) {
    debug.enable(options.debug);

    this.fds = fds;

    try {
        new SharedArrayBuffer(4);
        this.can_array_buffer = true;
    } catch (_) {
        this.can_array_buffer = false;
    }

    if (this.can_array_buffer) {
        this.park = new WASIFarmParkUseArrayBuffer(this.fds_ref());
    }

    this.park.listen();
  }

  private fds_ref(): Array<Fd> {
    const fds = new Proxy([] as Array<Fd>, {
      get: (_, prop) => {
        // console.log("fds", prop);

        if (prop === "push") {
          return (fd: Fd) => {
            const len = this.fds.push(fd);
            return len;
          };
        }
        return this.fds[prop];
      }
    });

    return fds;
  }

  get_ref(): WASIFarmRef {
    return this.park.get_ref();
  }
}
