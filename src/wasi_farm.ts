import { debug } from "./debug.js";
import { Fd } from "./fd.js";
import WASI, { Options } from "./wasi.js";

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
    const args = [...this.args];
    const env = [...this.env];

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

  get_ref(): WASIFarmRef {
    let socket = new WASIFarmPark(this.member_ref());

    this.sockets.push(socket);

    return socket.get_ref();
  }
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
  //    (fd: u32) => [path_ptr: pointer, path_len: u32, errno];
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

  // ここから、fdを使わないもの
  // 上と競合せずに使える。
  // poll_oneoff: (in_ptr: pointer, out_ptr: pointer, nsubscriptions: u32, nevents_ptr: pointer) => errno;
  // note: async io not supported
  // proc_exit: (rval: u32) => never;
  // proc_raise: (sig: u8) => errno;
  // sched_yield: () => errno;
  // random_get: (buf_ptr: pointer, buf_len: u32) => errno;
  // sock_recv: "sockets not supported";
  // sock_send: "sockets not supported";
  // sock_shutdown: "sockets not supported";
  // sock_accept: "sockets not supported";

  // fdを使いたい際に、ロックする
  lock_fds: SharedArrayBuffer = new SharedArrayBuffer(9);
  // 一番大きなサイズはu32 * 16 + 1
  // Alignが面倒なので、u32 * 16 + 4にする
  fd_func_sig: SharedArrayBuffer = new SharedArrayBuffer(68);

  constructor([args, env, fds]: [Array<string>, Array<string>, Array<Fd>]) {
    this.args = args;
    this.env = env;
    this.fds = fds;
  }

  /// これをpostMessageで送る
  get_ref(): WASIFarmRef {
    return new WASIFarmRef(
      this.share_arrays_memory,
      this.lock_fds,
      this.fd_func_sig,
    );
  }
}

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
