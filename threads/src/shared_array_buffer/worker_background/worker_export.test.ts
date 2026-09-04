import { expect, test } from "bun:test";
import { createDestroyStatus } from "../worker_lifecycle.ts";
import { WorkerBackgroundRefObjectConstructor } from "./worker_export.ts";

test("shares destroy lifecycle with the coordinator reference", () => {
  const destroyStatus = createDestroyStatus();
  const object = WorkerBackgroundRefObjectConstructor(destroyStatus);

  expect(object.destroy_status).toBe(destroyStatus);
  expect(object.signature_input.byteLength).toBe(32);
});
