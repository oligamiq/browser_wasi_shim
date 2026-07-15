import {
  decodeStrictJsonValue,
  encodeStrictJsonValue,
  type JsonValue,
} from "../codec/index.ts";
import {
  BaseCallAllocatorUseArrayBuffer,
  type BaseCallAllocatorUseArrayBufferObject,
} from "./base_call_allocator.ts";

const CONTROL_WORDS = 8;
const CONTROL_VERSION = 0;
const CONTROL_LIFECYCLE = 1;
const CONTROL_REQUEST_EPOCH = 2;
const CONTROL_FREE_SLOT_EPOCH = 3;
const CONTROL_USER_SLOT_COUNT = 5;

const SLOT_WORDS = 12;
const SLOT_STATE = 0;
const SLOT_GENERATION = 1;
const SLOT_OPCODE = 2;
const SLOT_FLAGS = 3;
const SLOT_REQUEST_POINTER = 4;
const SLOT_REQUEST_LENGTH = 5;
const SLOT_RESPONSE_POINTER = 6;
const SLOT_RESPONSE_LENGTH = 7;
const SLOT_ERROR_POINTER = 8;
const SLOT_ERROR_LENGTH = 9;
const SLOT_AUXILIARY = 10;
const SLOT_RESERVED = 11;

const SYSTEM_SLOT = 0;
const DEFAULT_USER_SLOT_COUNT = 128;
const MAX_USER_SLOT_COUNT = 1024;
const MAX_GENERATION = 0x7fffffff;
const MAX_ERROR_STRING_LENGTH = 65_536;
const MAX_ERROR_CAUSE_DEPTH = 8;

enum TransportLifecycle {
  Active = 0,
  Destroying = 1,
  Destroyed = 2,
}

enum SlotState {
  Free = 0,
  Writing = 1,
  Ready = 2,
  Running = 3,
  Done = 4,
  Error = 5,
  Cancelled = 6,
  Retired = 7,
}

type SlotIdentity = {
  slotIndex: number;
  generation: number;
};

type NormalizedError = {
  name: string;
  message: string;
  stack?: string;
  cause?: JsonValue;
};

/** @internal Observable synchronization points used only by transport tests. */
export const baseCallTestHooks: {
  beforeUserSlotClaim?: (slotIndex: number) => void;
  beforeDispatcherWait?: () => void;
  beforeWireDestroy?: () => void;
  beforeRequestPublication?: (
    slotIndex: number,
    opcode: BaseCallOpcode,
  ) => void;
} = {};

/**
 * Cloneable version-2 base-call state shared by one Park and its references.
 *
 * Cloning transfers no payload ownership. Attached agents must obey the slot
 * ownership and cancellation protocol implemented by the classes below.
 */
export type BaseCallTransportObject = {
  version: 2;
  userSlotCount: number;
  control: SharedArrayBuffer;
  slots: SharedArrayBuffer;
  allocator: BaseCallAllocatorUseArrayBufferObject;
};

/** Runtime operation numbers carried by the version-2 base-call protocol. */
export enum BaseCallOpcode {
  SetParkFdsMap = 0,
  DestroyPark = 1,
  CallUnknownFn = 2,
}

/**
 * Allocation-free terminal statuses carried in a slot when no error payload
 * can or should be owned by the receiving agent.
 */
export enum BaseCallTerminalError {
  Serialized = 1,
  OutOfMemory = 2,
  InvalidRequest = 3,
  Destroyed = 4,
  CodecError = 5,
}

/**
 * Raised when user slots are temporarily exhausted or when user or reserved
 * system-slot capacity has been permanently retired.
 */
export class BaseCallCapacityError extends Error {
  constructor() {
    super("base call capacity is exhausted or permanently retired");
    this.name = "BaseCallCapacityError";
  }
}

/**
 * Park-side callback for a claimed request. The request bytes are an owned
 * copy, so retaining them does not retain shared allocator ownership.
 */
export type BaseCallHandler = (
  opcode: BaseCallOpcode,
  payload: Uint8Array,
) => Promise<Uint8Array | undefined> | Uint8Array | undefined;

class BaseCallTerminalFailure extends Error {
  constructor(readonly status: BaseCallTerminalError) {
    super(`base call failed: ${BaseCallTerminalError[status]}`);
    this.name = `BaseCall${BaseCallTerminalError[status]}Error`;
  }
}

/**
 * Reference-side view of a version-2 base-call transport.
 *
 * Calls own request allocations until publication, then own terminal payloads
 * until they copy and free them. Cancellation wakes blocked agents.
 */
export class BaseCallRefUseArrayBuffer {
  private readonly control: Int32Array;
  private readonly slots: Int32Array;
  private readonly allocator: BaseCallAllocatorUseArrayBuffer;
  private readonly userSlotCount: number;
  private userSlotScanHint = 1;

  private constructor(
    control: Int32Array,
    slots: Int32Array,
    allocator: BaseCallAllocatorUseArrayBuffer,
    userSlotCount: number,
  ) {
    this.control = control;
    this.slots = slots;
    this.allocator = allocator;
    this.userSlotCount = userSlotCount;
  }

