import { Allocator } from "./allocator";

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
}
