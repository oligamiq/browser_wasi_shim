export class WASIFarmRef {
  share_arrays_memory: SharedArrayBuffer;
  lock_fds: SharedArrayBuffer;
  fd_func_sig: SharedArrayBuffer;

  constructor(
    share_arrays_memory: SharedArrayBuffer,
    lock_fds: SharedArrayBuffer,
    fd_func_sig: SharedArrayBuffer,
  ) {
    this.share_arrays_memory = share_arrays_memory;
    this.lock_fds = lock_fds;
    this.fd_func_sig = fd_func_sig;
  }
}
