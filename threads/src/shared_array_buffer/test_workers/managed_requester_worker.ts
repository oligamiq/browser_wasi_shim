import { thread_spawn_on_worker } from "../thread_spawn.ts";
import {
  DESTROY_REQUESTER_STATUS,
  readLifecycle,
} from "../worker_lifecycle.ts";

globalThis.onmessage = (
  event: MessageEvent<Parameters<typeof thread_spawn_on_worker>[0]>,
) => {
  void thread_spawn_on_worker(
    event.data,
    async () => {
      throw new Error("managed requester should stop before instantiation");
    },
    async (animal) => {
      globalThis.postMessage({
        animal_id: event.data.animal_id,
        msg: "ready",
      });
      const channel = new BroadcastChannel(event.data.args[0]);
      const destroyView = new Int32Array(
        animal.create_destroyer().get_object().destroy_status,
      );
      channel.postMessage({ type: "requesting" });
      await new Promise<void>((resolve) => {
        channel.onmessage = (controlEvent: MessageEvent<{ type?: string }>) => {
          if (controlEvent.data.type === "begin-destroy") resolve();
        };
      });
      await animal.async_destroy();
      channel.postMessage({
        lifecycle: readLifecycle(destroyView),
        requester_status: Atomics.load(destroyView, DESTROY_REQUESTER_STATUS),
        type: "resolved",
      });
      // Keep thread_spawn_on_worker from emitting another terminal message first.
      await new Promise<never>(() => undefined);
    },
  );
};
