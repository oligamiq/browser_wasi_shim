import { ThreadSpawner } from "../thread_spawn.ts";

type SpawnRequest = {
  args: string[];
  fd_map: [number, number][];
  request_id: string;
  spawner: Parameters<typeof ThreadSpawner.init_self>[0];
};

globalThis.onmessage = (event: MessageEvent<SpawnRequest>) => {
  const { args, fd_map: fdMap, request_id: requestId, spawner } = event.data;
  try {
    ThreadSpawner.init_self(spawner).thread_spawn(0, args, [], fdMap);
    globalThis.postMessage({ request_id: requestId, type: "spawned" });
  } catch (error) {
    globalThis.postMessage({
      error: error instanceof Error ? error.message : String(error),
      request_id: requestId,
      type: "spawn-error",
    });
  }
};
