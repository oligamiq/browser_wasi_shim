# WASIFarm Base Call Multiplexing Design

## Goal

Allow multiple synchronous `WASIFarmRef` base calls to be in flight against
one `WASIFarm`, including calls started reentrantly from an asynchronous
`unknown_fn` handler. Preserve the existing synchronous public methods while
making response correlation, errors, backpressure, and destruction reliable.

This is a library-level transport capability. It is not specific to WebShell,
Cargo, or child-process execution.

## Root Cause

The current SharedArrayBuffer base-call transport is one global mailbox guarded
by one mutex. A caller retains that mutex until the Park returns its response.
The Park listener also awaits `unknown_fn` inline before accepting another base
call.

This deadlocks when an `unknown_fn` handler starts another `WASIFarmAnimal`
against the same farm:

1. The outer caller holds the base-call mutex while waiting for `unknown_fn`.
2. The Park awaits the outer handler.
3. The nested Animal calls `set_park_fds_map` during initialization.
4. The nested call waits for the mutex held by the outer caller.
5. The outer handler cannot finish until the nested Animal starts.

Removing only the mutex is insufficient because the single Park listener would
still await the outer handler. Both request storage and dispatch must support
multiple in-flight calls.

## Scope

The implementation will:

- Replace the v1 base mailbox with a v2 fixed-slot request transport.
- Permit concurrent `unknown_fn` handlers and out-of-order completion.
- Reserve capacity for fd-map and lifecycle operations.
- Preserve the existing synchronous public base-call methods.
- Add explicit terminal error and cancellation responses.
- Harden SharedArrayBuffer attachment and payload allocation for concurrency.
- Implement `WASIFarm.destroy()`.
- Preserve every existing destroy-series public function and its name.
- Add DocComments to every new or changed public API.
- Verify the transport with actual Workers as well as deterministic unit tests.

The implementation will not:

- Read v1 reference objects. A farm and its references must use the same v2
  package version.
- Make synchronous `Atomics.wait` calls safe on the same JavaScript agent as
  the Park. The Park remains asynchronous and Wasm callers remain in Workers.
- Force arbitrary user Promises to stop during destruction.
- Add an unbounded request queue.

## Existing Mechanisms To Reuse

The v2 transport follows the existing per-fd request mechanism rather than
introducing an unrelated communication model:

- One exclusively owned mailbox per in-flight operation.
- Blocking caller and asynchronous Park listener.
- CAS ownership transitions.
- Request fields written before state publication.
- State rechecking around `Atomics.wait` and `Atomics.waitAsync`.
- Pointer/length payload descriptors.
- Caller-to-Park ownership transfer for requests.
- Park-to-caller ownership transfer for responses.
- Numeric operation codes.
- Strict JSON codec and serialized remote errors.
- Plain cloneable transport objects reconstructed with `init_self()`.

The sender log, worker-background singleton mailbox, and current global base
mutex are not used as the v2 RPC transport because they do not provide
independent response correlation.

## Public Behavior

The following methods remain synchronous from a Worker caller's perspective:

- `WASIFarmRef.set_park_fds_map()`
- `WASIFarmRef.call_unknown_fn()`
- `WASIFarmRef.destroy_park()`

Their wire implementation changes to v2 slots. Existing operation numbers
remain stable:

- `0`: set fd map
- `1`: destroy Park
- `2`: call unknown function

`unknown_fn` handlers may execute concurrently and may complete in any order.
The request slot and generation correlate each result with its caller.

The `WASIFarm` constructor gains an optional `max_base_calls_limit`. Its
default is 128 user-call slots. Values must be finite positive integers from 1
through 1024. The constructor rejects every other value before allocating the
transport.
One additional system slot is always reserved for `set_park_fds_map` and
destroy operations. User calls cannot consume the system slot.

The reserved slot ensures that a saturated set of slow `unknown_fn` calls does
not prevent nested Animal initialization or farm lifecycle operations. System
operations remain serialized because they are short Park-side mutations and
must preserve mapping and destruction order.

## Cloneable Transport Object

`WASIFarm.get_ref()` returns a versioned plain structured-clone object. The
object contains only numbers, arrays, plain records, and SharedArrayBuffers.
It does not contain class instances whose prototypes are stripped by cloning.

The v2 base-call portion contains:

```ts
type BaseCallTransportObject = {
  version: 2;
  userSlotCount: number;
  control: SharedArrayBuffer;
  slots: SharedArrayBuffer;
  allocator: AllocatorUseArrayBufferObject;
};
```