  /**
   * Attaches to cloned state without writing it. The calling agent acquires no
   * existing slot or payload ownership and must support SharedArrayBuffer.
   */
  static init_self(object: BaseCallTransportObject): BaseCallRefUseArrayBuffer {
    if (object?.version !== 2) {
      throw new TypeError("base call transport version must be 2");
    }
    if (
      !Number.isInteger(object.userSlotCount) ||
      object.userSlotCount < 1 ||
      object.userSlotCount > MAX_USER_SLOT_COUNT
    ) {
      throw new RangeError("base call user-slot count is invalid");
    }
    if (!(object.control instanceof SharedArrayBuffer)) {
      throw new TypeError("base call control must be a SharedArrayBuffer");
    }
    if (
      object.control.byteLength !==
      CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT
    ) {
      throw new RangeError("base call control has an invalid size");
    }
    if (!(object.slots instanceof SharedArrayBuffer)) {
      throw new TypeError("base call slots must be a SharedArrayBuffer");
    }
    const expectedSlotBytes =
      (object.userSlotCount + 1) * SLOT_WORDS * Int32Array.BYTES_PER_ELEMENT;
    if (object.slots.byteLength !== expectedSlotBytes) {
      throw new RangeError("base call slots have an invalid size");
    }

    const control = new Int32Array(object.control);
    if (Atomics.load(control, CONTROL_VERSION) !== 2) {
      throw new Error("base call control has an invalid protocol version");
    }
    if (
      Atomics.load(control, CONTROL_USER_SLOT_COUNT) !== object.userSlotCount
    ) {
      throw new Error("base call control has a mismatched user-slot count");
    }
    const lifecycle = Atomics.load(control, CONTROL_LIFECYCLE);
    if (
      lifecycle !== TransportLifecycle.Active &&
      lifecycle !== TransportLifecycle.Destroying &&
      lifecycle !== TransportLifecycle.Destroyed
    ) {
      throw new Error("base call control has an invalid lifecycle");
    }

    const allocator = BaseCallAllocatorUseArrayBuffer.init_self(
      object.allocator,
    );
    return new BaseCallRefUseArrayBuffer(
      control,
      new Int32Array(object.slots),
      allocator,
      object.userSlotCount,
    );
  }

  /**
   * Publishes a request and blocks this agent until completion or cancellation.
   * User-slot capacity fails immediately with `BaseCallCapacityError`; system
   * operations wait for their reserved slot. Do not call on an agent where
   * blocking `Atomics.wait` is forbidden or where the Park listener must run.
   */
  block_call(
    opcode: BaseCallOpcode,
    payload: Uint8Array,
  ): Uint8Array | undefined {
    this.validatePayload(payload);
    const system = this.isSystemOpcode(opcode);
    const identity = system
      ? this.claimSystemSlotBlocking(opcode)
      : this.tryClaimUserSlot();
    if (identity === undefined) {
      if (opcode === BaseCallOpcode.DestroyPark) {
        return undefined;
      }
      if (
        system ||
        Atomics.load(this.control, CONTROL_LIFECYCLE) !==
          TransportLifecycle.Active
      ) {
        throw new BaseCallTerminalFailure(BaseCallTerminalError.Destroyed);
      }
      throw new BaseCallCapacityError();
    }

    try {
      this.publishBlocking(identity, opcode, payload);
    } catch (error) {
      if (this.isIdempotentDestroyFailure(opcode, error)) {
        return undefined;
      }
      throw error;
    }
    return this.waitForTerminalBlocking(identity, opcode);
  }

  /**
   * Publishes a request and asynchronously waits for capacity and completion.
   * It never holds allocator ownership across handler execution; destruction
   * cancels the wait. The calling agent must support `Atomics.waitAsync`.
   */
  async async_call(
    opcode: BaseCallOpcode,
    payload: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    this.validatePayload(payload);
    const identity = this.isSystemOpcode(opcode)
      ? await this.claimSystemSlotAsync(opcode)
      : await this.claimUserSlotAsync();
    if (identity === undefined) {
      if (opcode === BaseCallOpcode.DestroyPark) {
        return undefined;
      }
      throw new BaseCallTerminalFailure(BaseCallTerminalError.Destroyed);
    }

    try {
      await this.publishAsync(identity, opcode, payload);
    } catch (error) {
      if (this.isIdempotentDestroyFailure(opcode, error)) {
        return undefined;
      }
      throw error;
    }
    return await this.waitForTerminalAsync(identity, opcode);
  }

