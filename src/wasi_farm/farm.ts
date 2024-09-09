import { debug } from "../debug.js";
import { Fd } from "../fd.js";
import { Options } from "../wasi.js";
import { WASIFarmPark } from "./park.js";
import { WASIFarmRef } from "./ref.js";

export default class WASIFarm {
  args: Array<string>;
  env: Array<string>;
  fds: Array<Fd>;
  sockets: WASIFarmPark[];

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
    this.sockets = [];
  }

  member_ref(): [Array<string>, Array<string>, Array<Fd>] {
    const args = [...this.args];
    const env = [...this.env];

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

    return [args, env, fds];
  }

  get_ref(): WASIFarmRef {
    let socket = new WASIFarmPark(this.member_ref());

    this.sockets.push(socket);

    return socket.get_ref();
  }
}
