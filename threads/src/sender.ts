/**
 * FdCloseSender defines the interface for broadcasting file descriptor closures
 * to multiple worker threads.
 */
export interface FdCloseSender {
  /**
   * Sends a closure notification to target worker IDs.
   *
   * @param targets The list of worker IDs to notify.
   * @param fd The file descriptor index that was closed.
   */
  send(targets: Array<number>, fd: number): Promise<void>;

  /**
   * Retrieves the list of closed FDs for a specific worker ID.
   *
   * @param id The worker ID.
   * @returns An array of closed FD indices, or undefined if none.
   */
  get(id: number): Array<number> | undefined;
}