  private validatePayload(payload: Uint8Array): void {
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError("base call payload must be a Uint8Array");
    }
  }

  private isSystemOpcode(opcode: BaseCallOpcode): boolean {
    return (
      opcode === BaseCallOpcode.SetParkFdsMap ||
      opcode === BaseCallOpcode.DestroyPark
    );
  }

  private isIdempotentDestroyFailure(
    opcode: BaseCallOpcode,
    error: unknown,
  ): boolean {
    return (
      opcode === BaseCallOpcode.DestroyPark &&
      error instanceof BaseCallTerminalFailure &&
      error.status === BaseCallTerminalError.Destroyed
    );
  }

  private tryClaimUserSlot(): SlotIdentity | undefined {
    if (
      Atomics.load(this.control, CONTROL_LIFECYCLE) !==
      TransportLifecycle.Active
    ) {
      return undefined;
    }
    let retiredCount = 0;
    const scanStart = this.userSlotScanHint;
    for (let offset = 0; offset < this.userSlotCount; offset++) {
      const slotIndex = ((scanStart - 1 + offset) % this.userSlotCount) + 1;
      const stateIndex = this.slotWord(slotIndex, SLOT_STATE);
      const state = Atomics.load(this.slots, stateIndex);
      if (state === SlotState.Retired) {
        retiredCount++;
        continue;
      }
      if (state !== SlotState.Free) {
        continue;
      }
      baseCallTestHooks.beforeUserSlotClaim?.(slotIndex);
      if (
        Atomics.compareExchange(
          this.slots,
          stateIndex,
          SlotState.Free,
          SlotState.Writing,
        ) !== SlotState.Free
      ) {
        continue;
      }
      const generationIndex = this.slotWord(slotIndex, SLOT_GENERATION);
      const generation = Atomics.load(this.slots, generationIndex);
      if (generation >= MAX_GENERATION) {
        Atomics.store(this.slots, stateIndex, SlotState.Retired);
        retiredCount++;
        this.notifySlotFreed(slotIndex);
        continue;
      }
      const nextGeneration = generation + 1;
      Atomics.store(this.slots, generationIndex, nextGeneration);
      this.clearSlotMetadata(slotIndex);
      this.userSlotScanHint = (slotIndex % this.userSlotCount) + 1;
      return { slotIndex, generation: nextGeneration };
    }
    if (retiredCount === this.userSlotCount) {
      throw new BaseCallCapacityError();
    }
    return undefined;
  }

  private async claimUserSlotAsync(): Promise<SlotIdentity | undefined> {
    while (true) {
      const observedFreeEpoch = Atomics.load(
        this.control,
        CONTROL_FREE_SLOT_EPOCH,
      );
      const identity = this.tryClaimUserSlot();
      if (identity !== undefined) {
        return identity;
      }
      if (
        Atomics.load(this.control, CONTROL_LIFECYCLE) !==
        TransportLifecycle.Active
      ) {
        return undefined;
      }
      await waitAsync(this.control, CONTROL_FREE_SLOT_EPOCH, observedFreeEpoch);
    }
  }

  private tryClaimSystemSlot(): SlotIdentity | undefined {
    if (
      Atomics.load(this.control, CONTROL_LIFECYCLE) !==
      TransportLifecycle.Active
    ) {
      return undefined;
    }
    const stateIndex = this.slotWord(SYSTEM_SLOT, SLOT_STATE);
    if (Atomics.load(this.slots, stateIndex) === SlotState.Retired) {
      throw new BaseCallCapacityError();
    }
    if (
      Atomics.compareExchange(
        this.slots,
        stateIndex,
        SlotState.Free,
        SlotState.Writing,
      ) !== SlotState.Free
    ) {
      return undefined;
    }
    const generationIndex = this.slotWord(SYSTEM_SLOT, SLOT_GENERATION);
    const generation = Atomics.load(this.slots, generationIndex);
    if (generation >= MAX_GENERATION) {
      Atomics.store(this.slots, stateIndex, SlotState.Retired);
      Atomics.notify(this.slots, stateIndex);
      throw new BaseCallCapacityError();
    }
    const nextGeneration = generation + 1;
    Atomics.store(this.slots, generationIndex, nextGeneration);
    this.clearSlotMetadata(SYSTEM_SLOT);
    return { slotIndex: SYSTEM_SLOT, generation: nextGeneration };
  }

  private claimSystemSlotBlocking(
    opcode: BaseCallOpcode,
  ): SlotIdentity | undefined {
    const stateIndex = this.slotWord(SYSTEM_SLOT, SLOT_STATE);
    while (true) {
      const observedState = Atomics.load(this.slots, stateIndex);
      const identity = this.tryClaimSystemSlot();
      if (identity !== undefined) {
        return identity;
      }
      if (
        Atomics.load(this.control, CONTROL_LIFECYCLE) !==
        TransportLifecycle.Active
      ) {
        if (opcode === BaseCallOpcode.DestroyPark) {
          return undefined;
        }
        throw new BaseCallTerminalFailure(BaseCallTerminalError.Destroyed);
      }
      Atomics.wait(this.slots, stateIndex, observedState);
    }
  }

  private async claimSystemSlotAsync(
    opcode: BaseCallOpcode,
  ): Promise<SlotIdentity | undefined> {
    const stateIndex = this.slotWord(SYSTEM_SLOT, SLOT_STATE);
    while (true) {
      const observedState = Atomics.load(this.slots, stateIndex);
      const identity = this.tryClaimSystemSlot();
      if (identity !== undefined) {
        return identity;
      }
      if (
        Atomics.load(this.control, CONTROL_LIFECYCLE) !==
        TransportLifecycle.Active
      ) {
        if (opcode === BaseCallOpcode.DestroyPark) {
          return undefined;
        }
        throw new BaseCallTerminalFailure(BaseCallTerminalError.Destroyed);
      }
      await waitAsync(this.slots, stateIndex, observedState);
    }
  }

  private publishBlocking(
    identity: SlotIdentity,
    opcode: BaseCallOpcode,
    payload: Uint8Array,
  ): void {
    let allocation: [number, number] | undefined;
    try {
      allocation = this.allocator.block_write(payload);
    } catch {
      this.releaseWritingSlot(identity);
      throw new BaseCallTerminalFailure(BaseCallTerminalError.OutOfMemory);
    }
    try {
      this.publishOwnedRequest(identity, opcode, allocation);
      allocation = undefined;
    } finally {
      if (allocation !== undefined) {
        this.allocator.free(...allocation);
        this.releaseWritingSlot(identity);
      }
    }
  }

  private async publishAsync(
    identity: SlotIdentity,
    opcode: BaseCallOpcode,
    payload: Uint8Array,
  ): Promise<void> {
    let allocation: [number, number] | undefined;
    try {
      allocation = await this.allocator.async_write(payload);
    } catch {
      this.releaseWritingSlot(identity);
      throw new BaseCallTerminalFailure(BaseCallTerminalError.OutOfMemory);
    }
    try {
      this.publishOwnedRequest(identity, opcode, allocation);
      allocation = undefined;
    } finally {
      if (allocation !== undefined) {
        this.allocator.free(...allocation);
        this.releaseWritingSlot(identity);
      }
    }
  }

  private publishOwnedRequest(
    identity: SlotIdentity,
    opcode: BaseCallOpcode,
    allocation: [number, number],
  ): void {
    baseCallTestHooks.beforeRequestPublication?.(identity.slotIndex, opcode);
    const base = this.slotWord(identity.slotIndex, 0);
    Atomics.store(this.slots, base + SLOT_OPCODE, opcode);
    Atomics.store(this.slots, base + SLOT_FLAGS, 0);
    Atomics.store(this.slots, base + SLOT_REQUEST_POINTER, allocation[0]);
    Atomics.store(this.slots, base + SLOT_REQUEST_LENGTH, allocation[1]);
    Atomics.store(this.slots, base + SLOT_RESPONSE_POINTER, 0);
    Atomics.store(this.slots, base + SLOT_RESPONSE_LENGTH, 0);
    Atomics.store(this.slots, base + SLOT_ERROR_POINTER, 0);
    Atomics.store(this.slots, base + SLOT_ERROR_LENGTH, 0);
    Atomics.store(this.slots, base + SLOT_AUXILIARY, 0);
    Atomics.store(this.slots, base + SLOT_RESERVED, 0);
    if (
      Atomics.load(this.control, CONTROL_LIFECYCLE) !==
        TransportLifecycle.Active ||
      Atomics.load(this.slots, base + SLOT_GENERATION) !==
        identity.generation ||
      Atomics.compareExchange(
        this.slots,
        base + SLOT_STATE,
        SlotState.Writing,
        SlotState.Ready,
      ) !== SlotState.Writing
    ) {
      throw new BaseCallTerminalFailure(BaseCallTerminalError.Destroyed);
    }
    Atomics.add(this.control, CONTROL_REQUEST_EPOCH, 1);
    Atomics.notify(this.control, CONTROL_REQUEST_EPOCH);
  }

  private releaseWritingSlot(identity: SlotIdentity): void {
    const stateIndex = this.slotWord(identity.slotIndex, SLOT_STATE);
    if (
      Atomics.load(
        this.slots,
        this.slotWord(identity.slotIndex, SLOT_GENERATION),
      ) === identity.generation
    ) {
      const state = Atomics.load(this.slots, stateIndex);
      if (state === SlotState.Writing || state === SlotState.Cancelled) {
        Atomics.compareExchange(this.slots, stateIndex, state, SlotState.Free);
        this.notifySlotFreed(identity.slotIndex);
      }
    }
  }

  private waitForTerminalBlocking(
    identity: SlotIdentity,
    opcode: BaseCallOpcode,
  ): Uint8Array | undefined {
    const stateIndex = this.slotWord(identity.slotIndex, SLOT_STATE);
    while (true) {
      const state = Atomics.load(this.slots, stateIndex);
      if (isTerminalState(state)) {
        return this.consumeTerminal(identity, opcode, state);
      }
      this.assertGeneration(identity);
      Atomics.wait(this.slots, stateIndex, state);
    }
  }

  private async waitForTerminalAsync(
    identity: SlotIdentity,
    opcode: BaseCallOpcode,
  ): Promise<Uint8Array | undefined> {
    const stateIndex = this.slotWord(identity.slotIndex, SLOT_STATE);
    while (true) {
      const state = Atomics.load(this.slots, stateIndex);
      if (isTerminalState(state)) {
        return this.consumeTerminal(identity, opcode, state);
      }
      this.assertGeneration(identity);
      await waitAsync(this.slots, stateIndex, state);
    }
  }

  private consumeTerminal(
    identity: SlotIdentity,
    opcode: BaseCallOpcode,
    state: number,
  ): Uint8Array | undefined {
    this.assertGeneration(identity);
    const base = this.slotWord(identity.slotIndex, 0);
    let ownedAllocation: [number, number] | undefined;
    try {
      if (state === SlotState.Done) {
        const pointer = Atomics.load(this.slots, base + SLOT_RESPONSE_POINTER);
        const length = Atomics.load(this.slots, base + SLOT_RESPONSE_LENGTH);
        if (pointer === 0 && length === 0) {
          return undefined;
        }
        ownedAllocation = [pointer, length];
        return new Uint8Array(this.allocator.get_memory(pointer, length));
      }
      if (state === SlotState.Cancelled) {
        if (opcode === BaseCallOpcode.DestroyPark) {
          return undefined;
        }
        throw new BaseCallTerminalFailure(BaseCallTerminalError.Destroyed);
      }

      const status = Atomics.load(this.slots, base + SLOT_FLAGS);
      if (status === BaseCallTerminalError.Serialized) {
        const pointer = Atomics.load(this.slots, base + SLOT_ERROR_POINTER);
        const length = Atomics.load(this.slots, base + SLOT_ERROR_LENGTH);
        ownedAllocation = [pointer, length];
        const decoded = decodeStrictJsonValue(
          new Uint8Array(this.allocator.get_memory(pointer, length)),
        );
        throw deserializeRemoteError(decoded);
      }
      if (
        status === BaseCallTerminalError.OutOfMemory ||
        status === BaseCallTerminalError.InvalidRequest ||
        status === BaseCallTerminalError.Destroyed ||
        status === BaseCallTerminalError.CodecError
      ) {
        throw new BaseCallTerminalFailure(status);
      }
      throw new BaseCallTerminalFailure(BaseCallTerminalError.InvalidRequest);
    } finally {
      if (ownedAllocation !== undefined) {
        this.allocator.free(...ownedAllocation);
      }
      this.releaseTerminalSlot(identity, state);
    }
  }

  private releaseTerminalSlot(identity: SlotIdentity, state: number): void {
    const stateIndex = this.slotWord(identity.slotIndex, SLOT_STATE);
    if (
      Atomics.load(
        this.slots,
        this.slotWord(identity.slotIndex, SLOT_GENERATION),
      ) !== identity.generation
    ) {
      return;
    }
    this.clearSlotMetadata(identity.slotIndex);
    if (
      Atomics.compareExchange(this.slots, stateIndex, state, SlotState.Free) ===
      state
    ) {
      this.notifySlotFreed(identity.slotIndex);
    }
  }

  private notifySlotFreed(slotIndex: number): void {
    const stateIndex = this.slotWord(slotIndex, SLOT_STATE);
    Atomics.notify(this.slots, stateIndex);
    if (slotIndex !== SYSTEM_SLOT) {
      Atomics.add(this.control, CONTROL_FREE_SLOT_EPOCH, 1);
      Atomics.notify(this.control, CONTROL_FREE_SLOT_EPOCH);
    }
  }

  private clearSlotMetadata(slotIndex: number): void {
    const base = this.slotWord(slotIndex, 0);
    for (let word = SLOT_OPCODE; word < SLOT_WORDS; word++) {
      Atomics.store(this.slots, base + word, 0);
    }
  }

  private assertGeneration(identity: SlotIdentity): void {
    if (
      Atomics.load(
        this.slots,
        this.slotWord(identity.slotIndex, SLOT_GENERATION),
      ) !== identity.generation
    ) {
      throw new Error("base call slot generation changed while owned");
    }
  }

  private slotWord(slotIndex: number, word: number): number {
    return slotIndex * SLOT_WORDS + word;
  }
}

