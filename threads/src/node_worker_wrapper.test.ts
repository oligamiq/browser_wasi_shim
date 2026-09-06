import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

let outputDirectory: string;
let workerPath: string;

before(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "browser-wasi-node-wrapper-"));
  execFileSync(
    process.execPath,
    [
      "build",
      new URL("../examples/node_worker_wrapper_test.ts", import.meta.url)
        .pathname,
      "--target=node",
      "--format=cjs",
      "--outdir",
      outputDirectory,
    ],
    { stdio: "pipe" },
  );
  workerPath = join(outputDirectory, "node_worker_wrapper_test.js");
});

after(async () => {
  await rm(outputDirectory, { recursive: true, force: true });
});

describe("Node worker wrappers", () => {
  test("installs close only in disposable Node workers", () => {
    const output = execFileSync("node", [workerPath], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const result = JSON.parse(output) as {
      mainCloseUnchanged: boolean;
      mainGuards: boolean[];
      workers: Array<{ closeSource: string; closeType: string }>;
    };

    assert.deepEqual(result.mainGuards, [true, true]);
    assert.equal(result.mainCloseUnchanged, true);
    assert.equal(result.workers.length, 2);
    for (const worker of result.workers) {
      assert.equal(worker.closeType, "function");
      assert.match(worker.closeSource, /process\.exit\(0\)/);
    }
  });
});
