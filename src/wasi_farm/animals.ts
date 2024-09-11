import { debug } from "../debug.js";
import { Options, WASIProcExit } from "../wasi.js";
import { WASIFarmRef } from "./ref.js";
import * as wasi from "../wasi_defs.js";

export class WASIFarmAnimal {
  private args: Array<string>;
  private env: Array<string>;

  private wasi_farm_ref: WASIFarmRef;

  private inst: { exports: { memory: WebAssembly.Memory } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wasiImport: { [key: string]: (...args: Array<any>) => unknown };

  private can_array_buffer;

  /// Start a WASI command
  start(instance: {
    // FIXME v0.3: close opened Fds after execution
    exports: { memory: WebAssembly.Memory; _start: () => unknown };
  }) {
    this.inst = instance;
    try {
      instance.exports._start();
      return 0;
    } catch (e) {
      if (e instanceof WASIProcExit) {
        return e.code;
      } else {
        throw e;
      }
    }
  }

  /// Initialize a WASI reactor
  initialize(instance: {
    exports: { memory: WebAssembly.Memory; _initialize?: () => unknown };
  }) {
    this.inst = instance;
    if (instance.exports._initialize) {
      instance.exports._initialize();
    }
  }

  constructor(
    wasi_farm_ref: WASIFarmRef,
    args: Array<string>,
    env: Array<string>,
    options: Options = {},
  ) {
    debug.enable(options.debug);

    this.args = args;
    this.env = env;
    this.wasi_farm_ref = wasi_farm_ref;
    const self = this;
    this.wasiImport = {
      args_sizes_get(argc: number, argv_buf_size: number): number {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        buffer.setUint32(argc, self.args.length, true);
        let buf_size = 0;
        for (const arg of self.args) {
          buf_size += arg.length + 1;
        }
        buffer.setUint32(argv_buf_size, buf_size, true);
        debug.log(
          buffer.getUint32(argc, true),
          buffer.getUint32(argv_buf_size, true),
        );
        return 0;
      },
      args_get(argv: number, argv_buf: number): number {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const orig_argv_buf = argv_buf;
        for (let i = 0; i < self.args.length; i++) {
          buffer.setUint32(argv, argv_buf, true);
          argv += 4;
          const arg = new TextEncoder().encode(self.args[i]);
          buffer8.set(arg, argv_buf);
          buffer.setUint8(argv_buf + arg.length, 0);
          argv_buf += arg.length + 1;
        }
        if (debug.enabled) {
          debug.log(
            new TextDecoder("utf-8").decode(
              buffer8.slice(orig_argv_buf, argv_buf),
            ),
          );
        }
        return 0;
      },

      environ_sizes_get(environ_count: number, environ_size: number): number {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        buffer.setUint32(environ_count, self.env.length, true);
        let buf_size = 0;
        for (const environ of self.env) {
          buf_size += environ.length + 1;
        }
        buffer.setUint32(environ_size, buf_size, true);
        debug.log(
          buffer.getUint32(environ_count, true),
          buffer.getUint32(environ_size, true),
        );
        return 0;
      },
      environ_get(environ: number, environ_buf: number): number {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const orig_environ_buf = environ_buf;
        for (let i = 0; i < self.env.length; i++) {
          buffer.setUint32(environ, environ_buf, true);
          environ += 4;
          const e = new TextEncoder().encode(self.env[i]);
          buffer8.set(e, environ_buf);
          buffer.setUint8(environ_buf + e.length, 0);
          environ_buf += e.length + 1;
        }
        if (debug.enabled) {
          debug.log(
            new TextDecoder("utf-8").decode(
              buffer8.slice(orig_environ_buf, environ_buf),
            ),
          );
        }
        return 0;
      },

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      clock_res_get(id: number, res_ptr: number): number {
        let resolutionValue: bigint;
        switch (id) {
          case wasi.CLOCKID_MONOTONIC: {
            // https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
            // > Resolution in isolated contexts: 5 microseconds
            resolutionValue = 5_000n; // 5 microseconds
            break;
          }
          case wasi.CLOCKID_REALTIME: {
            resolutionValue = 1_000_000n; // 1 millisecond?
            break;
          }
          default:
            return wasi.ERRNO_NOSYS;
        }
        const view = new DataView(self.inst.exports.memory.buffer);
        view.setBigUint64(res_ptr, resolutionValue, true);
        return wasi.ERRNO_SUCCESS;
      },
      clock_time_get(id: number, precision: bigint, time: number): number {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        if (id === wasi.CLOCKID_REALTIME) {
          buffer.setBigUint64(
            time,
            BigInt(new Date().getTime()) * 1_000_000n,
            true,
          );
        } else if (id == wasi.CLOCKID_MONOTONIC) {
          let monotonic_time: bigint;
          try {
            monotonic_time = BigInt(Math.round(performance.now() * 1000000));
          } catch (e) {
            // performance.now() is only available in browsers.
            // TODO use the perf_hooks builtin module for NodeJS
            monotonic_time = 0n;
          }
          buffer.setBigUint64(time, monotonic_time, true);
        } else {
          // TODO
          buffer.setBigUint64(time, 0n, true);
        }
        return 0;
      },
      fd_advise(
        fd: number,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        offset: bigint,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        len: bigint,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        advice: number,
      ) {
        return self.wasi_farm_ref.fd_advise(fd);
      },
      fd_allocate(
        fd: number,
        offset: bigint,
        len: bigint,
      ) {
        return self.wasi_farm_ref.fd_allocate(fd, offset, len);
      },
      fd_close(fd: number) {
        return self.wasi_farm_ref.fd_close(fd);
      },
      fd_datasync(fd: number) {
        return self.wasi_farm_ref.fd_datasync(fd);
      },
      fd_fdstat_get(fd: number, fdstat_ptr: number) {
        const [fdstat, ret] = self.wasi_farm_ref.fd_fdstat_get(fd);
        if (fdstat) {
          fdstat.write_bytes(
            new DataView(self.inst.exports.memory.buffer),
            fdstat_ptr,
          );
        }
        return ret;
      },
      fd_fdstat_set_flags(fd: number, flags: number) {
        return self.wasi_farm_ref.fd_fdstat_set_flags(fd, flags);
      },
      fd_fdstat_set_rights(fd: number, fs_rights_base: bigint, fs_rights_inheriting: bigint) {
        return self.wasi_farm_ref.fd_fdstat_set_rights(fd, fs_rights_base, fs_rights_inheriting);
      },
      fd_filestat_get(fd: number, filestat_ptr: number) {
        const [filestat, ret] = self.wasi_farm_ref.fd_filestat_get(fd);
        if (filestat) {
          filestat.write_bytes(
            new DataView(self.inst.exports.memory.buffer),
            filestat_ptr,
          );
        }
        return ret;
      },
      fd_filestat_set_size(fd: number, size: bigint) {
        return self.wasi_farm_ref.fd_filestat_set_size(fd, size);
      },
      fd_filestat_set_times(fd: number, atim: bigint, mtim: bigint, fst_flags: number) {
        return self.wasi_farm_ref.fd_filestat_set_times(fd, atim, mtim, fst_flags);
      },
      fd_pread(fd: number, iovs_ptr: number, iovs_len: number, offset: bigint, nread_ptr: number) {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const iovs_view = new Uint32Array(buffer.buffer, iovs_ptr, iovs_len * 8);
        const [nerad_and_read_data, ret] = self.wasi_farm_ref.fd_pread(fd, iovs_view, offset);
        if (nerad_and_read_data) {
          const iovecs = wasi.Iovec.read_bytes_array(
            buffer,
            iovs_ptr,
            iovs_len,
          );
          const [nread, read_data] = nerad_and_read_data;
          buffer.setUint32(nread_ptr, nread, true);
          let nreaded = 0;
          for (const iovec of iovecs) {
            if (nreaded + iovec.buf_len >= read_data.length) {
              buffer8.set(read_data, iovec.buf);
              break;
            }
            buffer8.set(
              read_data.slice(nreaded, nreaded + iovec.buf_len),
              iovec.buf
            );
            nreaded += iovec.buf_len;
          }
        }
        return ret;
      },
      fd_prestat_get(fd: number, prestat_ptr: number) {
        const [prestat, ret] = self.wasi_farm_ref.fd_prestat_get(fd);
        if (prestat) {
          const [tag, name_len] = prestat;
          const buffer = new DataView(self.inst.exports.memory.buffer);
          buffer.setUint32(prestat_ptr, tag, true);
          buffer.setUint32(prestat_ptr + 4, name_len, true);
        }
        return ret;
      },
      fd_prestat_dir_name(fd: number, path_ptr: number, path_len: number) {
        const [path, ret] = self.wasi_farm_ref.fd_prestat_dir_name(fd, path_len);
        if (path) {
          const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
          buffer8.set(path, path_ptr);
        }
        return ret;
      },
      fd_pwrite(fd: number, iovs_ptr: number, iovs_len: number, offset: bigint, nwritten_ptr: number) {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const iovecs = wasi.Ciovec.read_bytes_array(
          buffer,
          iovs_ptr,
          iovs_len,
        );
        const data = new Uint8Array(iovecs.reduce((acc, iovec) => acc + iovec.buf_len, 0));
        let nwritten = 0;
        for (const iovec of iovecs) {
          data.set(buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len), nwritten);
          nwritten += iovec.buf_len;
        }
        const [ret, written] = self.wasi_farm_ref.fd_pwrite(fd, data, offset);
        buffer.setUint32(nwritten_ptr, written, true);
        return ret;
      },
      fd_read(fd: number, iovs_ptr: number, iovs_len: number, nread_ptr: number) {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const iovs_view = new Uint32Array(buffer.buffer, iovs_ptr, iovs_len * 8);
        const [nerad_and_read_data, ret] = self.wasi_farm_ref.fd_read(fd, iovs_view);
        if (nerad_and_read_data) {
          const iovecs = wasi.Iovec.read_bytes_array(
            buffer,
            iovs_ptr,
            iovs_len,
          );
          const [nread, read_data] = nerad_and_read_data;
          buffer.setUint32(nread_ptr, nread, true);
          let nreaded = 0;
          for (const iovec of iovecs) {
            if (nreaded + iovec.buf_len >= read_data.length) {
              buffer8.set(read_data, iovec.buf);
              break;
            }
            buffer8.set(
              read_data.slice(nreaded, nreaded + iovec.buf_len),
              iovec.buf
            );
            nreaded += iovec.buf_len;
          }
        }
        return ret;
      },
      fd_readdir(fd: number, buf_ptr: number, buf_len: number, cookie: bigint, buf_used_ptr: number) {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const [nerad_and_read_data, ret] = self.wasi_farm_ref.fd_readdir(fd, buf_len, cookie);
        if (nerad_and_read_data) {
          const [read_data, buf_used] = nerad_and_read_data;
          buffer.setUint32(buf_used_ptr, buf_used, true);
          buffer8.set(read_data, buf_ptr);
        }
        return ret;
      },
      fd_renumber(fd: number, to: number) {
        return self.wasi_farm_ref.fd_renumber(fd, to);
      },
      fd_seek(fd: number, offset: bigint, whence: number, newoffset_ptr: number) {
        const [newoffset, ret] = self.wasi_farm_ref.fd_seek(fd, offset, whence);
        if (newoffset) {
          const buffer = new DataView(self.inst.exports.memory.buffer);

          // wasi.ts use BigInt for offset, but API use Uint64
          buffer.setBigUint64(newoffset_ptr, newoffset, true);
        }
        return ret;
      },
      fd_sync(fd: number) {
        return self.wasi_farm_ref.fd_sync(fd);
      },
      fd_tell(fd: number, newoffset_ptr: number) {
        const [newoffset, ret] = self.wasi_farm_ref.fd_tell(fd);
        if (newoffset) {
          const buffer = new DataView(self.inst.exports.memory.buffer);
          buffer.setBigUint64(newoffset_ptr, newoffset, true);
        }
        return ret;
      },
      fd_write(fd: number, iovs_ptr: number, iovs_len: number, nwritten_ptr: number) {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const iovecs = wasi.Ciovec.read_bytes_array(
          buffer,
          iovs_ptr,
          iovs_len,
        );
        const data = new Uint8Array(iovecs.reduce((acc, iovec) => acc + iovec.buf_len, 0));
        let nwritten = 0;
        for (const iovec of iovecs) {
          data.set(buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len), nwritten);
          nwritten += iovec.buf_len;
        }
        const [ret, written] = self.wasi_farm_ref.fd_write(fd, data);
        buffer.setUint32(nwritten_ptr, written, true);
        return ret;
      },
      path_create_directory(fd: number, path_ptr: number, path_len: number) {
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        return self.wasi_farm_ref.path_create_directory(fd, path);
      },
      path_filestat_get(fd: number, flags: number, path_ptr: number, path_len: number, filestat_ptr: number) {
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        const [filestat, ret] = self.wasi_farm_ref.path_filestat_get(fd, flags, path);
        if (filestat) {
          filestat.write_bytes(buffer, filestat_ptr);
        }
        return ret;
      },
      path_filestat_set_times(fd: number, flags: number, path_ptr: number, path_len: number, atim: bigint, mtim: bigint, fst_flags: number) {
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        return self.wasi_farm_ref.path_filestat_set_times(fd, flags, path, atim, mtim, fst_flags);
      },
      path_link(old_fd: number, old_flags: number, old_path_ptr: number, old_path_len: number, new_fd: number, new_path_ptr: number, new_path_len: number) {
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const old_path = buffer8.slice(old_path_ptr, old_path_ptr + old_path_len);
        const new_path = buffer8.slice(new_path_ptr, new_path_ptr + new_path_len);
        return self.wasi_farm_ref.path_link(old_fd, old_flags, old_path, new_fd, new_path);
      },
      path_open(fd: number, dirflags: number, path_ptr: number, path_len: number, oflags: number, fs_rights_base: bigint, fs_rights_inheriting: bigint, fs_flags: number, opened_fd_ptr: number) {
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        const [opened_fd, ret] = self.wasi_farm_ref.path_open(fd, dirflags, path, oflags, fs_rights_base, fs_rights_inheriting, fs_flags);
        if (opened_fd) {
          const buffer = new DataView(self.inst.exports.memory.buffer);
          buffer.setUint32(opened_fd_ptr, opened_fd, true);
        }
        return ret;
      },
      path_readlink(fd: number, path_ptr: number, path_len: number, buf_ptr: number, buf_len: number, buf_used_ptr: number) {
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        const [buf, ret] = self.wasi_farm_ref.path_readlink(fd, path, buf_len);
        if (buf) {
          const buffer = new DataView(self.inst.exports.memory.buffer);
          buffer.setUint32(buf_used_ptr, buf.length, true);
          buffer8.set(buf, buf_ptr);
        }
        return ret;
      },
      path_remove_directory(fd: number, path_ptr: number, path_len: number) {
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        return self.wasi_farm_ref.path_remove_directory(fd, path);
      },
      path_rename(old_fd: number, old_path_ptr: number, old_path_len: number, new_fd: number, new_path_ptr: number, new_path_len: number) {
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const old_path = buffer8.slice(old_path_ptr, old_path_ptr + old_path_len);
        const new_path = buffer8.slice(new_path_ptr, new_path_ptr + new_path_len);
        return self.wasi_farm_ref.path_rename(old_fd, old_path, new_fd, new_path);
      },
      path_symlink(old_path_ptr: number, old_path_len: number, fd: number, new_path_ptr: number, new_path_len: number) {
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const old_path = buffer8.slice(old_path_ptr, old_path_ptr + old_path_len);
        const new_path = buffer8.slice(new_path_ptr, new_path_ptr + new_path_len);
        return self.wasi_farm_ref.path_symlink(old_path, fd, new_path);
      },
      path_unlink_file(fd: number, path_ptr: number, path_len: number) {
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        return self.wasi_farm_ref.path_unlink_file(fd, path);
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      poll_oneoff(in_, out, nsubscriptions) {
        throw "async io not supported";
      },
      proc_exit(exit_code: number) {
        throw new WASIProcExit(exit_code);
      },
      proc_raise(sig: number) {
        throw "raised signal " + sig;
      },
      sched_yield() {},
      random_get(buf: number, buf_len: number) {
        const buffer8 = new Uint8Array(
          self.inst.exports.memory.buffer,
        ).subarray(buf, buf + buf_len);

        if (
          "crypto" in globalThis &&
          !(self.inst.exports.memory.buffer instanceof SharedArrayBuffer)
        ) {
          for (let i = 0; i < buf_len; i += 65536) {
            crypto.getRandomValues(buffer8.subarray(i, i + 65536));
          }
        } else {
          for (let i = 0; i < buf_len; i++) {
            buffer8[i] = (Math.random() * 256) | 0;
          }
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      sock_recv(fd: number, ri_data, ri_flags) {
        throw "sockets not supported";
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      sock_send(fd: number, si_data, si_flags) {
        throw "sockets not supported";
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      sock_shutdown(fd: number, how) {
        throw "sockets not supported";
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      sock_accept(fd: number, flags) {
        throw "sockets not supported";
      },
    }
  }
}
