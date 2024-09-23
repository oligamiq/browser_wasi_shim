import { thread_spawn_on_worker } from "../thread_spawn.js";

console.log("thread_spawn1.js");

self.postMessage("thread_spawn2.js");

// console.log("thread_spawn2.js");

self.onmessage = (event) => {
  thread_spawn_on_worker(event.data);
}
