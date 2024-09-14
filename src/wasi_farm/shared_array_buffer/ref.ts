import { WASIFarmRef } from "../ref.js";
import { AllocatorUseArrayBuffer } from "./allocator.js";
import { fd_func_sig_size } from "./park.js";
import * as wasi from "../../wasi_defs.js";
import { FdCloseSender } from "../sender.js";
import { FdCloseSenderUseArrayBuffer } from "./fd_close_sender.js";

export class WASIFarmRefUseArrayBuffer extends WASIFarmRef {
  allocator: AllocatorUseArrayBuffer;
  lock_fds: SharedArrayBuffer;
  // byte 1: fds_len
  // byte 2: all wasi_farm_ref num
  fds_len_and_num: SharedArrayBuffer;
  fd_func_sig: SharedArrayBuffer;
  base_func_util: SharedArrayBuffer;

  constructor(
    allocator: AllocatorUseArrayBuffer,
    lock_fds: SharedArrayBuffer,
    fds_len_and_num: SharedArrayBuffer,
    fd_func_sig: SharedArrayBuffer,
    base_func_util: SharedArrayBuffer,
    fd_close_receiver: FdCloseSender,
    stdin: number | undefined,
    stdout: number | undefined,
    stderr: number | undefined,
    default_fds: Array<number>,
  ) {
    if (fd_close_receiver instanceof FdCloseSenderUseArrayBuffer) {
      super(stdin, stdout, stderr, fd_close_receiver, default_fds);
    } else {
      super(stdin, stdout, stderr, FdCloseSenderUseArrayBuffer.init_self(
        fd_close_receiver as FdCloseSenderUseArrayBuffer
      ), default_fds);
    }
    if (allocator instanceof AllocatorUseArrayBuffer === false) {
      this.allocator = AllocatorUseArrayBuffer.init_self(allocator);
    } else {
      this.allocator = allocator;
    }
    this.lock_fds = lock_fds;
    this.fd_func_sig = fd_func_sig;
    this.base_func_util = base_func_util;
    this.fds_len_and_num = fds_len_and_num;

    const view = new Int32Array(this.fds_len_and_num);
    Atomics.store(view, 0, 0);
  }

  get_ref(): WASIFarmRef {
    return this;
  }

  get_fds_len(): number {
    const view = new Int32Array(this.fds_len_and_num);
    return Atomics.load(view, 0);
  }

  static init_self(sl: WASIFarmRefUseArrayBuffer): WASIFarmRef {
    return new WASIFarmRefUseArrayBuffer(
      sl.allocator,
      sl.lock_fds,
      sl.fds_len_and_num,
      sl.fd_func_sig,
      sl.base_func_util,
      sl.fd_close_receiver,
      sl.stdin,
      sl.stdout,
      sl.stderr,
      sl.default_fds,
    );
  }

  set_id(): number {
    const view = new Int32Array(this.fds_len_and_num);
    const id = Atomics.add(view, 1, 1);
    this.id = id;
    return id;
  }