/**
 * Park-side owner and dispatcher for a version-2 base-call transport.
 *
 * The owner creates all shared storage. `listen` never blocks its JavaScript
 * agent, handlers run without allocator locks, and `destroy` cancels callers
 * without waiting for user Promises.
 */
export class BaseCallParkUseArrayBuffer {
  private readonly control: Int32Array;
  private readonly slots: Int32Array;
  private readonly allocator: BaseCallAllocatorUseArrayBuffer;
  private readonly handler: BaseCallHandler;
  private readonly userSlotCount: number;
  private readonly onBeginDestroy?: () => void;
  private listening = false;
  private destroyOrigin?: SlotIdentity;

  /**
   * Creates one reserved system slot and `maxBaseCalls` user slots. Construction
   * acquires no caller-owned allocations. `onBeginDestroy` runs once after the
   * winning lifecycle CAS and must not recursively destroy this transport.
   */
  constructor(
    handler: BaseCallHandler,
    options?: {
      maxBaseCalls?: number;
      allocatorBytes?: number;
      onBeginDestroy?: () => void;
    },
  ) {
    if (typeof handler !== "function") {
      throw new TypeError("base call handler must be a function");
    }
    const userSlotCount = options?.maxBaseCalls ?? DEFAULT_USER_SLOT_COUNT;
    if (
      !Number.isInteger(userSlotCount) ||
      userSlotCount < 1 ||
      userSlotCount > MAX_USER_SLOT_COUNT
    ) {
      throw new RangeError(
        "maxBaseCalls must be an integer from 1 through 1024",
      );
    }
    this.handler = handler;
    this.userSlotCount = userSlotCount;
    this.onBeginDestroy = options?.onBeginDestroy;
    this.allocator = new BaseCallAllocatorUseArrayBuffer(
      options?.allocatorBytes,
    );
    this.control = new Int32Array(
      new SharedArrayBuffer(CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT),
    );
    this.slots = new Int32Array(
      new SharedArrayBuffer(
        (userSlotCount + 1) * SLOT_WORDS * Int32Array.BYTES_PER_ELEMENT,
      ),
    );
    Atomics.store(this.control, CONTROL_VERSION, 2);
    Atomics.store(this.control, CONTROL_LIFECYCLE, TransportLifecycle.Active);
    Atomics.store(this.control, CONTROL_REQUEST_EPOCH, 0);
    Atomics.store(this.control, CONTROL_FREE_SLOT_EPOCH, 0);
    Atomics.store(this.control, 4, 0);
    Atomics.store(this.control, CONTROL_USER_SLOT_COUNT, userSlotCount);
    Atomics.store(this.control, 6, 0);
    Atomics.store(this.control, 7, 0);
    for (let word = 0; word < this.slots.length; word++) {
      Atomics.store(this.slots, word, 0);
    }
  }

