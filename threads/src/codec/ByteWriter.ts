export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  offset = 0;

  constructor(initialSize = 1024) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const required = this.offset + extra;
    if (required <= this.buf.length) return;

    let nextSize = this.buf.length * 2;
    while (nextSize < required) {
      nextSize *= 2;
    }

    const next = new Uint8Array(nextSize);
    next.set(this.buf);

    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.offset++] = value & 0xff;
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.length);
    this.buf.set(value, this.offset);
    this.offset += value.length;
  }

  i32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  varuint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Invalid varuint");
    }

    while (value >= 0x80) {
      this.u8((value & 0x7f) | 0x80);
      value = Math.floor(value / 0x80);
    }

    this.u8(value);
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.offset);
  }
}
