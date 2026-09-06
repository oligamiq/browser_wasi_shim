import {
  WorkerBackgroundRef,
  type WorkerBackgroundRefObject,
} from "./shared_array_buffer/worker_background/index.ts";
import {
  beginDestroy,
  markRequesterClosing,
  readRequesterAnimalId,
  waitForDestroyTerminal,
  waitForRequesterDrained,
} from "./shared_array_buffer/worker_lifecycle.ts";

/** Represents the serialized state of a DestroyerHandle for thread transfer. */
export interface DestroyerHandleObject {
  sender: WorkerBackgroundRefObject;
  destroy_status: SharedArrayBuffer;
}

/** Coordinates destruction through a shared worker lifecycle capability. */
export class DestroyerHandle {
  private requester_shutdown?: Promise<void>;

  constructor(
    private readonly sender: WorkerBackgroundRef,
    private readonly destroy_status: SharedArrayBuffer,
    private readonly requester_animal_id?: number,
  ) {}

  /** Reconstructs an unbound handle for an external controller. */
  static init_self(obj: DestroyerHandleObject): DestroyerHandle {
    return new DestroyerHandle(
      WorkerBackgroundRef.init_self(obj.sender),
      obj.destroy_status,
    );
  }

  /** Reconstructs a handle bound to a managed requester's local Animal ID. */
  static init_bound(
    obj: DestroyerHandleObject,
    requesterAnimalId: number,
  ): DestroyerHandle {
    return new DestroyerHandle(
      WorkerBackgroundRef.init_self(obj.sender),
      obj.destroy_status,
      requesterAnimalId,
    );
  }

  get_object(): DestroyerHandleObject {
    return {
      sender: this.sender.get_object(),
      destroy_status: this.destroy_status,
    };
  }

  /** Synchronously rejects new work and initiates runtime-wide teardown. */
  destroy(): void {
    const view = new Int32Array(this.destroy_status);
    if (beginDestroy(view, this.requester_animal_id)) {
      this.sender.notify_destroy();
      if (this.requester_animal_id !== undefined) {
        void this.schedule_requester_shutdown(view).catch(() => undefined);
      }
    }
  }

  /**
   * Observes logical teardown and issued termination operations.
   *
   * An elected managed requester resolves after every other managed Worker has
   * received termination and its own close has been scheduled. Browser hosts
   * do not provide a physical thread join.
   */
  async async_destroy(): Promise<void> {
    const view = new Int32Array(this.destroy_status);
    const won = beginDestroy(view, this.requester_animal_id);
    if (won) this.sender.notify_destroy();
    const isElectedRequester =
      this.requester_animal_id !== undefined &&
      readRequesterAnimalId(view) === this.requester_animal_id;
    if (isElectedRequester) {
      await this.schedule_requester_shutdown(view);
      return;
    }
    await waitForDestroyTerminal(view);
  }

  private schedule_requester_shutdown(view: Int32Array): Promise<void> {
    this.requester_shutdown ??= (async () => {
      await waitForRequesterDrained(view);
      setTimeout(() => {
        markRequesterClosing(view);
        const close = Reflect.get(globalThis, "close");
        if (typeof close === "function") close.call(globalThis);
      }, 0);
    })();
    return this.requester_shutdown;
  }
}
