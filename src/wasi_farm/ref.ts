import { wasi } from "../index.js";
import { Allocator } from "./allocator.js";
import { fd_func_sig_size } from "./park.js";

export class WASIFarmRef {
  allocator: Allocator;
  lock_fds: SharedArrayBuffer;
  fd_func_sig: SharedArrayBuffer;

  constructor(
    allocator: Allocator,
    lock_fds: SharedArrayBuffer,
    fd_func_sig: SharedArrayBuffer,
  ) {
    this.allocator = allocator;
    this.lock_fds = lock_fds;
    this.fd_func_sig = fd_func_sig;
  }

  lock_fd(fd: number) {
    const view = new Int32Array(this.lock_fds);
    while (true) {
      const now_value = Atomics.load(view, fd * 2);
      const value = Atomics.wait(view, fd * 2, now_value);
      if (value === "timed-out") {
        console.error("lock_fd timed-out");
        continue;
      }
      const old = Atomics.exchange(view, fd * 2, 1);
      if (old === 0) {
        return;
      }
    }
  }

  release_fd(fd: number) {
    const view = new Int32Array(this.lock_fds);
    Atomics.store(view, fd * 2, 0);
    Atomics.notify(view, fd * 2, 1);
  }

  lock_double_fd(fd1: number, fd2: number) {
    const view = new Int32Array(this.lock_fds);
    while (true) {
      const now_value1 = Atomics.load(view, fd1 * 2);
      const value = Atomics.wait(view, fd1 * 2, now_value1);
      if (value === "timed-out") {
        console.error("lock_double_fd timed-out");
        continue;
      }
      const old1 = Atomics.exchange(view, fd1 * 2, 2);
      if (old1 === 0) {
        const now_value2 = Atomics.load(view, fd2 * 2);
        if (now_value2 === 2) {
          // It's nearly deadlocked.
          if (fd1 < fd2) {
            // release fd1
            Atomics.store(view, fd1 * 2, 0);
            Atomics.notify(view, fd1 * 2, 1);
            continue;
          }
        }
        const value = Atomics.wait(view, fd2 * 2, now_value2);
        if (value === "timed-out") {
          console.error("lock_double_fd timed-out");
          continue;
        }
        const old2 = Atomics.exchange(view, fd2 * 2, 2);
        if (old2 === 0) {
          return;
        }
        Atomics.store(view, fd1 * 2, 0);
        Atomics.notify(view, fd1 * 2, 1);
      }
    }
  }

  release_double_fd(fd1: number, fd2: number) {
    const view = new Int32Array(this.lock_fds);
    Atomics.store(view, fd1 * 2, 0);
    Atomics.notify(view, fd1 * 2, 1);
    Atomics.store(view, fd2 * 2, 0);
    Atomics.notify(view, fd2 * 2, 1);
  }

  invoke_fd_func(fd: number) {
    const view = new Int32Array(this.fd_func_sig);
    const old = Atomics.exchange(view, fd * 2 + 1, 1);
    if (old === 1) {
      console.error("invoke_fd_func already invoked");
      return;
    }
    const n = Atomics.notify(view, fd * 2 + 1);
    if (n !== 1) {
      console.error("invoke_fd_func notify failed. parent process num is not 1");
    }
  }

  wait_fd_func(fd: number) {
    const view = new Int32Array(this.fd_func_sig);
    const value = Atomics.wait(view, fd * 2 + 1, 1);
    if (value === "timed-out") {
      console.error("wait call park_fd_func timed-out");
    }
  }

  call_fd_func(fd: number) {
    this.invoke_fd_func(fd);
    this.wait_fd_func(fd);
  }

  get_error(fd: number): number {
    const func_sig_view_i32 = new Int32Array(this.fd_func_sig);
    const fd_func_sig_i32_offset = fd * fd_func_sig_size;
    const errno_offset = fd_func_sig_i32_offset + (fd_func_sig_size - 1);
    return Atomics.load(func_sig_view_i32, errno_offset);
  }

