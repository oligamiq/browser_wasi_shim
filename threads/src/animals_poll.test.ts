import assert from "node:assert";
import { test } from "node:test";
import { wasi } from "@bjorn3/browser_wasi_shim";
import { WASIFarmAnimal } from "./animals.ts";

function createClockAnimal(): WASIFarmAnimal {
  // poll_oneoff only needs guest memory, not a live Farm dispatcher.
  const mapping = Reflect.get(WASIFarmAnimal.prototype, "mapping_fds");
  Reflect.set(WASIFarmAnimal.prototype, "mapping_fds", () => undefined);
  try {
    const animal = new WASIFarmAnimal([], [], []);
    animal.inst = {
      exports: { memory: new WebAssembly.Memory({ initial: 1 }) },
    };
    return animal;
  } finally {
    Reflect.set(WASIFarmAnimal.prototype, "mapping_fds", mapping);
  }
}

for (const clock of [wasi.CLOCKID_REALTIME, wasi.CLOCKID_MONOTONIC]) {
  for (const absolute of [false, true]) {
    for (const precision of [0n, 2_000_000n]) {
      test(`poll_oneoff clock ${clock} ${absolute ? "absolute" : "relative"} precision ${precision}`, () => {
        checkClockWait(clock, absolute, 10_000_000n, precision, [
          10 - Number(precision / 1_000_000n),
        ]);
      });
    }
  }
}

test("poll_oneoff reads flags independently of precision's high bytes", () => {
  const precision = 1n << 32n;
  checkClockWait(
    wasi.CLOCKID_REALTIME,
    false,
    precision + 10_000_000n,
    precision,
    [10],
  );
});

for (const [duration, precision] of [
  [-1_000_000n, 0n],
  [10_000_000n, 10_000_000n],
  [10_000_000n, 11_000_000n],
  [500_000n, 0n],
] as const) {
  test(`poll_oneoff avoids a whole-millisecond wait for ${duration} minus ${precision}`, () => {
    checkClockWait(wasi.CLOCKID_MONOTONIC, true, duration, precision, []);
  });
}

function checkClockWait(
  clock: number,
  absolute: boolean,
  duration: bigint,
  precision: bigint,
  expectedWaits: number[],
): void {
  const animal = createClockAnimal();
  const buffer = new DataView(animal.inst!.exports.memory.buffer);
  const input = 16;
  const output = 128;
  const count = 160;
  buffer.setBigUint64(input, 42n, true);
  buffer.setUint8(input + 8, wasi.EVENTTYPE_CLOCK);
  buffer.setUint32(input + 16, clock, true);
  buffer.setBigUint64(
    input + 24,
    (absolute ? 100_000_000n : 0n) + duration,
    true,
  );
  buffer.setBigUint64(input + 32, precision, true);
  buffer.setUint16(
    input + 40,
    absolute ? wasi.SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME : 0,
    true,
  );

  const dateNow = Date.now;
  const performanceNow = performance.now;
  const wait = Atomics.wait;
  const waits: number[] = [];
  try {
    Date.now = () => 100;
    performance.now = () => 100;
    Atomics.wait = (_view, _index, _value, timeout) => {
      waits.push(timeout ?? Infinity);
      return "timed-out";
    };
    assert.strictEqual(
      animal.wasiImport.poll_oneoff(input, output, 1, count),
      wasi.ERRNO_SUCCESS,
    );
    assert.deepStrictEqual(waits, expectedWaits);
    assert.strictEqual(buffer.getBigUint64(output, true), 42n);
    assert.strictEqual(buffer.getUint16(output + 8, true), wasi.ERRNO_SUCCESS);
    assert.strictEqual(buffer.getUint8(output + 10), wasi.EVENTTYPE_CLOCK);
    assert.strictEqual(buffer.getUint32(count, true), 1);
  } finally {
    Date.now = dateNow;
    performance.now = performanceNow;
    Atomics.wait = wait;
    animal.destroy();
  }
}
