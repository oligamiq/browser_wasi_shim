import { Fd } from "../../fd.js";
import * as wasi from "../../wasi_defs.js";
import { Allocator } from "./allocator.js";
import { WASIFarmRef } from "../ref.js";
import { WASIFarmPark } from "../park.js";
import { WASIFarmRefUseArrayBuffer } from "./ref.js";

export const fd_func_sig_size: number = 18;

export class WASIFarmParkUseArrayBuffer extends WASIFarmPark {
  // This is Proxy
  private allocator: Allocator;

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
  //    (fd: u32, iovs_ptr: pointer, iovs_len: u32, offset: u64) => [u32, data_ptr, errno];
  // fd_prestat_get: (fd: u32, prestat_ptr: pointer) => errno;
  //    (fd: u32) => [wasi.Prestat(u32 * 2)], errno];
  // fd_prestat_dir_name: (fd: u32, path_ptr: pointer, path_len: u32) => errno;
  //    (fd: u32, path_len: u32) => [path_ptr: pointer, path_len: u32, errno];
  // fd_pwrite: (fd: u32, iovs_ptr: pointer, iovs_len: u32, offset: u64) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, write_data: pointer, write_data_len: u32, offset: u64) => [u32, errno];
  // fd_read: (fd: u32, iovs_ptr: pointer, iovs_len: u32) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, iovs_ptr: pointer, iovs_len: u32) => [u32, data_ptr, errno];
  // fd_readdir: (fd: u32, buf_ptr: pointer, buf_len: u32, cookie: u64) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, buf_len: u32, cookie: u64) => [buf_ptr: pointer, buf_len: u32, buf_used: u32, errno];
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
  // path_open: (fd: u32, dirflags: u32, path_ptr: pointer, path_len: u32, oflags: u32, fs_rights_base: u64, fs_rights_inheriting: u64, fdflags: u16) => [u32, errno];
  // note: fdsにpushするが、既存のfdに影響しないので、競合しない。
  // path_readlink: (fd: u32, path_ptr: pointer, path_len: u32, buf_ptr: pointer, buf_len: u32) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, path_ptr: pointer, path_len: u32, buf_len: u32) => [buf_len: u32, data_ptr: pointer, data_len: u32, errno];
  // path_remove_directory: (fd: u32, path_ptr: pointer, path_len: u32) => errno;
  // path_rename: (old_fd: u32, old_path_ptr: pointer, old_path_len: u32, new_fd: u32, new_path_ptr: pointer, new_path_len: u32) => errno;
  // path_symlink: (old_path_ptr: pointer, old_path_len: u32, fd: u32, new_path_ptr: pointer, new_path_len: u32) => errno;
  // path_unlink_file: (fd: u32, path_ptr: pointer, path_len: u32) => errno;

  // fdを使いたい際に、ロックする
  // [lock, call_func]
  private lock_fds: SharedArrayBuffer;
  // 一番大きなサイズはu32 * 16 + 1
  // Alignが面倒なので、u32 * 16 + 4にする
  // つまり1個のサイズは68byte

  private fds_len: SharedArrayBuffer;

  private listen_fds: Array<Promise<void>> = [];

  private fd_func_sig: SharedArrayBuffer;
  constructor(fds: Array<Fd>) {
    super(fds);

    this.allocator = new Allocator();
    const max_fds_len = 128;
    this.lock_fds = new SharedArrayBuffer(4 * max_fds_len * 2);
    this.fd_func_sig = new SharedArrayBuffer(fd_func_sig_size * 4 * max_fds_len);
    this.fds_len = new SharedArrayBuffer(4);
  }

  /// これをpostMessageで送る
  get_ref(): WASIFarmRef {
    // console.log("listen_fds", this.listen_fds);

    // const view = new Int32Array(this.lock_fds);
    // for (let n = 0; n < this.fds.length; n++) {
    //   Atomics.store(view, n * 2 + 1, 1);
    //   Atomics.notify(view, n * 2 + 1);
    // }

    // console.log("listen_fds", this.listen_fds);
    // 正常動作

    return new WASIFarmRefUseArrayBuffer(
      this.allocator,
      this.lock_fds,
      this.fd_func_sig,
      this.fds_len,
    );
  }

