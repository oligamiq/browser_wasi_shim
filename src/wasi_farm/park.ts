import { Fd } from "../fd.js";
import { WASIFarmRef } from "./ref.js";
import * as wasi from "../wasi_defs.js";
import { debug } from "../debug.js";

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

  fd_pread(fd: number, iovecs: Array<wasi.Iovec>, offset: bigint): [[number, Uint8Array] | undefined, number] {
    if (this.fds[fd] != undefined) {
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

  fd_prestat_get(fd: number): [wasi.Prestat | undefined, number] {
    if (this.fds[fd] != undefined) {
      const { ret, prestat } = this.fds[fd].fd_prestat_get();
      if (prestat != null) {
        return [prestat, ret];
      }
      return [undefined, ret];
    }
    return [undefined, wasi.ERRNO_BADF];
  }

  fd_prestat_dir_name(fd: number, path_len: number): [Uint8Array | undefined, number] {
    if (this.fds[fd] != undefined) {
      const { ret, prestat } = this.fds[fd].fd_prestat_get();
      if (prestat) {
        const prestat_dir_name = prestat.inner.pr_name;

        if (prestat_dir_name.length < path_len) {
          return [prestat_dir_name, ret];
        }

        return [prestat_dir_name.slice(0, path_len), wasi.ERRNO_NAMETOOLONG];
      }
      return [undefined, ret];
    }
    return [undefined, wasi.ERRNO_BADF];
  }

  fd_pwrite(fd: number, write_data: Uint8Array, offset: bigint): [number | undefined, number] {
    if (this.fds[fd] != undefined) {
      const { ret, nwritten } = this.fds[fd].fd_pwrite(write_data, offset);
      return [nwritten, ret];
    } else {
      return [undefined, wasi.ERRNO_BADF];
    }
  }

  fd_read(fd: number, iovecs: Array<wasi.Iovec>): [[number, Uint8Array] | undefined, number] {
    if (this.fds[fd] != undefined) {
      let nread = 0;

      const sum_len = iovecs.reduce((acc, iovec) => acc + iovec.buf_len, 0);
      const buffer8 = new Uint8Array(sum_len);
      for (const iovec of iovecs) {
        const { ret, data } = this.fds[fd].fd_read(iovec.buf_len);
        if (ret != wasi.ERRNO_SUCCESS) {
          return [[nread, data], ret];
        }
        buffer8.set(data, nread);
        nread += data.length;
        if (data.length != iovec.buf_len) {
          break;
        }
      }
      return [[nread, buffer8], wasi.ERRNO_SUCCESS];
    } else {
      return [undefined, wasi.ERRNO_BADF];
    }
  }

  fd_readdir(fd: number, buf_len: number, cookie: bigint): [[Uint8Array, number] | undefined, number] {
    if (this.fds[fd] != undefined) {
      const array = new Uint8Array(buf_len);

      let buf_used = 0;
      let offset = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { ret, dirent } = this.fds[fd].fd_readdir_single(cookie);
        if (ret != wasi.ERRNO_SUCCESS) {
          return [[array, buf_used], ret];
        }
        if (dirent == null) {
          break;
        }
        if (buf_len - buf_used < dirent.head_length()) {
          buf_used = buf_len;
          break;
        }

        const head_bytes = new ArrayBuffer(dirent.head_length());
        dirent.write_head_bytes(new DataView(head_bytes), 0);
        array.set(
          new Uint8Array(head_bytes).slice(
            0,
            Math.min(head_bytes.byteLength, buf_len - buf_used),
          ),
          offset,
        );
        offset += head_bytes.byteLength;
        buf_used += head_bytes.byteLength;

        if (buf_len - buf_used < dirent.name_length()) {
          buf_used = buf_len;
          break;
        }

        dirent.write_name_bytes(array, offset, buf_len - buf_used);
        offset += dirent.name_length();
        buf_used += dirent.name_length();

        cookie = dirent.d_next;
      }

      return [[array, buf_used], wasi.ERRNO_SUCCESS];
    } else {
      return [undefined, wasi.ERRNO_BADF];
    }
  }

  fd_seek(fd: number, offset: bigint, whence: number): [bigint | undefined, number] {
    if (this.fds[fd] != undefined) {
      const { ret, offset: new_offset } = this.fds[fd].fd_seek(offset, whence);
      return [new_offset, ret];
    } else {
      return [undefined, wasi.ERRNO_BADF];
    }
  }

  fd_sync(fd: number): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].fd_sync();
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  fd_tell(fd: number): [bigint | undefined, number] {
    if (this.fds[fd] != undefined) {
      const { ret, offset } = this.fds[fd].fd_tell();
      return [offset, ret];
    } else {
      return [undefined, wasi.ERRNO_BADF];
    }
  }

  fd_write(fd: number, write_data: Uint8Array): [number | undefined, number] {
    if (this.fds[fd] != undefined) {
      const { ret, nwritten } = this.fds[fd].fd_write(write_data);
      return [nwritten, ret];
    } else {
      return [undefined, wasi.ERRNO_BADF];
    }
  }

  path_create_directory(fd: number, path: string): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].path_create_directory(path);
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  path_filestat_get(fd: number, flags: number, path: string): [wasi.Filestat | undefined, number] {
    if (this.fds[fd] != undefined) {
      const { ret, filestat } = this.fds[fd].path_filestat_get(flags, path);
      if (filestat != null) {
        return [filestat, ret];
      }
      return [undefined, ret];
    }
    return [undefined, wasi.ERRNO_BADF];
  }

  path_filestat_set_times(fd: number, flags: number, path: string, atim: bigint, mtim: bigint, fst_flags: number): number {
    if (this.fds[fd] != undefined) {
      return this.fds[fd].path_filestat_set_times(flags, path, atim, mtim, fst_flags);
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  path_link(old_fd: number, old_flags: number, old_path: string, new_fd: number, new_path: string): number {
    if (this.fds[old_fd] != undefined && this.fds[new_fd] != undefined) {
      const { ret, inode_obj } = this.fds[old_fd].path_lookup(
        old_path,
        old_flags,
      );
      if (inode_obj == null) {
        return ret;
      }
      return this.fds[new_fd].path_link(new_path, inode_obj, false);
    } else {
      return wasi.ERRNO_BADF;
    }
  }

  path_open(
    fd: number,
    dirflags: number,
    path: string,
    oflags: number,
    fs_rights_base: bigint,
    fs_rights_inheriting: bigint,
    fs_flags: number,
  ): [number | undefined, number] {
    if (this.fds[fd] != undefined) {
      debug.log("path_open", path);
      const { ret, fd_obj } = this.fds[fd].path_open(
        dirflags,
        path,
        oflags,
        fs_rights_base,
        fs_rights_inheriting,
        fs_flags,
      );
      if (ret != wasi.ERRNO_SUCCESS) {
        return [undefined, ret];
      }
      const len = this.fds.push(fd_obj);
      const opened_fd = len - 1;
      return [opened_fd, wasi.ERRNO_SUCCESS];
    } else {
      return [undefined, wasi.ERRNO_BADF];
    }
  }
}
