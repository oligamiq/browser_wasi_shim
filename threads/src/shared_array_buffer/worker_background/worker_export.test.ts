import assert from "node:assert";
import test from "node:test";
import { createDestroyStatus } from "../worker_lifecycle.ts";
import { WorkerBackgroundRefObjectConstructor } from "./worker_export.ts";

test("shares destroy lifecycle with the coordinator reference", () => {
  const destroyStatus = createDestroyStatus();
  const object = WorkerBackgroundRefObjectConstructor(destroyStatus);

  assert.strictEqual(object.destroy_status, destroyStatus);
  assert.strictEqual(object.signature_input.byteLength, 32);
});