  private notify_push_fd(fd: number) {
    console.warn("notify_push_fd", fd);

    if (this.fds[fd] == undefined) {
      throw new Error("fd is not defined");
    }
    if (fd >= 128) {
      throw new Error("fd is too big. expand is not supported yet");
    }
    this.listen_fds.push(this.listen_fd(fd));

    const view = new Int32Array(this.fds_len);
    Atomics.add(view, 0, 1);
  }

  /// listener
  listen() {
    for (let n = 0; n < this.fds.length; n++) {
      this.listen_fds.push(this.listen_fd(n));
    }
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
    Atomics.store(lock_view, lock_offset + 1, 0);
    Atomics.store(func_sig_view_i32, fd_func_sig_i32_offset + errno_offset, -1);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        let lock: "not-equal" | "timed-out" | "ok";

        const { value } = Atomics.waitAsync(lock_view, lock_offset + 1, 0);
        if ( value instanceof Promise) {
          // console.log("listen", fd_n, lock_offset + 1);
          lock = await value;
        } else {
          lock = value;
        }
        if (lock === "timed-out") {
          throw new Error("timed-out");
        }

        // console.log("called", fd_n, lock_offset + 1);

        const set_error = (errno: number) => {
          // console.log("set_error", errno, "pointer", errno_offset);
          Atomics.store(func_sig_view_i32, errno_offset, errno);
        }

        const func_number = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);

        // console.log("func_number", func_number);

