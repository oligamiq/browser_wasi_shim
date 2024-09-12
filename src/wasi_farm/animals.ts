import { debug } from "../debug.js";
import { Options, WASIProcExit } from "../wasi.js";
import { WASIFarmRef } from "./ref.js";
import * as wasi from "../wasi_defs.js";
import { WASIFarmRefUseArrayBuffer } from "./shared_array_buffer/ref.js";
import { Fd } from "../fd.js";

export class WASIFarmAnimal {
  private args: Array<string>;
  private env: Array<string>;

  private wasi_farm_ref: WASIFarmRef;

  private inst: { exports: { memory: WebAssembly.Memory } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wasiImport: { [key: string]: (...args: Array<any>) => unknown };

  private can_array_buffer;

  // Each process has a specific fd that it can access.
  // If it does not exist in the map, it cannot be accessed.
  // child process can access parent process's fd.
  // so, it is necessary to manage the fd on global scope.
  protected fd_map: Map<number, number> = new Map();

  protected rm_fd_from_map(fd: number) {
    this.fd_map.delete(fd);
  }

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
    stdin?: Fd,
    stdout?: Fd,
    stderr?: Fd,
    options: Options = {},
  ) {
    debug.enable(options.debug);

    if (wasi_farm_ref instanceof WASIFarmRef) {
      this.wasi_farm_ref = wasi_farm_ref;
    } else {
      try {
        new SharedArrayBuffer(4);
        this.can_array_buffer = true;
      } catch (_) {
        this.can_array_buffer = false;
      }

      if (this.can_array_buffer) {
        this.wasi_farm_ref = WASIFarmRefUseArrayBuffer.init_self(wasi_farm_ref as WASIFarmRefUseArrayBuffer);
      }
    }

    if (stdin) {
      const 
    } else {
      this.fd_map.set(0, 0);
    }

    this.args = args;
    this.env = env;
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
        const mapped_fd = self.fd_map.get(fd);
        return self.wasi_farm_ref.fd_advise(mapped_fd);
      },
      fd_allocate(
        fd: number,
        offset: bigint,
        len: bigint,
      ) {
        const mapped_fd = self.fd_map.get(fd);
        return self.wasi_farm_ref.fd_allocate(mapped_fd, offset, len);
      },
      fd_close(fd: number) {
        const mapped_fd = self.fd_map.get(fd);
        return self.wasi_farm_ref.fd_close(mapped_fd);
      },
      fd_datasync(fd: number) {
        const mapped_fd = self.fd_map.get(fd);
        return self.wasi_farm_ref.fd_datasync(mapped_fd);
      },
      fd_fdstat_get(fd: number, fdstat_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        const [fdstat, ret] = self.wasi_farm_ref.fd_fdstat_get(mapped_fd);
        if (fdstat) {
          fdstat.write_bytes(
            new DataView(self.inst.exports.memory.buffer),
            fdstat_ptr,
          );
        }
        return ret;
      },
      fd_fdstat_set_flags(fd: number, flags: number) {
        const mapped_fd = self.fd_map.get(fd);
        return self.wasi_farm_ref.fd_fdstat_set_flags(mapped_fd, flags);
      },
      fd_fdstat_set_rights(fd: number, fs_rights_base: bigint, fs_rights_inheriting: bigint) {
        const mapped_fd = self.fd_map.get(fd);
        return self.wasi_farm_ref.fd_fdstat_set_rights(mapped_fd, fs_rights_base, fs_rights_inheriting);
      },
      fd_filestat_get(fd: number, filestat_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        const [filestat, ret] = self.wasi_farm_ref.fd_filestat_get(mapped_fd);
        if (filestat) {
          filestat.write_bytes(
            new DataView(self.inst.exports.memory.buffer),
            filestat_ptr,
          );
        }
        return ret;
      },
      fd_filestat_set_size(fd: number, size: bigint) {
        const mapped_fd = self.fd_map.get(fd);
        return self.wasi_farm_ref.fd_filestat_set_size(mapped_fd, size);
      },
      fd_filestat_set_times(fd: number, atim: bigint, mtim: bigint, fst_flags: number) {
        const mapped_fd = self.fd_map.get(fd);
        return self.wasi_farm_ref.fd_filestat_set_times(mapped_fd, atim, mtim, fst_flags);
      },
      fd_pread(fd: number, iovs_ptr: number, iovs_len: number, offset: bigint, nread_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const iovs_view = new Uint32Array(buffer.buffer, iovs_ptr, iovs_len * 2);
        const [nerad_and_read_data, ret] = self.wasi_farm_ref.fd_pread(mapped_fd, iovs_view, offset);
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
        const mapped_fd = self.fd_map.get(fd);
        const [prestat, ret] = self.wasi_farm_ref.fd_prestat_get(mapped_fd);
        if (prestat) {
          const [tag, name_len] = prestat;
          const buffer = new DataView(self.inst.exports.memory.buffer);
          buffer.setUint32(prestat_ptr, tag, true);
          buffer.setUint32(prestat_ptr + 4, name_len, true);
        }
        return ret;
      },
      fd_prestat_dir_name(fd: number, path_ptr: number, path_len: number) {
        const mapped_fd = self.fd_map.get(fd);
        const [path, ret] = self.wasi_farm_ref.fd_prestat_dir_name(mapped_fd, path_len);
        if (path) {
          const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
          buffer8.set(path, path_ptr);
        }
        return ret;
      },
      fd_pwrite(fd: number, iovs_ptr: number, iovs_len: number, offset: bigint, nwritten_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
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
        const [written, ret] = self.wasi_farm_ref.fd_pwrite(mapped_fd, data, offset);
        if (written) {
          buffer.setUint32(nwritten_ptr, written, true);
        }
        return ret;
      },
      fd_read(fd: number, iovs_ptr: number, iovs_len: number, nread_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const iovs_view = new Uint32Array(buffer.buffer, iovs_ptr, iovs_len * 2);

        const [nerad_and_read_data, ret] = self.wasi_farm_ref.fd_read(mapped_fd, iovs_view);
        if (nerad_and_read_data) {
          const iovecs = wasi.Iovec.read_bytes_array(
            buffer,
            iovs_ptr,
            iovs_len,
          );
          const [nread, read_data] = nerad_and_read_data;

          // console.log("fd_read: nread", nread, new TextDecoder().decode(read_data));

          // fd_read: ref:  14 30 14
          // animals.ts:325 fd_read: nread 14 Hello, world!

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
        const mapped_fd = self.fd_map.get(fd);
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const [nerad_and_read_data, ret] = self.wasi_farm_ref.fd_readdir(mapped_fd, buf_len, cookie);
        if (nerad_and_read_data) {
          const [read_data, buf_used] = nerad_and_read_data;
          buffer.setUint32(buf_used_ptr, buf_used, true);
          buffer8.set(read_data, buf_ptr);
        }
        return ret;
      },
      fd_renumber(fd: number, to: number) {
        const mapped_fd = self.fd_map.get(fd);
        const mapped_to = self.fd_map.get(to);
        return self.wasi_farm_ref.fd_renumber(mapped_fd, mapped_to);
      },
      fd_seek(fd: number, offset: bigint, whence: number, newoffset_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        const [newoffset, ret] = self.wasi_farm_ref.fd_seek(mapped_fd, offset, whence);
        if (newoffset) {
          const buffer = new DataView(self.inst.exports.memory.buffer);

          // wasi.ts use BigInt for offset, but API use Uint64
          buffer.setBigUint64(newoffset_ptr, newoffset, true);
        }
        return ret;
      },
      fd_sync(fd: number) {
        const mapped_fd = self.fd_map.get(fd);
        return self.wasi_farm_ref.fd_sync(mapped_fd);
      },
      fd_tell(fd: number, newoffset_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        const [newoffset, ret] = self.wasi_farm_ref.fd_tell(mapped_fd);
        if (newoffset) {
          const buffer = new DataView(self.inst.exports.memory.buffer);
          buffer.setBigUint64(newoffset_ptr, newoffset, true);
        }
        return ret;
      },
      fd_write(fd: number, iovs_ptr: number, iovs_len: number, nwritten_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        // console.log("fd_write", fd, iovs_ptr, iovs_len, nwritten_ptr);

        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const iovecs = wasi.Ciovec.read_bytes_array(
          buffer,
          iovs_ptr,
          iovs_len,
        );
        // console.log("iovecs", iovecs);
        const data = new Uint8Array(iovecs.reduce((acc, iovec) => acc + iovec.buf_len, 0));
        // console.log("data", data);
        let nwritten = 0;
        for (const iovec of iovecs) {
          data.set(buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len), nwritten);
          nwritten += iovec.buf_len;
        }

        // console.log("fd_write", fd, new TextDecoder().decode(data));

        const [written, ret] = self.wasi_farm_ref.fd_write(mapped_fd, data);

        // console.log("fd_write", fd, ret, written);

        if (written) {
          buffer.setUint32(nwritten_ptr, written, true);
        }
        return ret;
      },
      path_create_directory(fd: number, path_ptr: number, path_len: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        return self.wasi_farm_ref.path_create_directory(mapped_fd, path);
      },
      path_filestat_get(fd: number, flags: number, path_ptr: number, path_len: number, filestat_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer = new DataView(self.inst.exports.memory.buffer);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        const [filestat, ret] = self.wasi_farm_ref.path_filestat_get(mapped_fd, flags, path);
        if (filestat) {
          filestat.write_bytes(buffer, filestat_ptr);
        }
        return ret;
      },
      path_filestat_set_times(fd: number, flags: number, path_ptr: number, path_len: number, atim: bigint, mtim: bigint, fst_flags: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        return self.wasi_farm_ref.path_filestat_set_times(mapped_fd, flags, path, atim, mtim, fst_flags);
      },
      path_link(old_fd: number, old_flags: number, old_path_ptr: number, old_path_len: number, new_fd: number, new_path_ptr: number, new_path_len: number) {
        const mapped_old_fd = self.fd_map.get(old_fd);
        const mapped_new_fd = self.fd_map.get(new_fd);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const old_path = buffer8.slice(old_path_ptr, old_path_ptr + old_path_len);
        const new_path = buffer8.slice(new_path_ptr, new_path_ptr + new_path_len);
        return self.wasi_farm_ref.path_link(mapped_old_fd, old_flags, old_path, mapped_new_fd, new_path);
      },
      path_open(fd: number, dirflags: number, path_ptr: number, path_len: number, oflags: number, fs_rights_base: bigint, fs_rights_inheriting: bigint, fs_flags: number, opened_fd_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        const [opened_fd, ret] = self.wasi_farm_ref.path_open(mapped_fd, dirflags, path, oflags, fs_rights_base, fs_rights_inheriting, fs_flags);
        if (opened_fd) {
          if (this.fd_map.has(opened_fd)) {
            throw new Error("opened_fd already exists");
          }
          this.fd_map.set(opened_fd, opened_fd);
          const buffer = new DataView(self.inst.exports.memory.buffer);
          buffer.setUint32(opened_fd_ptr, opened_fd, true);
        }
        return ret;
      },
      path_readlink(fd: number, path_ptr: number, path_len: number, buf_ptr: number, buf_len: number, buf_used_ptr: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        const [buf, ret] = self.wasi_farm_ref.path_readlink(mapped_fd, path, buf_len);
        if (buf) {
          const buffer = new DataView(self.inst.exports.memory.buffer);
          buffer.setUint32(buf_used_ptr, buf.length, true);
          buffer8.set(buf, buf_ptr);
        }
        return ret;
      },
      path_remove_directory(fd: number, path_ptr: number, path_len: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        return self.wasi_farm_ref.path_remove_directory(mapped_fd, path);
      },
      path_rename(old_fd: number, old_path_ptr: number, old_path_len: number, new_fd: number, new_path_ptr: number, new_path_len: number) {
        const mapped_old_fd = self.fd_map.get(old_fd);
        const mapped_new_fd = self.fd_map.get(new_fd);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const old_path = buffer8.slice(old_path_ptr, old_path_ptr + old_path_len);
        const new_path = buffer8.slice(new_path_ptr, new_path_ptr + new_path_len);
        return self.wasi_farm_ref.path_rename(mapped_old_fd, old_path, mapped_new_fd, new_path);
      },
      path_symlink(old_path_ptr: number, old_path_len: number, fd: number, new_path_ptr: number, new_path_len: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const old_path = buffer8.slice(old_path_ptr, old_path_ptr + old_path_len);
        const new_path = buffer8.slice(new_path_ptr, new_path_ptr + new_path_len);
        return self.wasi_farm_ref.path_symlink(old_path, mapped_fd, new_path);
      },
      path_unlink_file(fd: number, path_ptr: number, path_len: number) {
        const mapped_fd = self.fd_map.get(fd);
        const buffer8 = new Uint8Array(self.inst.exports.memory.buffer);
        const path = buffer8.slice(path_ptr, path_ptr + path_len);
        return self.wasi_farm_ref.path_unlink_file(mapped_fd, path);
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
