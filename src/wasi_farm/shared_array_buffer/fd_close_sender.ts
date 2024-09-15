import { FdCloseSender } from "../sender.js";
import { ToRefSenderUseArrayBuffer } from "./sender.js";

export class FdCloseSenderUseArrayBuffer extends ToRefSenderUseArrayBuffer implements FdCloseSender {
  constructor(
    max_share_arrays_memory?: number,
    share_arrays_memory?: SharedArrayBuffer,
  ) {
    super(4, max_share_arrays_memory, share_arrays_memory);
  }

  async send(
    targets: Array<number>,
    fd: number,
  ): Promise<void> {
    if (targets === undefined || targets.length === 0) {
      throw new Error("targets is empty");
    }
    console.log("fd_close_sender send", targets, fd);

    await this.async_send(targets, new Uint32Array([fd]));
  }

  get(
    id: number,
  ): Array<number> | undefined {
    const data = this.get_data(id);
    if (data === undefined) {
      return undefined;
    }

    console.log("fd_close_sender get", data);

    const array = [];
    for (const i of data) {
      array.push(i[0]);
    }

    return array;
  }

  static init_self(
    sl: FdCloseSenderUseArrayBuffer,
  ): FdCloseSender {
    const sel = ToRefSenderUseArrayBuffer.init_self_inner(sl);
    return new FdCloseSenderUseArrayBuffer(
      sel.max_share_arrays_memory,
      sel.share_arrays_memory,
    );
  }
}
