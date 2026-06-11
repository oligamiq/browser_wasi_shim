import { ByteReader } from "./ByteReader.js";
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
import type { JsonValue } from "./types.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function decodeStrictJsonValue(bytes: Uint8Array): JsonValue {
  const reader = new ByteReader(bytes);
  const value = decodeValue(reader, 0);

  if (!reader.done()) {
    throw new Error("Trailing bytes after root value");
  }

  return value;
}

const MAX_DEPTH = 1000;

function decodeValue(r: ByteReader, depth: number): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new Error("Maximum nesting depth exceeded");
  }

  const tag = r.u8();

  switch (tag) {
    case TAG_NULL:
      return null;

    case TAG_FALSE:
      return false;

    case TAG_TRUE:
      return true;

    case TAG_NUMBER:
      return r.f64();

    case TAG_STRING:
      return readString(r);

    case TAG_ARRAY:
      return readArray(r, depth + 1);

    case TAG_OBJECT:
      return readObject(r, depth + 1);

    case TAG_PACKED_U8_ARRAY:
      return readPackedU8Array(r);

    case TAG_PACKED_I32_ARRAY:
      return readPackedI32Array(r);

    case TAG_PACKED_F64_ARRAY:
      return readPackedF64Array(r);

    default:
      throw new TypeError(`Unknown tag: ${tag}`);
  }
}

function readString(r: ByteReader): string {
  const length = r.varuint();
  const bytes = r.bytes(length);
  return textDecoder.decode(bytes);
}

function readArray(r: ByteReader, depth: number): JsonValue[] {
  const length = r.varuint();
  const arr: JsonValue[] = new Array(length);

  for (let i = 0; i < length; i++) {
    arr[i] = decodeValue(r, depth);
  }

  return arr;
}

function readObject(
  r: ByteReader,
  depth: number,
): { [key: string]: JsonValue } {
  const count = r.varuint();
  const obj: { [key: string]: JsonValue } = {};

  for (let i = 0; i < count; i++) {
    const key = decodeValue(r, depth);

    if (typeof key !== "string") {
      throw new TypeError("Object key is not a string");
    }

    obj[key] = decodeValue(r, depth);
  }

  return obj;
}

function readPackedU8Array(r: ByteReader): number[] {
  const length = r.varuint();
  const out = new Array<number>(length);

  for (let i = 0; i < length; i++) {
    out[i] = r.u8();
  }

  return out;
}

function readPackedI32Array(r: ByteReader): number[] {
  const length = r.varuint();
  const out = new Array<number>(length);

  for (let i = 0; i < length; i++) {
    out[i] = r.i32();
  }

  return out;
}

function readPackedF64Array(r: ByteReader): number[] {
  const length = r.varuint();
  const out = new Array<number>(length);

  for (let i = 0; i < length; i++) {
    out[i] = r.f64();
  }

  return out;
}
