import type { FdCloseSender } from "../sender.ts";
import {
  ToRefSenderUseArrayBuffer,
  type ToRefSenderUseArrayBufferObject,
} from "./sender.ts";

/**
 * Represents the serialized state of an FdCloseSenderUseArrayBuffer for thread transfer.
 */
export type FdCloseSenderUseArrayBufferObject = {
  max_share_arrays_memory?: number;
  share_arrays_memory?: SharedArrayBuffer;
} & ToRefSenderUseArrayBufferObject;

// Object to tell other processes,
// such as child processes,
// that the file descriptor has been closed
/**
 * Implements FdCloseSender using a SharedArrayBuffer for cross-thread communication.
 *
 * It broadcasts closed file descriptors to child processes and other threads
 * in a thread-safe manner.
 */
export class FdCloseSenderUseArrayBuffer
  extends ToRefSenderUseArrayBuffer
  implements FdCloseSender
{
  // Should be able to change the size of memory as it accumulates more and more on memory
  /**
   * Creates a sender and initializes its shared-memory headers.
   *
   * @param max_share_arrays_memory Optional maximum size for the shared memory buffer.
   * @param share_arrays_memory Optional existing SharedArrayBuffer to use.
   * @param initialize Whether to initialize the buffer headers. Attachments pass false.
   */
  constructor(
    max_share_arrays_memory?: number,
    share_arrays_memory?: SharedArrayBuffer,
    initialize = true,
  ) {
    super(4, max_share_arrays_memory, share_arrays_memory, initialize);
  }

  // Send the closed file descriptor to the target process
  async send(targets: Array<number>, fd: number): Promise<void> {
    if (targets === undefined || targets.length === 0) {
      throw new Error("targets is empty");
    }
    // console.log("fd_close_sender send", targets, fd);

    await this.async_send(targets, new Uint32Array([fd]));
  }

  // Get the closed file descriptor from the target process
  get(id: number): Array<number> | undefined {
    const data = this.get_data(id);
    if (data === undefined) {
      return undefined;
    }

    // console.log("fd_close_sender get", data);

    const array = [];
    for (const i of data) {
      array.push(i[0]);
    }

    return array;
  }

  /**
   * Returns cloneable state for attaching another fd-close sender.
   *
   * @returns The sender data size and shared-memory buffer.
   */
  override get_object(): FdCloseSenderUseArrayBufferObject {
    return super.get_object();
  }

  // Initialize the class from object
  /**
   * Attaches a sender to transferred shared state without resetting queued data.
   *
   * @param sl The serialized sender state.
   * @returns A new FdCloseSenderUseArrayBuffer instance.
   */
  static init_self(
    sl: FdCloseSenderUseArrayBufferObject,
  ): FdCloseSenderUseArrayBuffer {
    const sel = ToRefSenderUseArrayBuffer.init_self_inner(sl);
    return new FdCloseSenderUseArrayBuffer(
      sel.max_share_arrays_memory,
      sel.share_arrays_memory,
      false,
    );
  }
}
