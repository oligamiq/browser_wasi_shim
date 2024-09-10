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
    while (true) {
      const view = new Int32Array(this.lock_fds);
      const value = Atomics.wait(view, fd * 2, 1);
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

    const func_sig_view_i32 = new Int32Array(this.fd_func_sig);
    const fd_func_sig_i32_offset = fd * fd_func_sig_size;

    Atomics.store(func_sig_view_i32, fd_func_sig_i32_offset, 7);
    this.call_fd_func(fd);

    const error = this.get_error(fd);

    this.release_fd(fd);

    return error;
  }
}