  /**
   * Returns cloneable shared state without transferring slot or payload
   * ownership. Any agent attaching it must satisfy SharedArrayBuffer support.
   */
  get_object(): BaseCallTransportObject {
    return {
      version: 2,
      userSlotCount: this.userSlotCount,
      control: this.control.buffer as SharedArrayBuffer,
      slots: this.slots.buffer as SharedArrayBuffer,
      allocator: this.allocator.get_object(),
    };
  }

  /**
   * Starts the non-blocking intake loop once. The loop claims published
   * requests, transfers their ownership, starts handlers without awaiting them,
   * and yields through macrotasks until cancellation or destruction.
   */
  listen(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    void this.listenLoop();
  }

  /**
   * Begins owner-side destruction once, cancelling all owned slots and waking
   * every blocked agent. It does not wait for outstanding handler Promises.
   */
  destroy(): void {
    this.beginDestroy();
  }

  private async listenLoop(): Promise<void> {
    while (
      Atomics.load(this.control, CONTROL_LIFECYCLE) ===
      TransportLifecycle.Active
    ) {
      const observedEpoch = Atomics.load(this.control, CONTROL_REQUEST_EPOCH);
      const claimed = this.scanAndClaimReadySlots();
      if (claimed) {
        await macrotaskYield();
        continue;
      }
      baseCallTestHooks.beforeDispatcherWait?.();
      await waitAsync(this.control, CONTROL_REQUEST_EPOCH, observedEpoch);
    }

    if (this.destroyOrigin !== undefined) {
      await this.waitForOriginRelease(this.destroyOrigin);
    }
    this.listening = false;
  }

