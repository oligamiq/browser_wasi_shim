import { Fd } from "../fd.js";
import * as wasi from "../wasi_defs.js";
import { Allocator } from "./allocator.js";
import { WASIFarmRef } from "./ref.js";

const fd_func_sig_size: number = 18;

export class WASIFarmPark {
  // This is copy
  args: Array<string>;
  // This is copy
  env: Array<string>;
  // This is Proxy
  fds: Array<Fd>;

  allocator: Allocator;

  // args, envは変更されないので、コピーで良い
  // fdsに依存しない関数は飛ばす
  // wasm32なので、pointerはu32
  // errnoはu8
  // https://github.com/WebAssembly/WASI/blob/4feaf733e946c375b610cc5d39ea2e1a68046e62/legacy/preview1/docs.md
  // 一つ目は関数シグネチャ、二つ目が存在する場合はParkにおいて通信しなければならないデータを表している。同じ場合は書いていない。
  // ここから、fdへの直接のアクセス
  // fd_advise: (fd: u32, offset: u64, len: u64, advice: u8) => errno;
  //    (fd: u32) => errno;
  // fd_allocate: (fd: u32, offset: u64, len: u64) => errno;
  // fd_close: (fd: u32) => errno;
  // fd_datasync: (fd: u32) => errno;
  // fd_fdstat_get: (fd: u32, fdstat_ptr: pointer) => errno;
  //    (fd: u32) => [wasi.Fdstat(u32 * 6)], errno];
  // fd_fdstat_set_flags: (fd: u32, flags: u16) => errno;
  // fd_fdstat_set_rights: (fd: u32, fs_rights_base: u64, fs_rights_inheriting: u64) => errno;
  // fd_filestat_get: (fd: u32, filestat_ptr: pointer) => errno;
  //    (fd: u32) => [wasi.Filestat(u32 * 16)], errno];
  // fd_filestat_set_size: (fd: u32, size: u64) => errno;
  // fd_filestat_set_times: (fd: u32, atim: u64, mtim: u64, fst_flags: u16) => errno;
  // fd_pread: (fd: u32, iovs_ptr: pointer, iovs_len: u32, offset: u64) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, iovs_ptr: pointer, iovs_len: u32, offset: u64) => [u32, errno];
  // fd_prestat_get: (fd: u32, prestat_ptr: pointer) => errno;
  //    (fd: u32) => [wasi.Prestat(u32 * 2)], errno];
  // fd_prestat_dir_name: (fd: u32, path_ptr: pointer, path_len: u32) => errno;
  //    (fd: u32, path_len: u32) => [path_ptr: pointer, path_len: u32, errno];
  // fd_pwrite: (fd: u32, iovs_ptr: pointer, iovs_len: u32, offset: u64) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, write_data: pointer, write_data_len: u32, offset: u64) => [u32, errno];
  // fd_read: (fd: u32, iovs_ptr: pointer, iovs_len: u32) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, iovs_ptr: pointer, iovs_len: u32) => [u32, errno];
  // fd_readdir: (fd: u32, buf_ptr: pointer, buf_len: u32, cookie: u64) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, buf_len: u32, cookie: u64) => [buf_ptr: pointer, buf_len: u32, errno];
  // fd_renumber: (fd: u32, to: u32) => errno;
  // fd_seek: (fd: u32, offset: i64, whence: u8) => [u64, errno];
  // fd_sync: (fd: u32) => errno;
  // fd_tell: (fd: u32) => [u64, errno];
  // fd_write: (fd: u32, iovs_ptr: pointer, iovs_len: u32) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, write_data: pointer, write_data_len: u32) => [u32, errno];
  // path_create_directory: (fd: u32, path_ptr: pointer, path_len: u32) => errno;
  // path_filestat_get: (fd: u32, flags: u32, path_ptr: pointer, path_len: u32) => [wasi.Filestat(u32 * 16), errno];
  // path_filestat_set_times: (fd: u32, flags: u32, path_ptr: pointer, path_len: u32, atim: u64, mtim: u64, fst_flags: u16) => errno;
  // path_link: (old_fd: u32, old_flags: u32, old_path_ptr: pointer, old_path_len: u32, new_fd: u32, new_path_ptr: pointer, new_path_len: u32) => errno;
  // path_open: (fd: u32, dirflags: u32, path_ptr: pointer, path_len: u32, oflags: u32, fs_rights_base: u64, fs_rights_inheriting: u64, fs_flags: u16, fdflags: u16) => [u32, errno];
  // note: fdsにpushするが、既存のfdに影響しないので、競合しない。
  // path_readlink: (fd: u32, path_ptr: pointer, path_len: u32, buf_ptr: pointer, buf_len: u32) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, path_ptr: pointer, path_len: u32, buf_len: u32) => [buf_ptr: pointer, size: u32, errno];
  // path_remove_directory: (fd: u32, path_ptr: pointer, path_len: u32) => errno;
  // path_rename: (old_fd: u32, old_path_ptr: pointer, old_path_len: u32, new_fd: u32, new_path_ptr: pointer, new_path_len: u32) => errno;
  // path_symlink: (old_path_ptr: pointer, old_path_len: u32, fd: u32, new_path_ptr: pointer, new_path_len: u32) => errno;
  // path_unlink_file: (fd: u32, path_ptr: pointer, path_len: u32) => errno;

