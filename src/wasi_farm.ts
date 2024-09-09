import { debug } from "./debug.js";
import { Fd } from "./fd.js";
import WASI, { Options } from "./wasi.js";

interface Channel {
  postMessage: (message: any) => void | Promise<void>;
  onmessage: (message: any) => void | Promise<void>;
}

export default class WASIFarm {
  args: Array<string>;
  env: Array<string>;
  fds: Array<Fd>;
  sockets: WASIFarmPark[];

  constructor(
    args: Array<string>,
    env: Array<string>,
    fds: Array<Fd>,
    options: Options = {},
  ) {
    debug.enable(options.debug);

    this.args = args;
    this.env = env;
    this.fds = fds;
    this.sockets = [];
  }

  member_ref(): [Array<string>, Array<string>, Array<Fd>] {
    const args = new Proxy([] as Array<string>, {
      get: (_, prop) => {
        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }

        console.log("args", prop);
        return this.args[prop];
      }
    });
    const env = new Proxy([] as Array<string>, {
      get: (_, prop) => {
        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }

        console.log("env", prop);
        return this.env[prop];
      }
    });
    const fds = new Proxy([] as Array<Fd>, {
      get: (_, prop) => {
        console.log("fds", prop);

        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }
        return this.fds[prop];
      }
    });

    return [args, env, fds];
  }

  get_ref(): [WASIFarmRef, (socket: Channel) => void] {
    let socket = new WASIFarmPark(this.member_ref());

    return [new WASIFarmRef(
      socket.socket_(),
    ), socket.register];
  }
}

type U8 = number;
type Message = {
  func_id: U8;
}

export class WASIFarmPark {
  // This is copy
  args: Array<string>;
  // This is copy
  env: Array<string>;
  // This is Proxy
  fds: Array<Fd>;

  // !Sizedを渡す
  // 最初の4byteはロック用の値: i32
  // 次の4byteは現在のarrayの数: m: i32
  // 次の4byteはshare_arrays_memoryの使っている場所の長さ: n: i32
  // busyでなくなれば直ぐに空になるはずなので、空になったときだけリセットする。
  // 長くなりすぎても、ブラウザの仮想化により大丈夫なはず
  // First-Fitよりもさらに簡素なアルゴリズムを使う
  share_arrays_memory: SharedArrayBuffer = new SharedArrayBuffer(0);
  // データを追加するときは、Atomics.waitで、最初の4byteが0になるまで待つ
  // その後、Atomics.compareExchangeで、最初の4byteを1にする
  // 上の返り値が0ならば、*1
  // 上の返り値が1ならば、Atomics.waitで、最初の4byteが0になるまで待つ
  // *1: 2番目をAtomics.addで1増やす。返り値が0なら、リセットする。
  // データを追加する。足りないときは延ばす。
  // 解放するときは、Atomics.subで1減らすだけ。

  // args, envは変更されないので、コピーで良い
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
  //    (fd: u32) => [path_ptr: pointer, path_len: u32, errno];
  // fd_pwrite: (fd: u32, iovs_ptr: pointer, iovs_len: u32, offset: u64) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, write_data: pointer, write_data_len: u32, offset: u64) => [u32, errno];
  // fd_read: (fd: u32, iovs_ptr: pointer, iovs_len: u32) => [u32, errno];
  //    use share_arrays_memory;
  //    (fd: u32, iovs_ptr: pointer, iovs_len: u32) => [u32, errno];
  access_fds: SharedArrayBuffer = new SharedArrayBuffer(9);
}

export class WASIFarmRef {
  socket: SharedArrayBuffer[];

  constructor(socket: SharedArrayBuffer[]) {
    this.socket = socket;
  }

  get_wasi(): WASI {
    const args = new Proxy([] as Array<string>, {
      get: (_, prop) => {
        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }

        console.log("args", prop);
        return this.args[prop];
      }
    });
    const env = new Proxy([] as Array<string>, {
      get: (_, prop) => {
        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }

        console.log("env", prop);
        return this.env[prop];
      }
    });
    const fds = new Proxy([] as Array<Fd>, {
      get: (_, prop) => {
        console.log("fds", prop);

        if (prop === "push") {
          return (fd: Fd) => {
            this.fds.push(fd);
          };
        }
        return this.fds[prop];
      }
    });

    return new WASI(args, env, fds);
  }
}