`init_self()` attaches to these buffers without writing initialization values.
Creation and attachment are separate code paths for the base transport,
allocator, and fd-close sender.

## Control Layout

The control SharedArrayBuffer contains eight `Int32` words:

| Word | Meaning |
| ---: | --- |
| 0 | Protocol version, always `2` |
| 1 | Lifecycle: active, destroying, or destroyed |
| 2 | Request publication epoch and futex |
| 3 | Free-slot epoch and futex |
| 4 | Reserved |
| 5 | User-slot count |
| 6 | Reserved |
| 7 | Reserved |

Epoch values are notification counters, not locks. A producer increments the
request epoch after publishing a ready slot. A caller increments the free-slot
epoch after returning a slot to the free state.

Each reconstructed `WASIFarmRef` keeps its own non-shared round-robin scan hint.
Slot selection therefore does not introduce a contended shared atomic counter.

## Slot Layout

There is one reserved system slot followed by the configured user slots. Each
slot contains twelve `Int32` words:

| Word | Meaning |
| ---: | --- |
| 0 | State and futex |
| 1 | Generation |
| 2 | Operation code |
| 3 | Flags or result status |
| 4 | Request pointer |
| 5 | Request byte length |
| 6 | Response pointer |
| 7 | Response byte length |
| 8 | Error pointer |
| 9 | Error byte length |
| 10 | Auxiliary result |
| 11 | Reserved |

Slot states are:

```text
FREE -> WRITING -> READY -> RUNNING -> DONE
                                   -> ERROR
                                   -> CANCELLED
FREE -> RETIRED
```

The logical request identity is the pair `(slotIndex, generation)`. Every
completion validates both values before publishing. A late completion cannot
write into a cancelled and reused slot.

Generation values range from 1 through `0x7fffffff`. A slot that would wrap is
changed permanently from `FREE` to `RETIRED` and is no longer selected. This
prevents an ABA collision with an exceptionally late completion. Request and
free-slot epochs may wrap as 32-bit counters because no ordering comparison is
performed: callers compare only the exact value passed to `Atomics.wait`, and
the dispatcher rescans before sleeping.

## Caller Algorithm

A user call:

1. Rejects immediately unless the transport lifecycle is active.
2. Starts scanning from the calling `WASIFarmRef` instance's local
   round-robin hint.
3. Claims a free user slot with `FREE -> WRITING` CAS.
4. Advances and records the slot generation.
5. Allocates and writes the request payload.
6. Rechecks lifecycle and cleans up if destruction started.
7. Writes immutable request metadata.
8. Publishes `WRITING -> READY` with CAS. If destruction changed the slot to
   `CANCELLED`, the caller frees its still-owned request and does not publish.
9. Increments and notifies the request epoch.
10. Waits on that slot's state while validating its generation.
11. Copies and frees a response or remote error.
12. Returns the slot to `FREE` in `finally`.
13. Increments and notifies the free-slot epoch.

If all user slots are occupied, a synchronous caller throws a local bounded
capacity error without publishing a request. It must not wait for a free slot:
all active handlers could be awaiting nested base calls, so blocking would
reintroduce a finite-pool deadlock. An internal asynchronous API may wait on
the free-slot epoch when its caller is not part of a handler dependency chain,
but the existing synchronous public methods always fail fast at capacity.

No global mutex remains held while a host handler executes.

System calls use the reserved slot and the same publication and response
protocol. They are serialized on that slot.

All slot metadata, including generation, operation, pointers, lengths, flags,
and auxiliary values, is written with `Atomics.store()` before the publishing
state transition. Readers use `Atomics.load()` only after observing the state
transition. Plain typed-array assignment is prohibited for cross-agent slot
metadata. This establishes the required SharedArrayBuffer happens-before
ordering on every supported JavaScript engine.

## Park Dispatcher

The Park dispatcher repeatedly:

1. Scans for ready slots.
2. Claims each with `READY -> RUNNING` CAS.
3. Captures its generation and copies the request payload.
4. Frees the request allocation exactly once.
5. Starts the handler without awaiting it in the dispatcher.
6. Continues accepting ready slots.
7. Waits asynchronously on the request epoch only after a final rescan.

Slot metadata is read with `Atomics.load()` after the dispatcher successfully
claims `READY -> RUNNING`. Response metadata is written with `Atomics.store()`
before publishing a terminal state.