  fd_advise(
    fd: number,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 7);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_allocate(
    fd: number,
    offset: bigint,
    len: bigint,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 8);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 1, offset);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 2, len);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_close(
    fd: number,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 9);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_datasync(
    fd: number,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 10);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_fdstat_get(
    fd: number,
    buf: bigint,
  ): [wasi.Fdstat | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u8 = new Uint8Array(this.fd_func_sig);
    const func_sig_view_u16 = new Uint16Array(this.fd_func_sig);
    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u8_offset = fd * fd_func_sig_size * 4;
    const fd_func_sig_u16_offset = fd * fd_func_sig_size * 2;
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 11);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    if (error !== wasi.ERRNO_SUCCESS) {
      this.release_fd(fd);
      return [undefined, error];
    }

    const fs_filetype = Atomics.load(func_sig_view_u8, fd_func_sig_u8_offset);
    const fs_flags = Atomics.load(func_sig_view_u16, fd_func_sig_u16_offset + 2);
    const fs_rights_base = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);
    const fs_rights_inheriting = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 2);

    this.release_fd(fd);

    const fd_stat = new wasi.Fdstat(
      fs_filetype,
      fs_flags,
    );
    fd_stat.fs_rights_base = fs_rights_base;
    fd_stat.fs_rights_inherited = fs_rights_inheriting;

    return [fd_stat, error];
  }

  fd_fdstat_set_flags(
    fd: number,
    flags: number,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u16 = new Uint16Array(this.fd_func_sig);
    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u16_offset = fd * fd_func_sig_size * 2;
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 12);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u32, fd_func_sig_u16_offset + 4, flags);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_fdstat_set_rights(
    fd: number,
    fs_rights_base: bigint,
    fs_rights_inheriting: bigint,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd * fd_func_sig_size / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 13);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 1, fs_rights_base);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 2, fs_rights_inheriting);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_filestat_get(
    fd: number,
    buf: bigint,
  ): [wasi.Filestat | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u8 = new Uint8Array(this.fd_func_sig);
    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u8_offset = fd * fd_func_sig_size * 4;
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 14);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    if (error !== wasi.ERRNO_SUCCESS) {
      this.release_fd(fd);
      return [undefined, error];
    }

    const fs_dev = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset);
    const fs_ino = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 1);
    const fs_filetype = Atomics.load(func_sig_view_u8, fd_func_sig_u8_offset + 16);
    const fs_nlink = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 3);
    const fs_size = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 4);
    const fs_atim = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 5);
    const fs_mtim = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 6);
    const fs_ctim = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset + 7);

    this.release_fd(fd);

    const file_stat = new wasi.Filestat(
        fs_filetype, fs_size
    );
    file_stat.dev = fs_dev;
    file_stat.ino = fs_ino;
    file_stat.nlink = fs_nlink;
    file_stat.atim = fs_atim;
    file_stat.mtim = fs_mtim;
    file_stat.ctim = fs_ctim;

    return [file_stat, error];
  }

  fd_filestat_set_size(
    fd: number,
    size: bigint,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 15);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 1, size);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_filestat_set_times(
    fd: number,
    st_atim: bigint,
    st_mtim: bigint,
    fst_flags: number,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u16 = new Uint16Array(this.fd_func_sig);
    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u16_offset = fd * fd_func_sig_size * 2;
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 16);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 1, st_atim);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 2, st_mtim);
    Atomics.store(func_sig_view_u16, fd_func_sig_u16_offset + 12, fst_flags);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_pread(
    fd: number,
    iovs: Uint32Array,
    offset: bigint,
  ): [[number, Uint8Array] | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 17);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    this.allocator.block_write(iovs, this.fd_func_sig, fd_func_sig_u32_offset + 2);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 4, iovs.length);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 3, offset);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    const nread = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const buf_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
    const buf_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
    this.release_fd(fd);

    if (error === wasi.ERRNO_BADF) {
      this.allocator.free(buf_ptr, buf_len);
      return [undefined, error];
    }

    const buf = this.allocator.get_memory(buf_ptr, buf_len);

    if (nread !== buf_len) {
      console.error("pread nread !== buf_len");
    }

    this.allocator.free(buf_ptr, buf_len);

    return [[nread, buf], error];
  }

  fd_prestat_get(
    fd: number,
  ): [[number, number] | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 18);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    if (error !== wasi.ERRNO_SUCCESS) {
      this.release_fd(fd);
      return [undefined, error];
    }

    const pr_tag = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const pr_name_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

    this.release_fd(fd);

    return [[pr_tag, pr_name_len], error];
  }

  fd_prestat_dir_name(
    fd: number,
    path_len: number,
  ): [Uint8Array | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 19);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 2, path_len);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    const ret_path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const ret_path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

    this.release_fd(fd);
    if (error !== wasi.ERRNO_SUCCESS && error !== wasi.ERRNO_NAMETOOLONG) {
      this.allocator.free(ret_path_ptr, ret_path_len);
      return [undefined, error];
    }

    const ret_path = this.allocator.get_memory(ret_path_ptr, ret_path_len);

    return [ret_path, error];
  }

  fd_pwrite(
    fd: number,
    iovs: Uint32Array,
    offset: bigint,
  ): [number | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 20);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    this.allocator.block_write(iovs, this.fd_func_sig, fd_func_sig_u32_offset + 2);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 2, offset);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    if (error === wasi.ERRNO_BADF) {
      this.release_fd(fd);
      return [undefined, error];
    }

    const nwritten = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);

    this.release_fd(fd);

    return [nwritten, error];
  }

  fd_read(
    fd: number,
    iovs: Uint32Array,
  ): [[number, Uint8Array] | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 21);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    this.allocator.block_write(iovs, this.fd_func_sig, fd_func_sig_u32_offset + 2);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 4, iovs.length);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    const nread = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const buf_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
    const buf_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
    this.release_fd(fd);

    if (error === wasi.ERRNO_BADF) {
      this.allocator.free(buf_ptr, buf_len);
      return [undefined, error];
    }

    const buf = this.allocator.get_memory(buf_ptr, buf_len);

    if (nread !== buf_len) {
      console.error("read nread !== buf_len");
    }

    this.allocator.free(buf_ptr, buf_len);

    return [[nread, buf], error];
  }

  fd_readdir(
    fd: number,
    limit_buf_len: number,
    cookie: bigint,
  ): [[Uint8Array, number] | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 22);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 2, limit_buf_len);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 2, cookie);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    const buf_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const buf_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
    const buf_used = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
    this.release_fd(fd);

    if (error === wasi.ERRNO_BADF) {
      this.allocator.free(buf_ptr, buf_len);
      return [undefined, error];
    }

    const buf = this.allocator.get_memory(buf_ptr, buf_len);

    this.allocator.free(buf_ptr, buf_len);

    return [[buf, buf_used], error];
  }

  fd_renumber(
    fd: number,
    to: number,
  ): number {
    this.lock_double_fd(fd, to);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const to_func_sig_u32_offset = to * fd_func_sig_size;

    // fd
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 23);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 2, to);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_double_fd(fd, to);

    return error;
  }

  fd_seek(
    fd: number,
    offset: bigint,
    whence: number,
  ): [bigint | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u8 = new Uint8Array(this.fd_func_sig);
    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u8_offset = fd * fd_func_sig_size * 4;
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 24);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 1, offset);
    Atomics.store(func_sig_view_u8, fd_func_sig_u8_offset + 16, whence);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    if (error === wasi.ERRNO_BADF) {
      this.release_fd(fd);
      return [undefined, error];
    }

    const new_offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset);

    this.release_fd(fd);

    return [new_offset, error];
  }

  fd_sync(
    fd: number,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 25);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_tell(
    fd: number,
  ): [bigint | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 26);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);

    this.call_fd_func(fd);

    const error = this.get_error(fd);

    if (error === wasi.ERRNO_BADF) {
      this.release_fd(fd);
      return [undefined, error];
    }

    const offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset);

    this.release_fd(fd);

    return [offset, error];
  }
}
