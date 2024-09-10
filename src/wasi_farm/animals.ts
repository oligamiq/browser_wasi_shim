import { WASIFarmRef } from "./ref.js";

export class WASIFarmAnimals {
  args: Array<string>;
  env: Array<string>;

  wasi_farm_ref: WASIFarmRef;

  constructor(
    wasi_farm_ref: WASIFarmRef,
    args: Array<string>,
    env: Array<string>,
  ) {
    this.wasi_farm_ref = wasi_farm_ref;
    this.args = args;
    this.env = env;
  }
}