  private scanAndClaimReadySlots(): boolean {
    let claimed = false;
    for (let slotIndex = 0; slotIndex <= this.userSlotCount; slotIndex++) {
      const stateIndex = this.slotWord(slotIndex, SLOT_STATE);
      if (
        Atomics.compareExchange(
          this.slots,
          stateIndex,
          SlotState.Ready,
          SlotState.Running,
        ) !== SlotState.Ready
      ) {
        continue;
      }
      claimed = true;
      const identity = {
        slotIndex,
        generation: Atomics.load(
          this.slots,
          this.slotWord(slotIndex, SLOT_GENERATION),
        ),
      };
      const base = this.slotWord(slotIndex, 0);
      const opcode = Atomics.load(this.slots, base + SLOT_OPCODE);
      const pointer = Atomics.load(this.slots, base + SLOT_REQUEST_POINTER);
      const length = Atomics.load(this.slots, base + SLOT_REQUEST_LENGTH);
      let payload: Uint8Array;
      try {
        payload = new Uint8Array(this.allocator.get_memory(pointer, length));
        this.allocator.free(pointer, length);
      } catch {
        this.publishTerminalError(
          identity,
          BaseCallTerminalError.InvalidRequest,
        );
        continue;
      }

      if (slotIndex === SYSTEM_SLOT) {
        if (opcode === BaseCallOpcode.DestroyPark) {
          baseCallTestHooks.beforeWireDestroy?.();
          if (!this.beginDestroy(identity)) {
            this.publishSuccess(identity, undefined);
          }
          continue;
        }
        if (opcode !== BaseCallOpcode.SetParkFdsMap) {
          this.publishTerminalError(
            identity,
            BaseCallTerminalError.InvalidRequest,
          );
          continue;
        }
      } else if (opcode !== BaseCallOpcode.CallUnknownFn) {
        this.publishTerminalError(
          identity,
          BaseCallTerminalError.InvalidRequest,
        );
        continue;
      }
      void this.handleSlot(identity, opcode, payload);
    }
    return claimed;
  }

  private async handleSlot(
    identity: SlotIdentity,
    opcode: BaseCallOpcode,
    payload: Uint8Array,
  ): Promise<void> {
    let result: Uint8Array | undefined;
    try {
      result = await this.handler(opcode, payload);
    } catch (error) {
      this.publishSerializedError(identity, error);
      return;
    }

    if (result !== undefined && !(result instanceof Uint8Array)) {
      this.publishTerminalError(identity, BaseCallTerminalError.CodecError);
      return;
    }
    if (result === undefined || result.byteLength === 0) {
      this.publishSuccess(identity, undefined);
      return;
    }

    let allocation: [number, number];
    try {
      allocation = this.allocator.block_write(result);
    } catch {
      this.publishTerminalError(identity, BaseCallTerminalError.OutOfMemory);
      return;
    }
    this.publishSuccess(identity, allocation);
  }

