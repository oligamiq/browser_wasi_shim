import { thread_spawn_on_worker } from "../thread_spawn.ts";

globalThis.onmessage = (
  event: MessageEvent<Parameters<typeof thread_spawn_on_worker>[0]>,
) => {
  void thread_spawn_on_worker(
    event.data,
    async () => {
      throw new Error("instantiate should not run");
    },
    async () => {
      await Promise.resolve();
      throw new Error("animal construction callback failed");
    },
  );
};
