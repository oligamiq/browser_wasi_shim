import type { Fd } from "@bjorn3/browser_wasi_shim";
import type { WASIFarmPark } from "./park.ts";
import type { WASIFarmRefObject } from "./ref.ts";
import { WASIFarmParkUseArrayBuffer } from "./shared_array_buffer/index.ts";

/**
 * WASIFarm is the central manager for a virtualized WASI environment.
 *
 * It coordinates file descriptors and provides a "park" backend that handles
 * system calls via shared memory across multiple worker threads.
 */
export class WASIFarm {
  private fds: Array<Fd>;
  private park: WASIFarmPark | null;

  private can_array_buffer: boolean;

  /**
   * Initializes a new WASIFarm.
   *
   * @param stdin The standard input file descriptor.
   * @param stdout The standard output file descriptor.
   * @param stderr The standard error file descriptor.
   * @param fds Additional file descriptors to include in the farm.
   * @param options Configuration options for the farm backend.
   */
  constructor(
    stdin?: Fd,
    stdout?: Fd,
    stderr?: Fd,
    fds: Array<Fd> = [],
    options: {
      allocator_size?: number;
      max_fds_limit?: number;
    } = {},
  ) {
    const new_fds = [];
    let stdin_: number | undefined;
    let stdout_: number | undefined;
    let stderr_: number | undefined;
    if (stdin) {
      new_fds.push(stdin);
      stdin_ = new_fds.length - 1;
    }
    if (stdout) {
      new_fds.push(stdout);
      stdout_ = new_fds.length - 1;
    }
    if (stderr) {
      new_fds.push(stderr);
      stderr_ = new_fds.length - 1;
    }
    new_fds.push(...fds);

    const default_allow_fds = [];
    for (let i = 0; i < new_fds.length; i++) {
      default_allow_fds.push(i);
    }

    this.fds = new_fds;

    // WebAssembly.Memory can be used to create a SharedArrayBuffer, but it cannot be transferred by postMessage.
    // Uncaught (in promise) DataCloneError:
    //    Failed to execute 'postMessage' on 'Worker':
    //    SharedArrayBuffer transfer requires self.crossOriginIsolated.
    try {
      new SharedArrayBuffer(4);
      this.can_array_buffer = true;
    } catch (e) {
      this.can_array_buffer = false;
      console.warn("SharedArrayBuffer is not supported:", e);

      if (
        !(globalThis as unknown as { crossOriginIsolated: unknown })
          .crossOriginIsolated
      ) {
        console.warn(
          "SharedArrayBuffer is not supported because crossOriginIsolated is not enabled.",
        );
      }
    }

    if (this.can_array_buffer) {
      this.park = new WASIFarmParkUseArrayBuffer(
        this.fds_ref(),
        stdin_,
        stdout_,
        stderr_,
        default_allow_fds,
        options?.allocator_size,
        options?.max_fds_limit,
      );
    } else {
      throw new Error("Non SharedArrayBuffer is not supported yet");
    }

    this.park.listen();
  }

  private fds_ref(): Array<Fd> {
    const fds = new Proxy([] as Array<Fd>, {
      get: (_, prop) => {
        if (prop === "push") {
          return (fd: Fd) => {
            const len = this.fds.push(fd);
            return len;
          };
        }
        // @ts-expect-error
        return this.fds[prop];
      },

      set: (_, prop, value) => {
        // @ts-expect-error
        this.fds[prop] = value;
        return true;
      },
    });

    return fds;
  }

  /**
   * Generates a reference object that can be transferred to a worker thread.
   *
   * @returns A serialized reference to the WASI farm.
   */
  get_ref(): WASIFarmRefObject {
    if (this.park === null) {
      throw new Error("WASIFarm is already destroyed");
    }

    return this.park.get_ref();
  }
}
