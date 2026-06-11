export class ByteReader {
  private view: DataView;
  offset = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  ensure(extra: number): void {
    if (this.offset + extra > this.buf.length) {
      throw new RangeError("Unexpected end of input");
    }
  }

  u8(): number {
    this.ensure(1);
    return this.buf[this.offset++];
  }

  bytes(length: number): Uint8Array {
    this.ensure(length);
    const out = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  i32(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;

    if (!Number.isFinite(value)) {
      throw new TypeError(`Invalid encoded number: ${value}`);
    }

    return value;
  }

  varuint(): number {
    let result = 0;
    let shift = 0;

    for (let i = 0; i < 10; i++) {
      const byte = this.u8();

      result += (byte & 0x7f) * 2 ** shift;

      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) {
          throw new RangeError("varuint exceeds safe integer range");
        }
        return result;
      }

      shift += 7;
    }

    throw new RangeError("varuint is too long");
  }

  done(): boolean {
    return this.offset === this.buf.length;
  }
}