  private publishSuccess(
    identity: SlotIdentity,
    allocation: [number, number] | undefined,
  ): void {
    if (!this.ownsRunningSlot(identity)) {
      if (allocation !== undefined) {
        this.allocator.free(...allocation);
      }
      return;
    }
    const base = this.slotWord(identity.slotIndex, 0);
    Atomics.store(this.slots, base + SLOT_FLAGS, 0);
    Atomics.store(
      this.slots,
      base + SLOT_RESPONSE_POINTER,
      allocation?.[0] ?? 0,
    );
    Atomics.store(
      this.slots,
      base + SLOT_RESPONSE_LENGTH,
      allocation?.[1] ?? 0,
    );
    Atomics.store(this.slots, base + SLOT_ERROR_POINTER, 0);
    Atomics.store(this.slots, base + SLOT_ERROR_LENGTH, 0);
    if (!this.publishTerminalState(identity, SlotState.Done)) {
      if (allocation !== undefined) {
        this.allocator.free(...allocation);
      }
    }
  }

  private publishSerializedError(identity: SlotIdentity, error: unknown): void {
    if (!this.ownsRunningSlot(identity)) {
      return;
    }
    let encoded: Uint8Array;
    try {
      encoded = encodeStrictJsonValue(normalizeRemoteError(error));
    } catch {
      this.publishTerminalError(identity, BaseCallTerminalError.CodecError);
      return;
    }
    let allocation: [number, number];
    try {
      allocation = this.allocator.block_write(encoded);
    } catch {
      this.publishTerminalError(identity, BaseCallTerminalError.OutOfMemory);
      return;
    }

    if (!this.ownsRunningSlot(identity)) {
      this.allocator.free(...allocation);
      return;
    }

    const base = this.slotWord(identity.slotIndex, 0);
    Atomics.store(
      this.slots,
      base + SLOT_FLAGS,
      BaseCallTerminalError.Serialized,
    );
    Atomics.store(this.slots, base + SLOT_RESPONSE_POINTER, 0);
    Atomics.store(this.slots, base + SLOT_RESPONSE_LENGTH, 0);
    Atomics.store(this.slots, base + SLOT_ERROR_POINTER, allocation[0]);
    Atomics.store(this.slots, base + SLOT_ERROR_LENGTH, allocation[1]);
    if (!this.publishTerminalState(identity, SlotState.Error)) {
      this.allocator.free(...allocation);
    }
  }

  private publishTerminalError(
    identity: SlotIdentity,
    status: BaseCallTerminalError,
  ): void {
    if (!this.ownsRunningSlot(identity)) {
      return;
    }
    const base = this.slotWord(identity.slotIndex, 0);
    Atomics.store(this.slots, base + SLOT_FLAGS, status);
    Atomics.store(this.slots, base + SLOT_RESPONSE_POINTER, 0);
    Atomics.store(this.slots, base + SLOT_RESPONSE_LENGTH, 0);
    Atomics.store(this.slots, base + SLOT_ERROR_POINTER, 0);
    Atomics.store(this.slots, base + SLOT_ERROR_LENGTH, 0);
    this.publishTerminalState(identity, SlotState.Error);
  }

  private publishTerminalState(
    identity: SlotIdentity,
    terminalState: SlotState,
  ): boolean {
    if (
      Atomics.load(
        this.slots,
        this.slotWord(identity.slotIndex, SLOT_GENERATION),
      ) !== identity.generation
    ) {
      return false;
    }
    const stateIndex = this.slotWord(identity.slotIndex, SLOT_STATE);
    if (
      Atomics.compareExchange(
        this.slots,
        stateIndex,
        SlotState.Running,
        terminalState,
      ) !== SlotState.Running
    ) {
      return false;
    }
    Atomics.notify(this.slots, stateIndex);
    return true;
  }

  private ownsRunningSlot(identity: SlotIdentity): boolean {
    return (
      Atomics.load(
        this.slots,
        this.slotWord(identity.slotIndex, SLOT_GENERATION),
      ) === identity.generation &&
      Atomics.load(
        this.slots,
        this.slotWord(identity.slotIndex, SLOT_STATE),
      ) === SlotState.Running
    );
  }

  private beginDestroy(origin?: SlotIdentity): boolean {
    if (
      Atomics.compareExchange(
        this.control,
        CONTROL_LIFECYCLE,
        TransportLifecycle.Active,
        TransportLifecycle.Destroying,
      ) !== TransportLifecycle.Active
    ) {
      return false;
    }
    if (origin !== undefined) {
      this.destroyOrigin = origin;
    }
    try {
      this.onBeginDestroy?.();
    } catch {
      // Destruction and caller wakeups must not depend on an owner callback.
    }

    for (let slotIndex = 0; slotIndex <= this.userSlotCount; slotIndex++) {
      this.cancelSlot(slotIndex, origin);
    }

    Atomics.store(
      this.control,
      CONTROL_LIFECYCLE,
      TransportLifecycle.Destroyed,
    );
    Atomics.add(this.control, CONTROL_REQUEST_EPOCH, 1);
    Atomics.notify(this.control, CONTROL_REQUEST_EPOCH);
    Atomics.add(this.control, CONTROL_FREE_SLOT_EPOCH, 1);
    Atomics.notify(this.control, CONTROL_FREE_SLOT_EPOCH);
    for (let slotIndex = 0; slotIndex <= this.userSlotCount; slotIndex++) {
      Atomics.notify(this.slots, this.slotWord(slotIndex, SLOT_STATE));
    }

    if (origin !== undefined) {
      this.publishSuccess(origin, undefined);
    }
    return true;
  }

