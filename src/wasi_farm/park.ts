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
      return [undefined, ret];
    }
    return [undefined, wasi.ERRNO_BADF];
  }

  fd_fdstat_set_flags(fd: number, flags: number): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].fd_fdstat_set_flags(flags);
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  fd_fdstat_set_rights(fd: number, fs_rights_base: bigint, fs_rights_inheriting: bigint): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].fd_fdstat_set_rights(fs_rights_base, fs_rights_inheriting);
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  fd_filestat_get(fd: number): [wasi.Filestat | undefined, number] {
    if (this.fds[fd] != undefined) {
      const { ret, filestat } = this.fds[fd].fd_filestat_get();
      if (filestat != null) {
        return [filestat, ret];
      }
      return [undefined, ret];
    }
    return [undefined, wasi.ERRNO_BADF];
  }

  fd_filestat_set_size(fd: number, size: bigint): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].fd_filestat_set_size(size);
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  fd_filestat_set_times(fd: number, atim: bigint, mtim: bigint, fst_flags: number): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].fd_filestat_set_times(atim, mtim, fst_flags);
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  fd_pread(fd: number, iovs: Uint32Array, iovs_len: number, offset: bigint): [[number, Uint8Array] | undefined, number] {
    if (this.fds[fd] != undefined) {
      const iovecs = new Array<wasi.Iovec>();
      for (let i = 0; i < iovs_len; i++) {
        const iovec = new wasi.Iovec();
        iovec.buf = iovs[i * 2];
        iovec.buf_len = iovs[i * 2 + 1];
        iovecs.push(iovec);
      }

      let nread = 0;

      const sum_len = iovecs.reduce((acc, iovec) => acc + iovec.buf_len, 0);
      const buffer8 = new Uint8Array(sum_len);
      for (const iovec of iovecs) {
        const { ret, data } = this.fds[fd].fd_pread(iovec.buf_len, offset);
        if (ret != wasi.ERRNO_SUCCESS) {
          return [[nread, data], ret];
        }
        buffer8.set(data, nread);
        nread += data.length;
        offset += BigInt(data.length);
        if (data.length != iovec.buf_len) {
          break;
        }
      }
      return [[nread, buffer8], wasi.ERRNO_SUCCESS];
    } else {
      return [undefined, wasi.ERRNO_BADF];
    }
  }
}
