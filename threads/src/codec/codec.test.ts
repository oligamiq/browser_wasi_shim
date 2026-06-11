import test from "node:test";
import assert from "node:assert";
import { encodeStrictJsonValue, decodeStrictJsonValue } from "./index.js";

function roundtrip(value: unknown) {
  const encoded = encodeStrictJsonValue(value);
  const decoded = decodeStrictJsonValue(encoded);
  assert.deepStrictEqual(decoded, value);
}

function expectThrowEncode(value: unknown, messageIncludes?: string) {
  assert.throws(
    () => {
      encodeStrictJsonValue(value);
    },
    (err: Error) => {
      if (messageIncludes && !err.message.includes(messageIncludes)) {
        return false;
      }
      return true;
    },
  );
}

test("normal values", () => {
  roundtrip(null);
  roundtrip(true);
  roundtrip(false);
  roundtrip(0);
  roundtrip(1.5);
  roundtrip(-123);
  roundtrip("hello");
  roundtrip("日本語");
  roundtrip("emoji 😺");
  roundtrip([]);
  roundtrip([1, 2, 3]);
  roundtrip(["a", true, null]);
  roundtrip({});
  roundtrip({ a: 1, b: "x", c: [true, null] });
});

test("packed arrays", () => {
  const u8Array = new Array(40).fill(0).map((_, i) => i % 256);
  roundtrip(u8Array);

  const i32Array = new Array(40).fill(0).map((_, i) => -100000 + i);
  roundtrip(i32Array);

  const f64Array = new Array(40).fill(0).map((_, i) => i + 0.5);
  roundtrip(f64Array);
});

test("nested object", () => {
  roundtrip({
    level1: {
      level2: {
        level3: "deep",
        arr: [1, 2, { x: 100 }],
      },
    },
  });
});

test("panics: invalid types", () => {
  expectThrowEncode(undefined);
  expectThrowEncode(NaN);
  expectThrowEncode(Infinity);
  expectThrowEncode(-Infinity);
  expectThrowEncode(123n);
  expectThrowEncode(Symbol("sym"));
  expectThrowEncode(() => {});
  expectThrowEncode(new Date());
  expectThrowEncode(new Map());
  expectThrowEncode(new Set());
  expectThrowEncode(/x/);
  expectThrowEncode(new Uint8Array());

  class MyClass {
    a = 1;
  }
  expectThrowEncode(new MyClass(), "Only plain objects");
  expectThrowEncode(Object.create(Date.prototype), "Only plain objects");
});

test("panics: array elements", () => {
  expectThrowEncode([undefined]);
  expectThrowEncode([1, NaN]);
  expectThrowEncode([1, Infinity]);

  const sparse = [];
  sparse[3] = 1;
  expectThrowEncode(sparse, "Sparse array");
});

test("panics: object properties", () => {
  expectThrowEncode({ a: undefined });
  expectThrowEncode({ a: NaN });
  expectThrowEncode({ a: () => {} });

  const obj1 = {};
  Object.defineProperty(obj1, "x", {
    get() {
      return 1;
    },
    enumerable: true,
  });
  expectThrowEncode(obj1, "Accessor property");

  const obj2 = {};
  Object.defineProperty(obj2, "hidden", { value: 1, enumerable: false });
  expectThrowEncode(obj2, "Non-enumerable");

  const sym = Symbol("x");
  const obj3 = { [sym]: 1 };
  expectThrowEncode(obj3, "Symbol keys");
});

test("panics: circular references", () => {
  const a: any = {};
  a.self = a;
  expectThrowEncode(a, "Circular");

  const arr: any[] = [];
  arr.push(arr);
  expectThrowEncode(arr, "Circular");
});

test("panics: depth limit", () => {
  let deepObj: any = null;
  for (let i = 0; i < 1005; i++) {
    deepObj = { child: deepObj };
  }
  expectThrowEncode(deepObj, "Maximum nesting depth exceeded");
});

test("panics: trailing bytes", () => {
  const bytes = encodeStrictJsonValue({ a: 1 });
  const badBytes = new Uint8Array(bytes.length + 1);
  badBytes.set(bytes);
  badBytes[bytes.length] = 0x00;

  assert.throws(() => {
    decodeStrictJsonValue(badBytes);
  }, /Trailing bytes/);
});
