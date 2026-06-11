import { ByteWriter } from "./ByteWriter.js";
import {
  TAG_NULL,
  TAG_FALSE,
  TAG_TRUE,
  TAG_NUMBER,
  TAG_STRING,
  TAG_ARRAY,
  TAG_OBJECT,
  TAG_PACKED_U8_ARRAY,
  TAG_PACKED_I32_ARRAY,
  TAG_PACKED_F64_ARRAY,
} from "./tags.js";

const textEncoder = new TextEncoder();

type EncodeContext = {
  seen: WeakSet<object>;
  depth: number;
};

const MAX_DEPTH = 1000;

export function encodeStrictJsonValue(value: unknown): Uint8Array {
  const writer = new ByteWriter();
  const ctx: EncodeContext = {
    seen: new WeakSet(),
    depth: 0,
  };

  encodeValue(value, writer, ctx);

  return writer.finish();
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function detectPackedArray(arr: unknown[]): "u8" | "i32" | "f64" | null {
  if (arr.length < 32) return null;

  let allNumber = true;
  let allU8 = true;
  let allI32 = true;

  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];

    if (typeof v !== "number") {
      allNumber = false;
      break;
    }

    if (!Number.isFinite(v)) {
      throw new TypeError(`Invalid number in array at index ${i}: ${v}`);
    }

    if (!Number.isInteger(v) || v < 0 || v > 255) {
      allU8 = false;
    }

    if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) {
      allI32 = false;
    }
  }

  if (!allNumber) return null;
  if (allU8) return "u8";
  if (allI32) return "i32";
  return "f64";
}

function writeString(value: string, w: ByteWriter): void {
  const bytes = textEncoder.encode(value);
  w.u8(TAG_STRING);
  w.varuint(bytes.length);
  w.bytes(bytes);
}

function encodeArray(arr: unknown[], w: ByteWriter, ctx: EncodeContext): void {
  for (let i = 0; i < arr.length; i++) {
    if (!(i in arr)) {
      throw new TypeError(`Sparse array is not supported at index ${i}`);
    }
  }

  const packed = detectPackedArray(arr);

  if (packed === "u8") {
    w.u8(TAG_PACKED_U8_ARRAY);
    w.varuint(arr.length);
    for (let i = 0; i < arr.length; i++) {
      w.u8(arr[i] as number);
    }
    return;
  }

  if (packed === "i32") {
    w.u8(TAG_PACKED_I32_ARRAY);
    w.varuint(arr.length);
    for (let i = 0; i < arr.length; i++) {
      w.i32(arr[i] as number);
    }
    return;
  }

  if (packed === "f64") {
    w.u8(TAG_PACKED_F64_ARRAY);
    w.varuint(arr.length);
    for (let i = 0; i < arr.length; i++) {
      w.f64(arr[i] as number);
    }
    return;
  }

  w.u8(TAG_ARRAY);
  w.varuint(arr.length);
  for (let i = 0; i < arr.length; i++) {
    encodeValue(arr[i], w, ctx);
  }
}

function encodeObject(obj: object, w: ByteWriter, ctx: EncodeContext): void {
  if (!isPlainObject(obj)) {
    throw new TypeError("Only plain objects are supported");
  }

  if (Object.getOwnPropertySymbols(obj).length > 0) {
    throw new TypeError("Symbol keys are not supported");
  }

  const allNames = Object.getOwnPropertyNames(obj);
  const enumerableNames = Object.keys(obj);

  if (allNames.length !== enumerableNames.length) {
    throw new TypeError("Non-enumerable properties are not supported");
  }

  for (const key of enumerableNames) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || !("value" in desc)) {
      throw new TypeError(`Accessor property is not supported: ${key}`);
    }
  }

  w.u8(TAG_OBJECT);
  w.varuint(enumerableNames.length);

  for (const key of enumerableNames) {
    writeString(key, w);
    encodeValue((obj as any)[key], w, ctx);
  }
}

function encodeValue(value: unknown, w: ByteWriter, ctx: EncodeContext): void {
  if (value === null) {
    w.u8(TAG_NULL);
    return;
  }

  if (value === false) {
    w.u8(TAG_FALSE);
    return;
  }

  if (value === true) {
    w.u8(TAG_TRUE);
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Invalid JSON number: ${value}`);
    }

    w.u8(TAG_NUMBER);
    w.f64(value);
    return;
  }

  if (typeof value === "string") {
    writeString(value, w);
    return;
  }

  if (Array.isArray(value)) {
    if (ctx.seen.has(value)) {
      throw new TypeError("Circular reference detected");
    }
    ctx.seen.add(value);

    ctx.depth++;
    if (ctx.depth > MAX_DEPTH) {
      throw new Error("Maximum nesting depth exceeded");
    }
    encodeArray(value, w, ctx);
    ctx.depth--;

    ctx.seen.delete(value);
    return;
  }

  if (typeof value === "object") {
    if (ctx.seen.has(value)) {
      throw new TypeError("Circular reference detected");
    }
    ctx.seen.add(value);

    ctx.depth++;
    if (ctx.depth > MAX_DEPTH) {
      throw new Error("Maximum nesting depth exceeded");
    }
    encodeObject(value, w, ctx);
    ctx.depth--;

    ctx.seen.delete(value);
    return;
  }

  throw new TypeError(`Unsupported value type: ${typeof value}`);
}