Each user handler has `try/catch/finally` coverage. Success publishes `DONE`.
Exceptions, unknown operations, codec failures, and allocation failures publish
`ERROR`. Every terminal publication notifies the slot futex.

System-slot handlers are dispatched without blocking the intake of ready user
slots. Fd-map registration performs its short synchronous mutation and
publishes its result. Destroy follows the lifecycle sequence below. The
dispatcher never awaits an arbitrary user callback inline.

Handler concurrency is bounded by the fixed user-slot count. The dispatcher
does not apply a smaller active-handler limit, because handlers may await
nested base calls and a lower limit would create another dependency deadlock.
It drains at most one complete slot scan per turn before yielding back to the
JavaScript microtask queue.

If completion loses a generation, cancellation, or lifecycle race, the Park
frees any response it allocated and does not mutate the slot.

The current fixed one-second delay in fd-map registration is removed. A system
call is acknowledged immediately after the Park commits the mapping. Duplicate
`(fd, reference ID)` registrations are ignored.

## Payload Ownership And Allocator

Payload ownership is determined by slot state:

| State | Request owner | Response or error owner |
| --- | --- | --- |
| `WRITING` | Caller | None |
| `READY` | Park transport | None |
| `RUNNING` | Already copied and freed | Handler until publication |
| `DONE` | None | Caller |
| `ERROR` | None | Caller |
| `CANCELLED` | None | None |

The caller owns request memory until publishing `READY`. The Park then owns it
and must copy and free it exactly once. The Park owns a result allocation until
a successful terminal-state publication. The caller owns a published result
and frees it even when decoding throws.

The base transport uses a dedicated concurrent free-list allocator so fd
payload pressure cannot strand lifecycle and unknown-function calls. The v1
bump allocator is not reused because interleaved request and response lifetimes
prevent it from reclaiming individual blocks.

The free-list allocator retains the existing pointer/length transfer API. Its
metadata is protected by one short allocator lock; that lock is never held
while a host handler runs. Blocks are aligned to eight bytes, split on
allocation when the remainder can hold a valid block, and coalesced with
adjacent free blocks on release. Allocation and release validate bounds,
alignment, allocation state, and duplicate frees.

Creation initializes a new buffer. `init_self()` only attaches to the existing
SharedArrayBuffer and must not write the lock, list head, block metadata, or
usage counters. Blocking and asynchronous lock acquisition use `try/finally`.
Out-of-memory becomes a terminal remote error and always wakes the caller.

The existing allocator and fd-close sender attachment paths are also corrected
so `init_self()` never resets live shared headers. This is required because a
nested Animal reconstructs both objects while the outer request is active.

## Errors

Every published request reaches one terminal result:

- Success with a response payload.
- Success with an undefined response.
- Serialized remote error.
- Cancellation caused by destruction.
- Local capacity error before request publication.
- Out-of-memory error.
- Invalid operation or request error.

Handler errors never reject the dispatcher loop or leave a caller blocked.
Remote errors retain the existing serialized error shape and are reconstructed
as thrown errors by synchronous callers.

## Destruction Semantics

All existing destroy-series function names remain available. They have the
following consistent meanings:

- `destroy()` destroys the receiver and resources it exclusively owns.
- `destroy_park(n)` destroys the receiver's nth referenced Park without
  destroying the receiver.
- `destroy_park_all()` destroys all Parks referenced by the receiver without
  destroying the receiver.
- `destroy_with_park()` performs `destroy_park_all()` and then destroys the
  receiver.

Specifically:

- `WASIFarmAnimal.destroy()` continues to destroy the Animal and its owned
  thread resources without destroying a Park.
- `WASIFarmAnimal.destroy_park()`, `destroy_park_all()`, and
  `destroy_with_park()` retain their names and public responsibilities.
- `WASIFarmRef.destroy_park()` retains its name and requests destruction of its
  corresponding Park.
- `DestroyerHandle.destroy()` retains its name and public behavior.
- New `WASIFarm.destroy()` destroys the farm and its exclusively owned Park.
- Internal `WASIFarmPark.destroy()` and base transport `destroy()` destroy
  their own resources.

No existing destroy-series function is removed, renamed, or converted into a
deprecated alias.

Farm destruction is serialized by the Park dispatcher to avoid races between
slot claiming and cancellation:

1. `destroy_park()` claims the reserved system slot and publishes a destroy
   request.
