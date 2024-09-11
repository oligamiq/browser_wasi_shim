import * as wasi from "wasi_defs.js";

export abstract class WASIFarmRef {
  abstract fd_advise(fd: number): number;
  abstract fd_allocate(fd: number, offset: bigint, len: bigint): number;
  abstract fd_close(fd: number): number;
  abstract fd_datasync(fd: number): number;
  abstract fd_fdstat_get(fd: number): [wasi.Fdstat | undefined, number];
  abstract fd_fdstat_set_flags(fd: number, flags: number): number;
  abstract fd_fdstat_set_rights(fd: number, fs_rights_base: bigint, fs_rights_inheriting: bigint): number;
  abstract fd_filestat_get(fd: number): [wasi.Filestat | undefined, number];
  abstract fd_filestat_set_size(fd: number, size: bigint): number;
  abstract fd_filestat_set_times(fd: number, atim: bigint, mtim: bigint, fst_flags: number): number;
  abstract fd_pread(fd: number, iovs:Uint32Array, offset: bigint): [[number, Uint8Array] | undefined, number];
  abstract fd_prestat_get(fd: number): [[number, number] | undefined, number];
  abstract fd_prestat_dir_name(fd: number, path_len: number): [Uint8Array | undefined, number];
  abstract fd_pwrite(fd: number, iovs: Uint32Array, offset: bigint): [number, number];
  abstract fd_read(fd: number, iovs: Uint32Array): [[number, Uint8Array] | undefined, number];
  abstract fd_readdir(fd: number, limit_buf_len: number, cookie: bigint): [[Uint8Array, number] | undefined, number]
  abstract fd_renumber(fd: number, to: number): number;
  abstract fd_seek(fd: number, offset: bigint, whence: number): [bigint | undefined, number];
  abstract fd_sync(fd: number): number;
  abstract fd_tell(fd: number): [bigint, number];
  abstract fd_write(fd: number, iovs: Uint32Array): [number, number];
  abstract path_create_directory(fd: number, path: Uint8Array): number;
  abstract path_filestat_get(fd: number, flags: number, path: Uint8Array): [wasi.Filestat | undefined, number];
  abstract path_filestat_set_times(fd: number, flags: number, path: Uint8Array, st_atim: bigint, st_mtim: bigint, fst_flags: number): number
  abstract path_link(old_fd: number, old_flags: number, old_path: Uint8Array, new_fd: number, new_path: Uint8Array): number;
  abstract path_open(fd: number, dirflags: number, path: Uint8Array, oflags: number, fs_rights_base: bigint, fs_rights_inheriting: bigint, fs_flags: number): [number, number];
  abstract path_readlink(fd: number, path: Uint8Array, buf_len: number): [Uint8Array | undefined, number];
  abstract path_remove_directory(fd: number, path: Uint8Array): number;
  abstract path_rename(old_fd: number, old_path: Uint8Array, new_fd: number, new_path: Uint8Array): number;
  abstract path_symlink(old_path: Uint8Array, fd: number, new_path: Uint8Array): number;
  abstract path_unlink_file(fd: number, path: Uint8Array): number;
}