  // fdを使いたい際に、ロックする
  // [lock, call_func]
  lock_fds: SharedArrayBuffer;
  // 一番大きなサイズはu32 * 16 + 1
  // Alignが面倒なので、u32 * 16 + 4にする
  // つまり1個のサイズは68byte

  fd_func_sig: SharedArrayBuffer;
  constructor([args, env, fds]: [Array<string>, Array<string>, Array<Fd>]) {
    this.args = args;
    this.env = env;
    this.fds = fds;

    const fds_len = fds.length;
    this.allocator = new Allocator();
    this.lock_fds = new SharedArrayBuffer(4 * fds_len * 2);
    this.fd_func_sig = new SharedArrayBuffer(fd_func_sig_size * 4 * fds_len);
  }

  /// これをpostMessageで送る
  get_ref(): WASIFarmRef {
    return new WASIFarmRef(
      this.allocator,
      this.lock_fds,
      this.fd_func_sig,
    );
  }

  /// listener
  listen() {

  }

  // workerでインスタンス化するより先に呼び出す
  async listen_fd(fd_n: number) {
    const lock_view = new Int32Array(this.lock_fds);
    const func_sig_view_u8 = new Uint8Array(this.fd_func_sig);
    const func_sig_view_u16 = new Uint16Array(this.fd_func_sig);
    const func_sig_view_i32 = new Int32Array(this.fd_func_sig);
    const func_sig_view_u32 = new Int32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u8_offset = fd_n * fd_func_sig_size * 4;
    const fd_func_sig_u16_offset = fd_n * fd_func_sig_size * 2;
    const fd_func_sig_i32_offset = fd_n * fd_func_sig_size;
    const fd_func_sig_u32_offset = fd_n * fd_func_sig_size;
    const fd_func_sig_u64_offset = fd_n * Math.round(fd_func_sig_size / 2)
    const errno_offset = fd_func_sig_i32_offset + (fd_func_sig_size - 1);
    const lock_offset = fd_n * 2;
    Atomics.store(lock_view, lock_offset, 0);
    Atomics.store(func_sig_view_i32, fd_func_sig_i32_offset + errno_offset, -1);

    loop: while (true) {
      try {
        let lock: "not-equal" | "timed-out" | "ok";
        const { value } = Atomics.waitAsync(lock_view, lock_offset + 1, 0);
        if ( value instanceof Promise) {
          lock = await value;
        } else {
          lock = value;
        }
        if (lock === "timed-out") {
          throw new Error("timed-out");
        }

        const old = Atomics.exchange(lock_view, lock_offset + 1, 0);
        if (old !== 1) {
          throw new Error("Call is already set");
        }

        const set_error = (errno: number) => {
          const old = Atomics.exchange(func_sig_view_i32, fd_func_sig_i32_offset + errno_offset, errno);
          if (old !== -1) {
            throw new Error("Error is already set");
          }
          Atomics.notify(func_sig_view_i32, fd_func_sig_i32_offset + errno_offset);
        }

        const func_number = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
        switch (func_number) {
          // fd_advise: (fd: u32) => errno;
          case 7: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            if (this.fds[fd] != undefined) {
              set_error(wasi.ERRNO_SUCCESS);
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_allocate: (fd: u32, offset: u64, len: u64) => errno;
          case 8: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);
            const len = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);

            if (this.fds[fd] != undefined) {
              set_error(this.fds[fd].fd_allocate(offset, len));
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_close: (fd: u32) => errno;
          case 9: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            if (this.fds[fd] != undefined) {
              set_error(this.fds[fd].fd_close());
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_datasync: (fd: u32) => errno;
          case 10: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            if (this.fds[fd] != undefined) {
              set_error(this.fds[fd].fd_sync());
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_fdstat_get: (fd: u32) => [wasi.Fdstat(u32 * 6)], errno];
          case 11: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            if (this.fds[fd] != undefined) {
              const { ret, fdstat } = this.fds[fd].fd_fdstat_get();
              if (fdstat != null) {
                Atomics.store(func_sig_view_u8, fd_func_sig_u8_offset, fdstat.fs_filetype);
                Atomics.store(func_sig_view_u16, fd_func_sig_u16_offset + 2, fdstat.fs_flags);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 1, fdstat.fs_rights_base);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 2, fdstat.fs_rights_inherited);
              }
              set_error(ret);
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_fdstat_set_flags: (fd: u32, flags: u16) => errno;
          case 12: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const flags = Atomics.load(func_sig_view_u16, fd_func_sig_u16_offset + 4);

            if (this.fds[fd] != undefined) {
              set_error(this.fds[fd].fd_fdstat_set_flags(flags));
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_fdstat_set_rights: (fd: u32, fs_rights_base: u64, fs_rights_inheriting: u64) => errno;
          case 13: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const fs_rights_base = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);
            const fs_rights_inheriting = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);

            if (this.fds[fd] != undefined) {
              set_error(this.fds[fd].fd_fdstat_set_rights(fs_rights_base, fs_rights_inheriting));
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_filestat_get: (fd: u32) => [wasi.Filestat(u32 * 16)], errno];
          case 14: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            if (this.fds[fd] != undefined) {
              const { ret, filestat } = this.fds[fd].fd_filestat_get();
              if (filestat != null) {
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset, filestat.dev);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 1, filestat.ino);
                Atomics.store(func_sig_view_u8, fd_func_sig_u8_offset + 16, filestat.filetype);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 3, filestat.nlink);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 4, filestat.size);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 5, filestat.atim);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 6, filestat.mtim);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 7, filestat.ctim);
              }
              set_error(ret);
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_filestat_set_size: (fd: u32, size: u64) => errno;
          case 15: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const size = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);

            if (this.fds[fd] != undefined) {
              set_error(this.fds[fd].fd_filestat_set_size(size));
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_filestat_set_times: (fd: u32, atim: u64, mtim: u64, fst_flags: u16) => errno;
          case 16: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const atim = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);
            const mtim = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);
            const fst_flags = Atomics.load(func_sig_view_u16, fd_func_sig_u16_offset + 12);

            if (this.fds[fd] != undefined) {
              set_error(this.fds[fd].fd_filestat_set_times(atim, mtim, fst_flags));
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_pread: (fd: u32, iovs_ptr: pointer, iovs_len: u32, offset: u64) => [u32, errno];
          case 17: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const iovs_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const iovs_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            let offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);
            const data = new Uint32Array(this.allocator.get_memory(iovs_ptr, iovs_len * 8));

            if (this.fds[fd] != undefined) {
              const iovecs = new Array<wasi.Iovec>();
              for (let i = 0; i < iovs_len; i++) {
                const iovec = new wasi.Iovec();
                iovec.buf = data[i * 2];
                iovec.buf_len = data[i * 2 + 1];
                iovecs.push(iovec);
              }

              let nread = 0;
              const set_size = (size: number) => {
                Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, size);
              }
              const set_data = (data: Uint8Array) => {
                this.allocator.use_defined_memory(iovs_ptr, iovs_len * 8, data);
              }
              const sum_len = iovecs.reduce((acc, iovec) => acc + iovec.buf_len, 0);
              const buffer8 = new Uint8Array(sum_len);
              for (const iovec of iovecs) {
                const { ret, data } = this.fds[fd].fd_pread(iovec.buf_len, offset);
                if (ret != wasi.ERRNO_SUCCESS) {
                  set_size(nread);
                  set_data(buffer8);
                  set_error(ret);
                  continue loop;
                }
                buffer8.set(data, nread);
                nread += data.length;
                offset += BigInt(data.length);
                if (data.length != iovec.buf_len) {
                  break;
                }
              }
              set_size(nread);
              set_data(buffer8);
              set_error(wasi.ERRNO_SUCCESS);
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_prestat_get: (fd: u32) => [wasi.Prestat(u32 * 2)], errno];
          case 18: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            if (this.fds[fd] != undefined) {
              const { ret, prestat } = this.fds[fd].fd_prestat_get();
              if (prestat != null) {
                Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, prestat.tag);
                Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, prestat.inner.pr_name.byteLength);
              }
              set_error(ret);
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_prestat_dir_name: (fd: u32, path_len: u32) => [path_ptr: pointer, path_len: u32, errno];
          case 19: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            if (this.fds[fd] != undefined) {
              const { ret, prestat } = this.fds[fd].fd_prestat_get();
              if (prestat == null) {
                set_error(ret);
                continue loop;
              }
              const prestat_dir_name = prestat.inner.pr_name;
              await this.allocator.async_write(prestat_dir_name, this.fd_func_sig, fd_func_sig_i32_offset);

              set_error(prestat_dir_name.byteLength > path_len ? wasi.ERRNO_NAMETOOLONG : wasi.ERRNO_SUCCESS);
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_pwrite: (fd: u32, write_data: pointer, write_data_len: u32, offset: u64) => [u32, errno];
          case 20: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const write_data_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const write_data_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);

            const set_size = (size: number) => {
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, size);
            }

            if (this.fds[fd] != undefined) {
              const data = new Uint8Array(this.allocator.get_memory(write_data_ptr, write_data_len));
              const { ret, nwritten } = this.fds[fd].fd_pwrite(data, offset);
              set_size(nwritten);
              set_error(ret);
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          // fd_read: (fd: u32, iovs_ptr: pointer, iovs_len: u32) => [u32, errno];
          case 21: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const iovs_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const iovs_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const data = new Uint32Array(this.allocator.get_memory(iovs_ptr, iovs_len * 8));

            const set_size = (size: number) => {
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, size);
            }

            if (this.fds[fd] != undefined) {
              const iovecs = new Array<wasi.Iovec>();
              for (let i = 0; i < iovs_len; i++) {
                const iovec = new wasi.Iovec();
                iovec.buf = data[i * 2];
                iovec.buf_len = data[i * 2 + 1];
                iovecs.push(iovec);
              }

              let nread = 0;
              const set_data = (data: Uint8Array) => {
                this.allocator.use_defined_memory(iovs_ptr, iovs_len * 8, data);
              }
              const sum_len = iovecs.reduce((acc, iovec) => acc + iovec.buf_len, 0);
              const buffer8 = new Uint8Array(sum_len);
              for (const iovec of iovecs) {
                const { ret, data } = this.fds[fd].fd_read(iovec.buf_len);
                if (ret != wasi.ERRNO_SUCCESS) {
                  set_size(nread);
                  set_data(buffer8);
                  set_error(ret);
                  continue loop;
                }
                buffer8.set(data, nread);
                nread += data.length;
                if (data.length != iovec.buf_len) {
                  break;
                }
              }
              set_size(nread);
              set_data(buffer8);
              set_error(wasi.ERRNO_SUCCESS);
              continue loop;
            } else {
              set_error(wasi.ERRNO_BADF);
              continue loop;
            }
          }
          default: {
            throw new Error("Unknown function");
          }
        }
      } catch (e) {
        console.error(e);

        const lock_view = new Int32Array(this.lock_fds);
        Atomics.exchange(lock_view, fd_n, 0);
        const func_sig_view = new Int32Array(this.fd_func_sig);
        Atomics.exchange(func_sig_view, fd_func_sig_i32_offset + 16, -1);

        continue loop;
      }
    }
  }
}
