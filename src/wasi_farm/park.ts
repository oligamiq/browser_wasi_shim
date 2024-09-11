import { WASIFarmRef } from "./ref.js";

export abstract class WASIFarmPark {
  abstract get_ref(): WASIFarmRef;
  abstract listen(): void;
}