  private lock_base_func_util(): void {
    const view = new Int32Array(this.base_func_util);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const lock = Atomics.wait(view, 0, 1);
      if (lock === "timed-out") {
        throw new Error("timed-out lock");
      }
      const old = Atomics.compareExchange(view, 0, 0, 1);
      if (old !== 0) {
        continue;
      }
      break;
    }
  }

  private call_base_func_util(): void {
    const view = new Int32Array(this.base_func_util);
    const old = Atomics.exchange(view, 1, 1);
    if (old !== 0) {
      console.error("what happened?");
    }
    Atomics.notify(view, 1, 1);
  }

  private wait_base_func_util(): void {
    const view = new Int32Array(this.base_func_util);
    const lock = Atomics.wait(view, 1, 1);
    if (lock === "timed-out") {
      throw new Error("timed-out lock");
    }
  }

  private release_base_func_util(): void {
    const view = new Int32Array(this.base_func_util);
    Atomics.store(view, 0, 0);
    Atomics.notify(view, 0, 1);
  }

  set_park_fds_map(fds: Array<number>): void {
    this.lock_base_func_util();
    const view = new Int32Array(this.base_func_util);
    Atomics.store(view, 2, 0);
    const fds_array = new Uint32Array(fds);
    // console.log("fds_array", fds_array);
    this.allocator.block_write(fds_array, this.base_func_util, 3);
    Atomics.store(view, 5, this.id);
    this.call_base_func_util();
    this.wait_base_func_util();
    this.release_base_func_util();
  }

  private lock_fd(fd: number) {
    // console.log("lock_fd start", fd);
    const view = new Int32Array(this.lock_fds);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now_value = Atomics.load(view, fd * 3);
      if (now_value !== 0) {
        const value = Atomics.wait(view, fd * 3, now_value);
        if (value === "timed-out") {
          console.error("lock_fd timed-out");
          continue;
        }
      }
      const old = Atomics.exchange(view, fd * 3, 1);
      if (old === 0) {
        // console.log("lock_fd success", fd);
        return;
      }
    }
  }

  private release_fd(fd: number) {
    // console.log("release_fd", fd);
    const view = new Int32Array(this.lock_fds);
    Atomics.store(view, fd * 3, 0);
    Atomics.notify(view, fd * 3, 1);
  }

  private lock_double_fd(fd1: number, fd2: number) {
    // console.log("lock_double_fd", fd1, fd2);
    const view = new Int32Array(this.lock_fds);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now_value1 = Atomics.load(view, fd1 * 3);
      const value = Atomics.wait(view, fd1 * 3, now_value1);
      if (value === "timed-out") {
        console.error("lock_double_fd timed-out");
        continue;
      }
      const old1 = Atomics.exchange(view, fd1 * 3, 2);
      if (old1 === 0) {
        const now_value2 = Atomics.load(view, fd2 * 3);
        if (now_value2 === 2) {
          // It's nearly deadlocked.
          if (fd1 < fd2) {
            // release fd1
            Atomics.store(view, fd1 * 3, 0);
            Atomics.notify(view, fd1 * 3, 1);
            continue;
          }
        }
        const value = Atomics.wait(view, fd2 * 3, now_value2);
        if (value === "timed-out") {
          console.error("lock_double_fd timed-out");
          continue;
        }
        const old2 = Atomics.exchange(view, fd2 * 3, 2);
        if (old2 === 0) {
          return;
        }
        Atomics.store(view, fd1 * 3, 0);
        Atomics.notify(view, fd1 * 3, 1);
      }
    }
  }

  private release_double_fd(fd1: number, fd2: number) {
    // console.log("release_double_fd", fd1, fd2);
    const view = new Int32Array(this.lock_fds);
    Atomics.store(view, fd1 * 3, 0);
    Atomics.notify(view, fd1 * 3, 1);
    Atomics.store(view, fd2 * 3, 0);
    Atomics.notify(view, fd2 * 3, 1);
  }

  private invoke_fd_func(fd: number): boolean {
    if (fd === undefined) {
      return false;
    }
    // console.log("invoke_fd_func", fd);
    const view = new Int32Array(this.lock_fds);
    const old = Atomics.exchange(view, fd * 3 + 1, 1);
    if (old === 1) {
      console.error("invoke_fd_func already invoked");
      return;
    }
    const n = Atomics.notify(view, fd * 3 + 1);
    if (n !== 1) {
      if (n === 0) {
        const len_view = new Int32Array(this.fds_len_and_num);
        const len = Atomics.load(len_view, 0);
        if (len <= fd) {
          const lock = Atomics.exchange(view, fd * 3 + 1, 0);
          if (lock !== 1) {
            console.error("what happened?");
          }
          Atomics.notify(view, fd * 3 + 1, 1);
          return false;
        } else {
          console.warn("invoke_func_loop is late");
          return true;
        }
      }
      console.error("invoke_fd_func notify failed:", n);
      return false;
    }
    return true;
  }

  private wait_fd_func(fd: number) {
    // console.log("wait_fd_func", fd);
    const view = new Int32Array(this.lock_fds);
    const value = Atomics.wait(view, fd * 3 + 1, 1);
    if (value === "timed-out") {
      console.error("wait call park_fd_func timed-out");
    }
  }

  private call_fd_func(fd: number): boolean {
    if (!this.invoke_fd_func(fd)) {
      return false;
    }
    // console.log("call_fd_func", fd);
    this.wait_fd_func(fd);
    // console.log("wait_fd_func", fd);
    // console.log("call_fd_func released", fd);
    return true;
  }

  private get_error(fd: number): number {
    const func_sig_view_i32 = new Int32Array(this.fd_func_sig);
    const fd_func_sig_i32_offset = fd * fd_func_sig_size;
    const errno_offset = fd_func_sig_i32_offset + (fd_func_sig_size - 1);
    // console.log("get_error: offset", errno_offset);
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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

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

    // console.log("fd_close: ref", fd);

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

    // console.log("fd_close: ref2", fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    // console.log("fd_close: ref3", fd);

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_fdstat_get(
    fd: number,
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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

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
    Atomics.store(func_sig_view_u16, fd_func_sig_u16_offset + 4, flags);

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  fd_filestat_get(
    fd: number,
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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

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
    const [ptr, len] = this.allocator.block_write(iovs, this.fd_func_sig, fd_func_sig_u32_offset + 2);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 2, offset);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

    const error = this.get_error(fd);

    const nread = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const buf_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
    const buf_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
    this.release_fd(fd);

    if (error === wasi.ERRNO_BADF) {
      this.allocator.free(buf_ptr, buf_len);
      return [undefined, error];
    }

    const buf = new Uint8Array(this.allocator.get_memory(buf_ptr, buf_len));

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

    const error = this.get_error(fd);

    const ret_path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const ret_path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);

    this.release_fd(fd);
    if (error !== wasi.ERRNO_SUCCESS && error !== wasi.ERRNO_NAMETOOLONG) {
      this.allocator.free(ret_path_ptr, ret_path_len);
      return [undefined, error];
    }

    const ret_path = new Uint8Array(this.allocator.get_memory(ret_path_ptr, ret_path_len));
    this.allocator.free(ret_path_ptr, ret_path_len);

    return [ret_path, error];
  }

  fd_pwrite(
    fd: number,
    write_data: Uint8Array,
    offset: bigint,
  ): [number | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 20);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    const [ptr, len] = this.allocator.block_write(write_data, this.fd_func_sig, fd_func_sig_u32_offset + 2);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 2, offset);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

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

    // console.log("fd_read: ref: iovs", iovs);
    // console.log("iovs.buffer", iovs.buffer.slice(0, iovs.byteLength));

    const [ptr, len] = this.allocator.block_write(iovs, this.fd_func_sig, fd_func_sig_u32_offset + 2);

    // console.log("fd_read: ref: iovs", iovs);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

    const error = this.get_error(fd);

    const nread = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const buf_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
    const buf_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
    this.release_fd(fd);

    // console.log("fd_read: ref: ", nread, buf_ptr, buf_len);

    if (error === wasi.ERRNO_BADF) {
      this.allocator.free(buf_ptr, buf_len);
      return [undefined, error];
    }

    // fd_read: ref:  14 30 14
    // animals.ts:325 fd_read: nread 14 Hello, world!
    // fd_read: ref:  21 52 32
    // ref.ts:655 fd_read: ref:  21
    const buf = new Uint8Array(this.allocator.get_memory(buf_ptr, buf_len));
    // console.log("fd_read: ref: ", nread, new TextDecoder().decode(buf));

    // console.log("fd_read: nread", nread, new TextDecoder().decode(buf));

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

    const error = this.get_error(fd);

    const buf_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const buf_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
    const buf_used = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);
    this.release_fd(fd);

    if (error === wasi.ERRNO_BADF) {
      this.allocator.free(buf_ptr, buf_len);
      return [undefined, error];
    }

    const buf = new Uint8Array(this.allocator.get_memory(buf_ptr, buf_len));

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

    // fd
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 23);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 2, to);

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

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

    if (!this.call_fd_func(fd)) {
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

    const error = this.get_error(fd);

    if (error === wasi.ERRNO_BADF) {
      this.release_fd(fd);
      return [undefined, error];
    }

    const offset = Atomics.load(func_sig_view_u64, fd_func_sig_u64_offset);

    this.release_fd(fd);

    return [offset, error];
  }

  fd_write(
    fd: number,
    write_data: Uint8Array,
  ): [number | undefined, number] {
    this.lock_fd(fd);

    // console.log("fd_write: ref: write_data", new TextDecoder().decode(write_data));

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 27);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    const [ptr, len] = this.allocator.block_write(write_data, this.fd_func_sig, fd_func_sig_u32_offset + 2);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

    const error = this.get_error(fd);

    // console.log("fd_write: ref: error", error);

    if (error === wasi.ERRNO_BADF) {
      this.release_fd(fd);
      return [undefined, error];
    }

    const nwritten = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);

    this.release_fd(fd);

    return [nwritten, error];
  }

  path_create_directory(
    fd: number,
    path: Uint8Array,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 28);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    const [ptr, len] = this.allocator.block_write(path, this.fd_func_sig, fd_func_sig_u32_offset + 2);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  path_filestat_get(
    fd: number,
    flags: number,
    path: Uint8Array,
  ): [wasi.Filestat | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u8 = new Uint8Array(this.fd_func_sig);
    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u8_offset = fd * fd_func_sig_size * 4;
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 29);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 2, flags);
    const [ptr, len] = this.allocator.block_write(path, this.fd_func_sig, fd_func_sig_u32_offset + 3);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

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

  path_filestat_set_times(
    fd: number,
    flags: number,
    path: Uint8Array,
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

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 30);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 2, flags);
    const [ptr, len] = this.allocator.block_write(path, this.fd_func_sig, fd_func_sig_u32_offset + 3);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 3, st_atim);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 4, st_mtim);
    Atomics.store(func_sig_view_u16, fd_func_sig_u16_offset + 12, fst_flags);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  path_link(
    old_fd: number,
    old_flags: number,
    old_path: Uint8Array,
    new_fd: number,
    new_path: Uint8Array,
  ): number {
    this.lock_double_fd(old_fd, new_fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = old_fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 31);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, old_fd);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 2, old_flags);
    const [ptr1, len1] = this.allocator.block_write(old_path, this.fd_func_sig, fd_func_sig_u32_offset + 3);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 5, new_fd);
    const [ptr2, len2] = this.allocator.block_write(new_path, this.fd_func_sig, fd_func_sig_u32_offset + 6);

    if (!this.call_fd_func(old_fd)) {
      this.allocator.free(ptr1, len1);
      this.allocator.free(ptr2, len2);
      this.release_double_fd(old_fd, new_fd);
      return wasi.ERRNO_BADF;
    }

    const error = this.get_error(old_fd);

    this.release_double_fd(old_fd, new_fd);

    return error;
  }

  path_open(
    fd: number,
    dirflags: number,
    path: Uint8Array,
    oflags: number,
    fs_rights_base: bigint,
    fs_rights_inheriting: bigint,
    fs_flags: number,
  ): [number | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u16 = new Uint16Array(this.fd_func_sig);
    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const func_sig_view_u64 = new BigUint64Array(this.fd_func_sig);
    const fd_func_sig_u16_offset = fd * fd_func_sig_size * 2;
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;
    const fd_func_sig_u64_offset = Math.floor(fd_func_sig_u32_offset / 2);

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 32);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 2, dirflags);
    const [ptr, len] = this.allocator.block_write(path, this.fd_func_sig, fd_func_sig_u32_offset + 3);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 5, oflags);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 3, fs_rights_base);
    Atomics.store(func_sig_view_u64, fd_func_sig_u64_offset + 4, fs_rights_inheriting);
    Atomics.store(func_sig_view_u16, fd_func_sig_u16_offset + 20, fs_flags);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

    const error = this.get_error(fd);

    if (error === wasi.ERRNO_SUCCESS) {
      const new_fd = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
      this.release_fd(fd);
      return [new_fd, error];
    }

    this.release_fd(fd);

    return [undefined, error];
  }

  path_readlink(
    fd: number,
    path: Uint8Array,
    buf_len: number,
  ): [Uint8Array | undefined, number] {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 33);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    const [ptr, len] = this.allocator.block_write(path, this.fd_func_sig, fd_func_sig_u32_offset + 2);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 4, buf_len);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return [undefined, wasi.ERRNO_BADF];
    }

    const error = this.get_error(fd);

    const nread = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset);
    const ret_path_ptr = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 1);
    const ret_path_len = Atomics.load(func_sig_view_u32, fd_func_sig_u32_offset + 2);

    this.release_fd(fd);
    if (error !== wasi.ERRNO_SUCCESS && error !== wasi.ERRNO_NAMETOOLONG) {
      this.allocator.free(ret_path_ptr, ret_path_len);
      return [undefined, error];
    }

    const ret_path = new Uint8Array(this.allocator.get_memory(ret_path_ptr, ret_path_len));
    const ret_path_slice = ret_path.slice(0, nread);

    return [ret_path_slice, error];
  }

  path_remove_directory(
    fd: number,
    path: Uint8Array,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 34);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    const [ptr, len] = this.allocator.block_write(path, this.fd_func_sig, fd_func_sig_u32_offset + 2);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  path_rename(
    old_fd: number,
    old_path: Uint8Array,
    new_fd: number,
    new_path: Uint8Array,
  ): number {
    this.lock_double_fd(old_fd, new_fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = old_fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 35);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, old_fd);
    const [ptr1, len1] = this.allocator.block_write(old_path, this.fd_func_sig, fd_func_sig_u32_offset + 2);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 4, new_fd);
    const [ptr2, len2] = this.allocator.block_write(new_path, this.fd_func_sig, fd_func_sig_u32_offset + 5);

    if (!this.call_fd_func(old_fd)) {
      this.allocator.free(ptr1, len1);
      this.allocator.free(ptr2, len2);
      this.release_double_fd(old_fd, new_fd);
      return wasi.ERRNO_BADF;
    }

    const error = this.get_error(old_fd);

    this.release_double_fd(old_fd, new_fd);

    return error;
  }

  path_symlink(
    old_path: Uint8Array,
    fd: number,
    new_path: Uint8Array,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 36);
    const [ptr1, len1] = this.allocator.block_write(old_path, this.fd_func_sig, fd_func_sig_u32_offset + 1);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 3, fd);
    const [ptr2, len2] = this.allocator.block_write(new_path, this.fd_func_sig, fd_func_sig_u32_offset + 4);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr1, len1);
      this.allocator.free(ptr2, len2);
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }

  path_unlink_file(
    fd: number,
    path: Uint8Array,
  ): number {
    this.lock_fd(fd);

    const func_sig_view_u32 = new Uint32Array(this.fd_func_sig);
    const fd_func_sig_u32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset, 37);
    Atomics.store(func_sig_view_u32, fd_func_sig_u32_offset + 1, fd);
    const [ptr, len] = this.allocator.block_write(path, this.fd_func_sig, fd_func_sig_u32_offset + 2);

    if (!this.call_fd_func(fd)) {
      this.allocator.free(ptr, len);
      this.release_fd(fd);
      return wasi.ERRNO_BADF;
    }

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }
}
