console.log("thread_spawn1.js");

// import { thread_spawn_on_worker } from "../../dist/wasi_farm/shared_array_buffer/thread_spawn.js";

self.postMessage("thread_spawn2.js");

// console.log("thread_spawn2.js");

// self.onmessage = (event) => {
//   thread_spawn_on_worker(event.data);
// }
