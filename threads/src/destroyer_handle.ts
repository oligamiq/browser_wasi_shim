import type { WorkerBackgroundRef } from "./shared_array_buffer/worker_background";

export interface DestroyerHandleObject {
  sender: WorkerBackgroundRef;
  destroy_status: SharedArrayBuffer;
}

export class DestroyerHandle {
  private sender: WorkerBackgroundRef;
  private destroy_status: SharedArrayBuffer;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: <explanation>
  private listen_holder: Promise<void>;

  constructor(sender: WorkerBackgroundRef, destroy_status: SharedArrayBuffer) {
    this.sender = sender;
    this.destroy_status = destroy_status;
    this.listen_holder = this.listen();
  }

  static init_self(obj: DestroyerHandleObject): DestroyerHandle {
    return new DestroyerHandle(obj.sender, obj.destroy_status);
  }

  get_object(): DestroyerHandleObject {
    return {
      destroy_status: this.destroy_status,
      sender: this.sender,
    };
  }

  async listen(): Promise<void> {
    const view = new Int32Array(this.destroy_status);
    // idx=0: lock flag (0-based indexing)
    const { value } = Atomics.waitAsync(view, 0, 1);
    if ((await value) === "timed-out") {
      throw new Error("destroy listen timed out");
    }

    // Cleanup after receiving notification
    this.cleanup();
  }

  private cleanup(): void {
    // Release all references to allow garbage collection
    // biome-ignore lint: suspicious/noUnnecessaryTypeAssertion: <explanation>
    this.destroy_status = null as unknown as SharedArrayBuffer;
    // biome-ignore lint: suspicious/noUnnecessaryTypeAssertion: <explanation>
    this.sender = null as unknown as WorkerBackgroundRef;
  }

  destroy(): void {
    const view = new Int32Array(this.destroy_status);
    // Acquire lock at idx=0 (user's idx=1)
    Atomics.store(view, 0, 1);
    // Set notification flag at idx=1 (user's idx=2)
    Atomics.store(view, 1, 1);
    this.sender.destroy();

    // Signal completion after destroy completes
    Atomics.store(view, 0, 0);
    Atomics.notify(view, 0);
  }
}
