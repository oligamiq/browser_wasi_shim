import { thread_spawn_on_worker } from "../thread_spawn.ts";

type Trigger = {
  animal_id?: number;
  outcome?: "error" | "exit";
  token?: string;
  type?: string;
};

globalThis.onmessage = (
  event: MessageEvent<Parameters<typeof thread_spawn_on_worker>[0]>,
) => {
  void thread_spawn_on_worker(
    event.data,
    async () => {
      throw new Error(
        "observable managed Animal should remain in its callback",
      );
    },
    async () => {
      const { animal_id: animalId } = event.data;
      const [channelName, token] = event.data.args;
      const channel = new BroadcastChannel(channelName);
      let seq = 0;
      channel.postMessage({
        animal_id: animalId,
        token,
        type: "managed-ready",
      });
      setInterval(() => {
        channel.postMessage({
          animal_id: animalId,
          seq: seq++,
          token,
          type: "heartbeat",
        });
      }, 5);
      channel.onmessage = (triggerEvent: MessageEvent<Trigger>) => {
        const trigger = triggerEvent.data;
        if (
          trigger.type !== "trigger" ||
          trigger.animal_id !== animalId ||
          trigger.token !== token
        ) {
          return;
        }
        if (trigger.outcome === "error") {
          globalThis.postMessage({
            animal_id: animalId,
            error: new Error("real Animal error"),
            msg: "error",
          });
        } else if (trigger.outcome === "exit") {
          globalThis.postMessage({
            animal_id: animalId,
            code: 23,
            msg: "exit",
          });
        }
      };
      globalThis.postMessage({ animal_id: animalId, msg: "ready" });
      await new Promise<never>(() => undefined);
    },
  );
};