        switcher: switch (func_number) {
          // fd_advise: (fd: u32) => errno;
          case 7: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            const error = this.fd_advise(fd);

            set_error(error);
            break switcher;
          }
          // fd_allocate: (fd: u32, offset: u64, len: u64) => errno;
          case 8: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);
            const len = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);

            const error = this.fd_allocate(fd, offset, len);

            set_error(error);
            break switcher;
          }
          // fd_close: (fd: u32) => errno;
          case 9: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            const error = this.fd_close(fd);

            set_error(error);
            break switcher;
          }
          // fd_datasync: (fd: u32) => errno;
          case 10: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            const error = this.fd_datasync(fd);

            set_error(error);
            break switcher;
          }
          // fd_fdstat_get: (fd: u32) => [wasi.Fdstat(u32 * 6)], errno];
          case 11: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            const [ fdstat, ret ] = this.fd_fdstat_get(fd);

            if (fdstat) {
                Atomics.store(func_sig_view_u8, fd_func_sig_u8_offset, fdstat.fs_filetype);
                Atomics.store(func_sig_view_u16, fd_func_sig_u16_offset + 2, fdstat.fs_flags);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 1, fdstat.fs_rights_base);
                Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 2, fdstat.fs_rights_inherited);
            }
            set_error(ret);
            break switcher;
          }
          // fd_fdstat_set_flags: (fd: u32, flags: u16) => errno;
          case 12: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const flags = Atomics.load(func_sig_view_u16, fd_func_sig_u16_offset + 4);

            const error = this.fd_fdstat_set_flags(fd, flags);

            set_error(error);
            break switcher;
          }
          // fd_fdstat_set_rights: (fd: u32, fs_rights_base: u64, fs_rights_inheriting: u64) => errno;
          case 13: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const fs_rights_base = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);
            const fs_rights_inheriting = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);

            const error = this.fd_fdstat_set_rights(fd, fs_rights_base, fs_rights_inheriting);

            set_error(error);
            break switcher;
          }
          // fd_filestat_get: (fd: u32) => [wasi.Filestat(u32 * 16)], errno];
          case 14: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            const [ filestat, ret ] = this.fd_filestat_get(fd);

            if (filestat) {
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
            break switcher;
          }
          // fd_filestat_set_size: (fd: u32, size: u64) => errno;
          case 15: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const size = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);

            const error = this.fd_filestat_set_size(fd, size);

            set_error(error);
            break switcher;
          }
          // fd_filestat_set_times: (fd: u32, atim: u64, mtim: u64, fst_flags: u16) => errno;
          case 16: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const atim = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);
            const mtim = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);
            const fst_flags = Atomics.load(func_sig_view_u16, fd_func_sig_u16_offset + 12);

            const error = this.fd_filestat_set_times(fd, atim, mtim, fst_flags);

            set_error(error);
            break switcher;
          }
          // fd_pread: (fd: u32, iovs_ptr: pointer, iovs_len: u32, offset: u64) => [u32, data_ptr, errno];
          case 17: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const iovs_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const iovs_ptr_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);
            const data = new Uint32Array(this.allocator.get_memory(iovs_ptr, iovs_ptr_len));
            this.allocator.free(iovs_ptr, iovs_ptr_len);

            const iovecs = new Array<wasi.Iovec>();
            for (let i = 0; i < iovs_ptr_len; i += 8) {
              const iovec = new wasi.Iovec();
              iovec.buf = data[i * 2];
              iovec.buf_len = data[i * 2 + 1];
              iovecs.push(iovec);
            }

            const [[nread, buffer8], error] = this.fd_pread(fd, iovecs, offset);

            if (nread !== undefined) {
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, nread);
            }
            if (buffer8) {
              await this.allocator.async_write(buffer8, this.fd_func_sig, fd_func_sig_i32_offset + 1);
            }
            set_error(error);
            break switcher;
          }
          // fd_prestat_get: (fd: u32) => [wasi.Prestat(u32 * 2)], errno];
          case 18: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            const [ prestat, ret ] = this.fd_prestat_get(fd);

            // console.log("fd_prestat_get", prestat, ret);

            if (prestat) {
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, prestat.tag);
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, prestat.inner.pr_name.byteLength);
            }
            set_error(ret);
            break switcher;
          }
          // fd_prestat_dir_name: (fd: u32, path_len: u32) => [path_ptr: pointer, path_len: u32, errno];
          case 19: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            const [ prestat_dir_name, ret ] = this.fd_prestat_dir_name(fd, path_len);

            // console.log("fd_prestat_dir_name", new TextDecoder().decode(prestat_dir_name), ret);

            if (prestat_dir_name) {
              await this.allocator.async_write(prestat_dir_name, this.fd_func_sig, fd_func_sig_i32_offset);
            }
            set_error(ret);
            break switcher;
          }
          // fd_pwrite: (fd: u32, write_data: pointer, write_data_len: u32, offset: u64) => [u32, errno];
          case 20: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const write_data_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const write_data_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);

            const data = new Uint8Array(this.allocator.get_memory(write_data_ptr, write_data_len));
            this.allocator.free(write_data_ptr, write_data_len);

            const [nwritten, error] = this.fd_pwrite(fd, data, offset);

            if (nwritten !== undefined) {
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, nwritten);
            }
            set_error(error);
            break switcher;
          }
          // fd_read: (fd: u32, iovs_ptr: pointer, iovs_len: u32) => [u32, data_ptr, errno];
          case 21: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const iovs_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const iovs_ptr_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const data = new Uint32Array(this.allocator.get_memory(iovs_ptr, iovs_ptr_len));
            this.allocator.free(iovs_ptr, iovs_ptr_len);

            const iovecs = new Array<wasi.Iovec>();
            for (let i = 0; i < iovs_ptr_len; i += 8) {
              const iovec = new wasi.Iovec();
              iovec.buf = data[i * 2];
              iovec.buf_len = data[i * 2 + 1];
              iovecs.push(iovec);
            }

            const [[nread, buffer8], error] = this.fd_read(fd, iovecs);

            if (nread !== undefined) {
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, nread);
            }
            if (buffer8) {
              await this.allocator.async_write(buffer8, this.fd_func_sig, fd_func_sig_i32_offset + 1);
            }
            set_error(error);
            break switcher;
          }
          // fd_readdir: (fd: u32, buf_len: u32, cookie: u64) => [buf_ptr: pointer, buf_len: u32, buf_used: u32, errno];
          case 22: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const buf_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const cookie = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);

            const [[array, buf_used], error] = this.fd_readdir(fd, buf_len, cookie);

            if (array) {
              await this.allocator.async_write(array, this.fd_func_sig, fd_func_sig_i32_offset);
            }
            if (buf_used !== undefined) {
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 2, buf_used);
            }
            set_error(error);
            break switcher;
          }
          // fd_seek: (fd: u32, offset: i64, whence: u8) => [u64, errno];
          case 24: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);
            const whence = Atomics.load(func_sig_view_u8, fd_func_sig_u8_offset + 16);

            const [new_offset, error] = this.fd_seek(fd, offset, whence);

            if (new_offset !== undefined) {
              Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset, new_offset);
            }
            set_error(error);
            break switcher;
          }
          // fd_sync: (fd: u32) => errno;
          case 25: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            const error = this.fd_sync(fd);

            set_error(error);
            break switcher;
          }
          // fd_tell: (fd: u32) => [u64, errno];
          case 26: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

            const [offset, error] = this.fd_tell(fd);

            if (offset !== undefined) {
              Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset, offset);
            }
            set_error(error);
            break switcher;
          }
          // fd_write: (fd: u32, write_data: pointer, write_data_len: u32) => [u32, errno];
          case 27: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const write_data_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const write_data_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);

            const data = new Uint8Array(this.allocator.get_memory(write_data_ptr, write_data_len));
            this.allocator.free(write_data_ptr, write_data_len);

            // console.log("allocator", this.allocator);

            // console.log("write_data", data);

            const [nwritten, error] = this.fd_write(fd, data);

            // console.log("fd_write: park: error", error);

            if (nwritten !== undefined) {
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, nwritten);
            }
            set_error(error);
            break switcher;
          }
          // path_create_directory: (fd: u32, path_ptr: pointer, path_len: u32) => errno;
          case 28: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);

            const path = new Uint8Array(this.allocator.get_memory(path_ptr, path_len));
            const path_str = new TextDecoder().decode(path);
            this.allocator.free(path_ptr, path_len);

            const error = this.path_create_directory(fd, path_str);

            set_error(error);
            break switcher;
          }
          // path_filestat_get: (fd: u32, flags: u32, path_ptr: pointer, path_len: u32) => [wasi.Filestat(u32 * 16), errno];
          case 29: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const flags = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 4);

            const path = new Uint8Array(this.allocator.get_memory(path_ptr, path_len));
            const path_str = new TextDecoder().decode(path);
            this.allocator.free(path_ptr, path_len);

            const [filestat, ret] = this.path_filestat_get(fd, flags, path_str);

            if (filestat) {
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
            break switcher;
          }
          // path_filestat_set_times: (fd: u32, flags: u32, path_ptr: pointer, path_len: u32, atim: u64, mtim: u64, fst_flags: u16) => errno;
          case 30: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const flags = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 4);
            const atim = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 3);
            const mtim = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 4);
            const fst_flags = Atomics.load(func_sig_view_u16, fd_func_sig_u16_offset + 12);

            const path = new Uint8Array(this.allocator.get_memory(path_ptr, path_len));
            const path_str = new TextDecoder().decode(path);
            this.allocator.free(path_ptr, path_len);

            const error = this.path_filestat_set_times(fd, flags, path_str, atim, mtim, fst_flags);

            set_error(error);
            break switcher;
          }
          // path_link: (old_fd: u32, old_flags: u32, old_path_ptr: pointer, old_path_len: u32, new_fd: u32, new_path_ptr: pointer, new_path_len: u32) => errno;
          case 31: {
            const old_fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const old_flags = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const old_path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const old_path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 4);
            const new_fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 5);
            const new_path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 6);
            const new_path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 7);

            const old_path = new Uint8Array(this.allocator.get_memory(old_path_ptr, old_path_len));
            const old_path_str = new TextDecoder().decode(old_path);
            this.allocator.free(old_path_ptr, old_path_len);
            const new_path = new Uint8Array(this.allocator.get_memory(new_path_ptr, new_path_len));
            const new_path_str = new TextDecoder().decode(new_path);
            this.allocator.free(new_path_ptr, new_path_len);

            const error = this.path_link(old_fd, old_flags, old_path_str, new_fd, new_path_str);

            set_error(error);
            break switcher;
          }
          // path_open: (fd: u32, dirflags: u32, path_ptr: pointer, path_len: u32, oflags: u32, fs_rights_base: u64, fs_rights_inheriting: u64, fdflags: u16) => [u32, errno];
          case 32: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const dirflags = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 4);
            const oflags = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 5);
            const fs_rights_base = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 3);
            const fs_rights_inheriting = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 4);
            const fd_flags = Atomics.load(func_sig_view_u16, fd_func_sig_u16_offset + 20);

            const path = new Uint8Array(this.allocator.get_memory(path_ptr, path_len));
            const path_str = new TextDecoder().decode(path);
            this.allocator.free(path_ptr, path_len);

            const [opened_fd, error] = this.path_open(fd, dirflags, path_str, oflags, fs_rights_base, fs_rights_inheriting, fd_flags);

            // console.log("path_open: opend_fd", opened_fd, error);

            if (opened_fd !== undefined) {
              this.notify_push_fd(opened_fd);
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, opened_fd);
            }
            set_error(error);
            break switcher;
          }
          // path_readlink: (fd: u32, path_ptr: pointer, path_len: u32, buf_len: u32) => [buf_len: u32, data_ptr: pointer, data_len: u32, errno];
          case 33: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const buf_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 4);

            const path = new Uint8Array(this.allocator.get_memory(path_ptr, path_len));
            const path_str = new TextDecoder().decode(path);
            this.allocator.free(path_ptr, path_len);

            const [buf, error] = this.path_readlink(fd, path_str, buf_len);

            if (buf) {
              await this.allocator.async_write(buf, this.fd_func_sig, fd_func_sig_i32_offset + 1);
              Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, buf.byteLength);
            }
            set_error(error);
            break switcher;
          }
          // path_remove_directory: (fd: u32, path_ptr: pointer, path_len: u32) => errno;
          case 34: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);

            const path = new Uint8Array(this.allocator.get_memory(path_ptr, path_len));
            const path_str = new TextDecoder().decode(path);
            this.allocator.free(path_ptr, path_len);

            const error = this.path_remove_directory(fd, path_str);

            set_error(error);
            break switcher;
          }
          // path_rename: (old_fd: u32, old_path_ptr: pointer, old_path_len: u32, new_fd: u32, new_path_ptr: pointer, new_path_len: u32) => errno;
          case 35: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const old_path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const old_path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const new_fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 4);
            const new_path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 5);
            const new_path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 6);

            const old_path = new Uint8Array(this.allocator.get_memory(old_path_ptr, old_path_len));
            const old_path_str = new TextDecoder().decode(old_path);
            this.allocator.free(old_path_ptr, old_path_len);
            const new_path = new Uint8Array(this.allocator.get_memory(new_path_ptr, new_path_len));
            const new_path_str = new TextDecoder().decode(new_path);
            this.allocator.free(new_path_ptr, new_path_len);

            const error = this.path_rename(fd, old_path_str, new_fd, new_path_str);

            set_error(error);
            break switcher;
          }
          // path_symlink: (old_path_ptr: pointer, old_path_len: u32, fd: u32, new_path_ptr: pointer, new_path_len: u32) => errno;
          case 36: {
            const old_path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const old_path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);
            const new_path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 4);
            const new_path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 5);

            const old_path = new Uint8Array(this.allocator.get_memory(old_path_ptr, old_path_len));
            const old_path_str = new TextDecoder().decode(old_path);
            this.allocator.free(old_path_ptr, old_path_len);
            const new_path = new Uint8Array(this.allocator.get_memory(new_path_ptr, new_path_len));
            const new_path_str = new TextDecoder().decode(new_path);
            this.allocator.free(new_path_ptr, new_path_len);

            set_error(this.path_symlink(old_path_str, fd, new_path_str));
            break switcher;
          }
          // path_unlink_file: (fd: u32, path_ptr: pointer, path_len: u32) => errno;
          case 37: {
            const fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
            const path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
            const path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 3);

            const path = new Uint8Array(this.allocator.get_memory(path_ptr, path_len));
            const path_str = new TextDecoder().decode(path);
            this.allocator.free(path_ptr, path_len);

            set_error(this.path_unlink_file(fd, path_str));
            break switcher;
          }
          default: {
            throw new Error("Unknown function");
          }
        }

        const old_call_lock = Atomics.exchange(lock_view, lock_offset + 1, 0);
        if (old_call_lock !== 1) {
          throw new Error("Call is already set");
        }
        const n = Atomics.notify(lock_view, lock_offset + 1);
        if (n !== 1) {
          throw new Error("notify number is not 1");
        }
      } catch (e) {
        console.error(e);

        const lock_view = new Int32Array(this.lock_fds);
        Atomics.exchange(lock_view, fd_n * 2 + 1, 0);
        const func_sig_view = new Int32Array(this.fd_func_sig);
        Atomics.exchange(func_sig_view, fd_func_sig_i32_offset + 16, -1);
      }
    }
  }
}