2. The Park dispatcher claims that request and performs the single-winner
   lifecycle CAS from active to destroying.
3. New user-slot reservations reject after observing the lifecycle. A caller
   already in `WRITING` must recheck lifecycle before publishing and clean up
   locally.
4. The Park dispatcher stops claiming new ready user slots. It walks every
   slot once. A writing slot becomes cancelled but retains caller ownership of
   its incomplete request. A ready slot becomes cancelled after the Park frees
   its request payload. A running slot becomes cancelled. Every affected
   caller is notified. Because slot reservation precedes the caller's mandatory
   lifecycle recheck and publication uses CAS, every reservation concurrent
   with the lifecycle transition is either present in this walk or cleans
   itself up after observing destruction.
5. Done/error callers remain responsible for consuming and freeing their
   already published payloads.
6. The dispatcher marks the lifecycle destroyed and notifies the request,
   free-slot, and every slot futex.
7. The dispatcher publishes `DONE` to the reserved destroy system slot only
   after the destroyed lifecycle and all cancellation notifications are
   visible.
8. The requesting caller returns the system slot to `FREE`, after which the
   Park stops intake listener bookkeeping.

An arbitrary running `unknown_fn` Promise is not forcibly terminated and farm
destruction does not wait for it to settle. Completion after destruction
validates lifecycle, generation, and slot state, frees its result, and discards
it. SharedArrayBuffer storage remains valid for these late closures until
JavaScript garbage collection, so acknowledgement does not expose freed native
memory.

## DocComments

Every new or changed public class, option, method, and returned transport type
must have a DocComment. This includes all destroy-series APIs touched by the
implementation.

Each relevant DocComment states:

- What resource is affected.
- Whether the call blocks.
- Whether the operation is idempotent.
- Whether referenced Parks or Animals are also affected.
- Payload ownership where applicable.
- Errors and cancellation behavior.
- The Worker/Park agent requirement for synchronous APIs.

Internal slot-state, generation, ownership, and lifecycle helpers receive
DocComments when their invariants are not evident from their signatures.
Comments must explain the invariant rather than restating an assignment.

## Testing

### Deterministic Transport Tests

- Concurrent `unknown_fn` calls complete in reverse order without cross-talk.
- An outer `unknown_fn` handler starts and awaits a second Animal from the same
  farm.
- A slow user handler does not delay fd-map registration on the system slot.
- More synchronous callers than user slots fail fast with a capacity error;
  after a slot completes, a later call succeeds.
- Notify-before-wait and wait-before-notify both complete.
- Repeated slot reuse advances generation.
- A delayed completion cannot publish into a reused slot.
- Handler throw, codec failure, unknown operation, and allocator OOM wake the
  correct caller with an error.
- Destruction wakes callers in writing, ready, and running states.
- Late completion after destruction is reclaimed.
- Fd-map registration is ordered and duplicate-free.
- Structured cloning and `init_self()` do not reset live allocator or sender
  state.
- Existing destroy-series methods retain their documented scope.

### Worker Integration Tests

Actual Worker tests verify the architecture that permits blocking
`Atomics.wait` callers:

- Two Worker callers use one farm concurrently.
- Reentrant Animal initialization completes on the same farm.
- Sequential Animals reuse the same farm after prior Worker termination.
- `WASIFarm.destroy()` wakes blocked callers and leaves no active listeners.

### Downstream WebShell Verification

WebShell removes the isolated-child-farm workaround and private Park access.
The child bridge again passes a reference from the existing farm. The parent
and child therefore share one allocator/fd/filesystem owner while v2 slots
prevent base-call deadlock.

Downstream tests verify:

- `cargo run` with arguments and filesystem changes.
- Sequential dynamic children on one farm.
- Exact nonzero child exit status through the complete Cargo/VFS/host path.
- Bounded runner-error retention at 64 KiB.
- Command completion only after command-return metadata followed by a prompt.
- Existing Cargo add, info, build, and rustc capture behavior.

## Success Criteria

The design is complete when:

- Reentrant and concurrent base calls complete without a global in-flight lock.
- Results cannot cross slots or generations.
- Every request produces a terminal wakeup on success, error, cancellation, or
  destruction.
- Shared-state attachment never reinitializes live metadata.
- Existing destroy-series APIs remain present with documented meanings.
- All new and changed public APIs have accurate DocComments.
- WebShell uses the existing farm without isolated-farm or private-destroy
  workarounds and its Cargo run E2E passes.
