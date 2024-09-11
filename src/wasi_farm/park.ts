import { Fd } from "../fd.js";
import { WASIFarmRef } from "./ref.js";
import * as wasi from "../wasi_defs.js";

export abstract class WASIFarmPark {
  abstract get_ref(): WASIFarmRef;
  abstract listen(): void;

  fds: Array<Fd>;

  constructor(fds: Array<Fd>) {
    this.fds = fds;
  }

  fd_advise(fd: number): number {
    if (this.fds[fd] != undefined) {
      return wasi.ERRNO_SUCCESS;
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  fd_allocate(fd: number, offset: bigint, len: bigint): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].fd_allocate(offset, len);
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  fd_close(fd: number): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].fd_close();
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  fd_datasync(fd: number): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].fd_sync();
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  fd_fdstat_get(fd: number): [wasi.Fdstat | undefined, number] {
    if (this.fds[fd] != undefined) {
      const { ret, fdstat } = this.fds[fd].fd_fdstat_get();
      if (fdstat != null) {
        return [fdstat, ret];
      }
    }
    return [undefined, wasi.ERRNO_BADF];
  }
}
