import { debug } from "../debug.js";
import { Fd } from "../fd.js";
import { Options } from "../wasi.js";
import { WASIFarmPark } from "./park.js";
import { WASIFarmRef } from "./ref.js";

export default class WASIFarm {
  args: Array<string>;
  env: Array<string>;
  fds: Array<Fd>;
  park: WASIFarmPark;

  constructor(
    args: Array<string>,
    env: Array<string>,
    fds: Array<Fd>,
    options: Options = {},
  ) {
    debug.enable(options.debug);

    this.args = args;
    this.env = env;
    this.fds = fds;
    this.park = new WASIFarmPark(this.fds_ref());

    this.park.listen();
  }

  fds_ref(): Array<Fd> {
    const fds = new Proxy([] as Array<Fd>, {
      get: (_, prop) => {
        console.log("fds", prop);

        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
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