  private cancelSlot(slotIndex: number, origin?: SlotIdentity): void {
    const generationIndex = this.slotWord(slotIndex, SLOT_GENERATION);
    const stateIndex = this.slotWord(slotIndex, SLOT_STATE);
    while (true) {
      const generation = Atomics.load(this.slots, generationIndex);
      if (
        origin !== undefined &&
        origin.slotIndex === slotIndex &&
        origin.generation === generation
      ) {
        return;
      }
      const state = Atomics.load(this.slots, stateIndex);
      if (state === SlotState.Writing || state === SlotState.Running) {
        if (
          Atomics.compareExchange(
            this.slots,
            stateIndex,
            state,
            SlotState.Cancelled,
          ) === state
        ) {
          Atomics.notify(this.slots, stateIndex);
          return;
        }
        continue;
      }
      if (state === SlotState.Ready) {
        if (
          Atomics.compareExchange(
            this.slots,
            stateIndex,
            SlotState.Ready,
            SlotState.Running,
          ) !== SlotState.Ready
        ) {
          continue;
        }
        const pointer = Atomics.load(
          this.slots,
          this.slotWord(slotIndex, SLOT_REQUEST_POINTER),
        );
        const length = Atomics.load(
          this.slots,
          this.slotWord(slotIndex, SLOT_REQUEST_LENGTH),
        );
        try {
          this.allocator.free(pointer, length);
        } catch {
          // The slot is still cancelled even if malformed request metadata exists.
        }
        Atomics.store(this.slots, stateIndex, SlotState.Cancelled);
        Atomics.notify(this.slots, stateIndex);
        return;
      }
      return;
    }
  }

  private async waitForOriginRelease(origin: SlotIdentity): Promise<void> {
    const stateIndex = this.slotWord(origin.slotIndex, SLOT_STATE);
    while (
      Atomics.load(
        this.slots,
        this.slotWord(origin.slotIndex, SLOT_GENERATION),
      ) === origin.generation
    ) {
      const observedState = Atomics.load(this.slots, stateIndex);
      if (
        observedState === SlotState.Free ||
        observedState === SlotState.Retired
      ) {
        return;
      }
      await waitAsync(this.slots, stateIndex, observedState);
    }
  }

  private slotWord(slotIndex: number, word: number): number {
    return slotIndex * SLOT_WORDS + word;
  }
}

function isTerminalState(state: number): boolean {
  return (
    state === SlotState.Done ||
    state === SlotState.Error ||
    state === SlotState.Cancelled
  );
}

async function waitAsync(
  view: Int32Array,
  index: number,
  expected: number,
): Promise<void> {
  const waiter = Atomics.waitAsync(view, index, expected).value;
  if (waiter instanceof Promise) {
    await waiter;
  }
}

function macrotaskYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function normalizeRemoteError(error: unknown): NormalizedError {
  const seen = new WeakSet<object>();
  if (typeof error === "object" && error !== null) {
    seen.add(error);
  }
  const name = boundedString(safeReflectGet(error, "name"), "Error");
  const message = boundedString(
    safeReflectGet(error, "message"),
    safeString(error),
  );
  const normalized: NormalizedError = { name, message };
  const stack = safeReflectGet(error, "stack");
  if (stack !== undefined) {
    normalized.stack = boundedString(stack, "");
  }
  const cause = safeReflectGet(error, "cause");
  if (cause !== undefined) {
    normalized.cause = normalizeCause(cause, seen, 0);
  }
  return normalized;
}

function normalizeCause(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return typeof value === "string"
      ? value.slice(0, MAX_ERROR_STRING_LENGTH)
      : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : safeString(value);
  }
  if (typeof value !== "object") {
    return safeString(value).slice(0, MAX_ERROR_STRING_LENGTH);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (depth >= MAX_ERROR_CAUSE_DEPTH) {
    return "[Truncated]";
  }
  seen.add(value);
  const normalized: { [key: string]: JsonValue } = {
    name: boundedString(safeReflectGet(value, "name"), "Error"),
    message: boundedString(safeReflectGet(value, "message"), safeString(value)),
  };
  const cause = safeReflectGet(value, "cause");
  if (cause !== undefined) {
    normalized.cause = normalizeCause(cause, seen, depth + 1);
  }
  seen.delete(value);
  return normalized;
}

function safeReflectGet(value: unknown, key: string): unknown {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback.slice(0, MAX_ERROR_STRING_LENGTH);
  }
  return safeString(value).slice(0, MAX_ERROR_STRING_LENGTH);
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "unprintable error";
  }
}

function deserializeRemoteError(value: JsonValue): Error {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return new Error("invalid serialized base call error");
  }
  const name = typeof value.name === "string" ? value.name : "Error";
  const message = typeof value.message === "string" ? value.message : "";
  const error =
    name === "TypeError" ? new TypeError(message) : new Error(message);
  error.name = name;
  if (typeof value.stack === "string") {
    error.stack = value.stack;
  }
  if ("cause" in value) {
    error.cause = value.cause;
  }
  return error;
}
