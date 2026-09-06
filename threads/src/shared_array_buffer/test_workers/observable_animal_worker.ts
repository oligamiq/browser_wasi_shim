type Trigger = {
  animal_id?: number;
  outcome?: "error" | "exit";
  type?: string;
};

globalThis.onmessage = (
  event: MessageEvent<{ animal_id: number; args: string[] }>,
) => {
  const { animal_id: animalId } = event.data;
  const channel = new BroadcastChannel(event.data.args[0]);
  let seq = 0;
  channel.postMessage({ animal_id: animalId, type: "ready" });
  setInterval(() => {
    channel.postMessage({ animal_id: animalId, seq: seq++, type: "heartbeat" });
  }, 5);
  channel.onmessage = (triggerEvent: MessageEvent<Trigger>) => {
    const trigger = triggerEvent.data;
    if (trigger.type !== "trigger" || trigger.animal_id !== animalId) return;
    if (trigger.outcome === "error") {
      globalThis.postMessage({
        animal_id: animalId,
        error: new Error("real Animal error"),
        msg: "error",
      });
    } else if (trigger.outcome === "exit") {
      globalThis.postMessage({ animal_id: animalId, code: 23, msg: "exit" });
    }
  };
  globalThis.postMessage({ animal_id: animalId, msg: "ready" });
};
