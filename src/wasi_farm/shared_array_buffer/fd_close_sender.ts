import { ToRefSenderUseArrayBuffer } from "./sender";

export class FdCloseSenderUseArrayBuffer extends ToRefSenderUseArrayBuffer {
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
    await this.async_send(targets, new Uint32Array([fd]));
  }

  get(
    id: number,
  ): Array<number> | undefined {
    const data = this.get_data(id);
    if (data === undefined) {
      return undefined;
    }

    const array = [];
    for (const i of data) {
      array.push(i[0]);
    }

    return array;
  }
}
