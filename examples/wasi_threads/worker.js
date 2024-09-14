
import { File, OpenFile, ConsoleStdout, PreopenDirectory, WASIFarm } from "../../dist/index.js";

(async () => {
  let wasi_farm = new WASIFarm(
    new OpenFile(new File([])), // stdin
    ConsoleStdout.lineBuffered(msg => console.log(`[WASI stdout] ${msg}`)),
    ConsoleStdout.lineBuffered(msg => console.warn(`[WASI stderr] ${msg}`)),
    [
      new PreopenDirectory(".", [
        ["hello.txt", new File(new TextEncoder().encode("Hello, world!"))],
      ]),
    ],
    { debug: true },
  );
  console.log("WASI farm created");
  let wasi_ref = await wasi_farm.get_ref();
  if (Worker) {
    const myWorker1 = new Worker("./worker1.js", { type: "module" });
    myWorker1.postMessage({ wasi_ref });
    const myWorker2 = new Worker("./worker2.js", { type: "module" });
    myWorker2.postMessage({ wasi_ref });
    const myWorker3 = new Worker("./worker3.js", { type: "module" });
    myWorker3.postMessage({ wasi_ref });
  } else {
    console.error("Web Workers are not supported in this environment.");
  }
})();
