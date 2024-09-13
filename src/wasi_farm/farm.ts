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

  private stdin?: number;
  private stdout?: number;
  private stderr?: number;

  constructor(
    stdin?: Fd,
    stdout?: Fd,
    stderr?: Fd,
    fds: Array<Fd> = [],
    options: Options = {},
  ) {
    debug.enable(options.debug);

    const new_fds = [];
    if (stdin) {
      new_fds.push(stdin);
      this.stdin = new_fds.length - 1;
    }
    if (stdout) {
      new_fds.push(stdout);
      this.stdout = new_fds.length - 1;
    }
    if (stderr) {
      new_fds.push(stderr);
      this.stderr = new_fds.length - 1;
    }
    new_fds.push(...fds);

    this.fds = new_fds;

    try {
        new SharedArrayBuffer(4);
        this.can_array_buffer = true;
    } catch (_) {
        this.can_array_buffer = false;
    }

    if (this.can_array_buffer) {
      this.park = new WASIFarmParkUseArrayBuffer(
        this.fds_ref()
      );
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
      },

      set: (_, prop, value) => {
        // console.log("fds", prop, value);
        this.fds[prop] = value;
        return true;
      }
    });

    return fds;
  }

  get_ref(): WASIFarmRef {
    return this.park.get_ref(
      this.stdin,
      this.stdout,
      this.stderr,
    );
  }
}
