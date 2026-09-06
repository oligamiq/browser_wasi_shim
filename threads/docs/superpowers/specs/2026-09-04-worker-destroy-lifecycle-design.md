# Worker Destroy Lifecycle Design

**Status:** Approved

## Problem

The worker-side destroy implementation does not have a single authoritative
lifecycle. `ThreadSpawner`, `DestroyerHandle`, `WorkerBackgroundRef`, and the
worker coordinator each maintain part of the teardown protocol, but none owns
the complete state transition.

The current implementation has the following concrete failure modes:

- `DestroyerHandle` starts waiting for the wrong atomic value and releases its
  references before a delayed caller can use it.
- `ThreadSpawner.destroy()` drops the coordinator `Worker` reference without
  terminating that worker.
- A spawn that fails before posting `ready` can hold the coordinator command
  lock indefinitely and prevent destroy from making progress.
- Destroy terminates a start worker without settling callers waiting for that
  start operation.
- An error-reporting worker is removed from the worker registry before the
  registry is terminated, so the reporting worker can be leaked.
- Concurrent destroy callers use unconditional stores instead of electing one
  teardown owner.

The earlier `architecture/destroy_flow.md` document describes some intended
properties, including compare-and-exchange and coordinator self-termination,
but those properties were never implemented. This design supersedes that
document for worker teardown. It does not replace the independent Park and
BaseCall lifecycle defined by `architecture/base_call_multiplexing_design.md`.

## Goals

- Give the worker runtime one monotonic lifecycle shared by all destroy entry
  points.
- Make synchronous destroy idempotently stop new work without waiting on a
  worker command lock.
- Add an asynchronous API that observes teardown completion.
- Settle every pending spawn and start operation when teardown begins.
- Terminate each owned worker at most once, including failed workers and the
  coordinator itself.
- Preserve the existing scope of all public destroy methods.
- Repair `kill_animal(animal_id)` as the individual-Animal termination API.
- Support destroy requests from both controller workers and workers managed by
  the runtime.
- Make browser and Node worker implementations follow the same observable
  lifecycle contract.

## Non-Goals

- Changing `WASIFarm.destroy()` to terminate Animals or external workers.
- Changing Park or BaseCall cancellation semantics.
- Introducing a reusable worker pool.
- Giving every Animal its own coordinator.
- Preserving interoperability between different library versions running in
  the same worker tree.
- Guaranteeing that a worker can observe its own physical termination.

## Ownership Model

The root `ThreadSpawner` owns the coordinator `Worker` object. The coordinator
owns every spawned worker, the optional start worker, pending worker requests,
and the `animal_id` to worker registry.

`WorkerBackgroundRef` and `DestroyerHandle` are capabilities that can request
operations from the coordinator. They do not own the coordinator `Worker`
object and must not discard or terminate it directly.

A `WASIFarmAnimal` that has thread spawning enabled participates in the shared
worker runtime. Its existing `destroy()` method retains runtime-wide semantics:
it initiates destruction of the coordinator and the entire worker tree owned by
that coordinator. It does not destroy a Park.

Individual Animal termination remains a separate operation implemented by
`kill_animal(animal_id)`.

## Public API Contract

### Existing synchronous methods

`WASIFarm.destroy()` retains its current meaning. It synchronously and
idempotently destroys the Farm and its exclusively owned Park. It does not
terminate Animals, the worker coordinator, or external workers.

`WASIFarmAnimal.destroy()` retains its current scope. It synchronously and
idempotently moves the shared worker runtime out of `Running`, rejects future
spawn and start operations, and initiates worker teardown. Returning from this
method means logical teardown has started; it does not mean that every worker
has physically exited.

`DestroyerHandle.destroy()` has the same synchronous guarantee as
`WASIFarmAnimal.destroy()`. It is safe to call after transfer, safe to call
after an arbitrary task delay, and safe to call repeatedly.

### Asynchronous methods

The public asynchronous method is named `async_destroy()` to match existing
APIs such as `async_start_on_thread()`.

`WASIFarmAnimal.async_destroy(): Promise<void>` initiates teardown if necessary
and waits until the coordinator has completed its owned teardown protocol. For
an Animal that is not itself a managed child of the coordinator, resolution
means termination has been issued for all managed workers, all operation
waiters have reached terminal states, all coordinator-owned registries have
been released, and the coordinator has published `Destroyed`. Browser platforms
do not expose a thread-join primitive, so resolution does not claim that the
host has completed physical thread reclamation.

`DestroyerHandle.async_destroy(): Promise<void>` is also public. An unbound
handle used by an external controller has the same completion guarantee as the
owner-side method.

A handle bound to a managed Animal has a necessarily narrower guarantee when it
wins the destroy election. Its Promise resolves after termination has been
issued for all other managed workers and shutdown of the requesting worker is
scheduled. The requesting worker is the final worker to receive termination.
Code after the `await` may run only until that scheduled shutdown and must not
start new runtime work.

Concurrent external and owner-side asynchronous callers observe the same
lifecycle result and do not start duplicate teardown operations. Among
concurrent managed callers, only the caller that wins the destroy election has
the requester-last guarantee. Another managed caller remains part of the normal
termination set and may exit before observing its Promise settlement.

### Binding a transferred handle

Requester identity describes the context executing `async_destroy()`, not the
context that originally created or serialized the handle. Therefore requester
identity must not be stored in `DestroyerHandleObject` as creator identity.

`WASIFarmAnimal.create_destroyer()` returns a handle bound to that Animal's
local `animal_id` when the Animal is a managed child.

A transferred handle reconstructed inside a managed worker must be
reconstructed through a new `WASIFarmAnimal.init_destroyer(obj)` method. That
method binds the receiving Animal's local `animal_id` to the reconstructed
handle.

`DestroyerHandle.init_self(obj)` retains its existing name for compatibility
and remains available for external controller workers that are not managed by
the target coordinator. Despite its historical name, it creates an unbound
handle. Managed workers must not use this static method when they need the
managed-requester `async_destroy()` guarantee.

The local requester binding is not returned by `get_object()`. Every transfer
requires the receiver to establish its own local binding.

### Individual termination

`WASIFarmAnimal.kill_animal(animal_id)` terminates only the worker registered
for that Animal. It does not transition the global runtime lifecycle and does
not terminate sibling workers or the coordinator.

Killing an unknown, already completed, or already killed Animal is idempotent
and returns without changing the runtime lifecycle.

## Shared Lifecycle

The current `destroy_status` buffer becomes a four-word lifecycle control
block:

| Index | Name | Meaning |
| --- | --- | --- |
| 0 | `CONTROL` | Lifecycle and elected requester packed into one atomic word |
| 1 | `REQUESTER_STATUS` | Requester-last handshake state |
| 2 | `FAILURE_CODE` | Stable machine-readable teardown failure code |
| 3 | `WAKE_EPOCH` | Monotonic wake generation for lifecycle and request waiters |

The low two bits of `CONTROL` contain the lifecycle:

| Value | Name | Meaning |
| --- | --- | --- |
| 0 | `Running` | New worker operations may be registered |
| 1 | `Destroying` | New work is rejected and teardown is in progress |
| 2 | `Destroyed` | Teardown completed successfully |
| 3 | `Failed` | Teardown cannot complete normally |

The high 30 bits contain a requester code. Code `0` means an external or
unbound requester. A managed `animal_id` is encoded as `animal_id + 1`.
Generated Animal IDs are restricted to `0` through `2^30 - 2`; rollover must
not reuse an ID that remains in the live or pending registries.

`REQUESTER_STATUS` uses `None=0`, `RequesterDrained=1`, and `Closing=2`. It is
used only when the elected requester code identifies a currently registered
managed worker.

Only the following transitions are valid:

```text
Running -> Destroying -> Destroyed
                      -> Failed
```

The state never returns to `Running`. The implementation must use named
constants or an enum and must not spread numeric literals through the code.

The first destroy caller encodes `Destroying` and its requester code into one
32-bit value, then uses one `Atomics.compareExchange()` to replace the all-zero
`Running` control word. Lifecycle and requester identity therefore become
visible atomically, with no intermediate state that can be stranded if the
caller exits. Callers observing `Destroying`, `Destroyed`, or `Failed` do not
submit another destroy command.

Encoding, lifecycle extraction, and requester extraction are centralized in
named helpers. They use unsigned bit operations so the sign of an `Int32Array`
value cannot corrupt requester decoding. Terminal transitions preserve the
requester bits and replace only the low lifecycle bits.

Every lifecycle transition and request completion increments `WAKE_EPOCH` and
calls `Atomics.notify()` for all epoch waiters. Blocking and asynchronous
waiters capture the epoch, recheck their target state, and then wait on that
exact epoch. A completion between the recheck and wait changes the epoch, so
`Atomics.wait()` or `Atomics.waitAsync()` returns `not-equal` instead of missing
the notification. Async waiters inspect the returned `{ async, value }` object
and correctly handle both a synchronous string `value` and an asynchronous
Promise `value`.

## Operation Lifecycle

The global lifecycle is not used as the result slot for individual spawn and
start requests. Each operation retains a request identifier and its own
terminal state.

An operation follows this sequence:

```text
check Running
-> acquire the short registration lock
-> register a Pending request
-> recheck Running
-> roll back if teardown won the race
-> release the registration lock
-> wait for ready, error, exit, or destroy
-> publish exactly one terminal result
```

No global command or allocator lock may be held while awaiting worker script
loading, Animal construction, WebAssembly instantiation, `ready`, or another
external event.

The completion paths race through a per-request compare-and-exchange. Exactly
one of `Ready`, `Failed`, or `Cancelled` wins. Every winning path writes the
result before notifying its blocking and asynchronous waiters.

When teardown begins, the coordinator changes every pending request to
`Cancelled` and notifies it. Blocking callers return a destroyed error and
asynchronous callers reject with the corresponding typed error.

A `ready` received after cancellation is a late completion. It must not restore
the request, add the worker back to a registry, or transition the global
lifecycle. The late worker is terminated and its message is otherwise ignored.

## Out-of-Band Destroy Signal

Destroy must not acquire the command lock used by spawn and start. The single
atomic replacement of the packed `Running` control word with packed
`Destroying` and requester metadata is the destroy signal.

The coordinator waits for either command activity or a lifecycle transition.
Every long-lived coordinator wait, including a wait for a child `ready`, also
observes the lifecycle. Destroy can therefore interrupt a spawn even when that
spawn has not produced a message.

The command protocol may still carry requester metadata and completion slots,
but receipt of a command is not required for the coordinator to notice global
teardown.

## Teardown Sequence

The elected destroy caller atomically publishes `Destroying` with requester
metadata and wakes the coordinator. The coordinator then performs the following
ordered steps:

1. Stop accepting spawn, start, and mutation commands.
2. Transition every pending request to `Cancelled` and notify every waiter.
3. Snapshot the start worker, worker registry, Animal registry, and event
   handlers required for cleanup.
4. Clear the live registries so no later callback can obtain or re-register a
   stale worker.
5. Terminate every non-requesting managed worker exactly once, including the
   worker that reported an error or exit.
6. Release request allocations and detach callbacks that can no longer produce
   useful events.
7. If the elected destroy requester is managed, store `RequesterDrained` in the
   lifecycle block's `REQUESTER_STATUS`, notify it, and keep the coordinator
   alive while waiting for that word to become `Closing`.
8. Let the requester schedule its local self-close before resolving its
   `async_destroy()` Promise. The scheduled close callback signals `Closing`
   immediately before closing the worker global scope.
9. On `Closing`, requester `error`, requester `exit`, or expiry of the internal
   requester-close grace period, capture and terminate the requester
   defensively and clear its registry entry.
10. Publish `Destroyed` as the coordinator's final shared-state mutation and
    notify global waiters.
11. Close the coordinator global scope without performing further shared-state
    work.
12. Let the root `ThreadSpawner` invoke `terminate()` on the coordinator after
    observing `Destroyed`, then release the coordinator `Worker` reference.
    `Destroyed` guarantees that this termination cannot interrupt unfinished
    coordinator state publication.

The coordinator must publish the terminal state before closing its own global
scope. Dropping a worker reference before termination is forbidden. If there is
no managed requester, steps 7 through 9 are skipped.

The requester-close grace period is a safety deadline, not the primary
completion mechanism. It starts only after `RequesterDrained` is published and
is fixed at `1_000` milliseconds. The normal path completes through the
`Closing` notification. Tests inject the deadline scheduler so they do not wait
for wall-clock time.

## Managed Requester Protocol

A bound `DestroyerHandle` includes local, non-serialized requester metadata. It
encodes that `animal_id` into the same atomic `CONTROL` value used to win the
destroy election.

The coordinator reads the elected requester ID from `CONTROL` before taking its
registry snapshot. It uses its `animal_id -> Worker` registry to exclude that
one requester from the first termination pass. Once termination has been issued
for all other workers, it stores `RequesterDrained` in `REQUESTER_STATUS` and
notifies the requester.

The requesting handle schedules local worker shutdown for the next available
task before resolving its Promise. The shutdown callback does not run user
work. It stores `Closing` in `REQUESTER_STATUS`, notifies the coordinator, and
immediately closes the worker global scope. The coordinator may terminate the
same Worker defensively after that signal; termination remains idempotent. If
user code prevents the scheduled task from running, the grace deadline ensures
global teardown still completes.

If the bound requester ID is not present in the coordinator registry, the
request is treated as an external-controller request and receives the normal
global completion guarantee.

## Worker Registration and `kill_animal`

Every standard spawned worker includes its generated `animal_id` in the
`ready` message. The coordinator registers both `animal_id -> Worker` and the
reverse association needed to remove the Animal when that Worker exits.

Registry mutation occurs only while the coordinator owns the short registry
lock. Registration rechecks the global lifecycle before publishing the Worker.

`kill_animal(animal_id)` atomically removes the target from the live registry,
then directly calls `terminate()` on the captured Worker. It does not depend on
the target worker processing a message. Completion, error, and late-ready
callbacks see that the worker is no longer live and do not re-register it.

Before termination, `kill_animal()` changes every request owned by the target
Animal to `Cancelled` and notifies its waiters. Request ownership is recorded
when the coordinator associates a ready worker with its `animal_id`. An Animal
ID is not a valid public `kill_animal()` target until that ready association is
published. Calls using an unknown or not-yet-published ID are the documented
idempotent no-op. Pending spawns are cancelled by request ID or global teardown,
not by an Animal ID that has not yet been published.

## Error Handling

Coordinator creation installs success, `error`, and `messageerror` handlers
before waiting for the coordinator-ready message. A bootstrap failure rejects
the ready Promise and publishes `Failed` if a runtime lifecycle has already
been exposed.

Every child Worker installs `message`, `error`, and `messageerror` handlers
before it can be awaited. Node adapters additionally translate worker exit into
the same terminal path.

WebAssembly instantiation and Animal-construction errors produce a request
failure instead of leaving `ready` pending. If the existing fail-fast runtime
policy treats a child failure as fatal, the coordinator transitions the global
lifecycle through `Destroying` to `Failed` after cancelling the other requests
and terminating owned workers.

`FAILURE_CODE` records a stable category rather than an exception object.
JavaScript-facing methods translate it into the existing typed error style.
All asynchronous lifecycle waiters reject with the same category. Repeated
calls after `Failed` reject without trying teardown again.

No normal internal completion path depends on a fixed delay. Tests and the
implementation use worker events and atomic state transitions. The sole
internal deadline is the documented requester-close safety fallback after
`RequesterDrained`. Applications may impose their own external deadline around
`async_destroy()`.

## Cross-Platform Worker Semantics

Browser and Node worker creation, event registration, self-close, and
termination differences are normalized behind the existing worker wrapper or a
small lifecycle adapter.

Synchronous `destroy()` never uses blocking `Atomics.wait()` on a browser main
thread. `async_destroy()` uses the asynchronous lifecycle waiter.

The adapter treats browser `Worker.terminate(): void` and Node termination
results as the same internal operation. The public completion guarantee is
based on the protocol's terminal state, released registries, and issued
termination operations, not on an unavailable browser thread-join primitive.

## Resource Cleanup Rules

- Worker objects remain strongly referenced until captured for termination.
- The worker that emitted `error` or `exit` is captured before its registry
  entry is removed.
- Event handlers are detached only after their final useful terminal event has
  been processed or the Worker has been captured for forced termination.
- Coordinator and request allocations are released after all associated
  waiters have observed a terminal state.
- `DestroyerHandle` remains a valid idempotent capability after completion; it
  may release heavy sender references internally, but subsequent destroy calls
  must still return or reject according to the cached terminal state.
- Cleanup never relies on assigning `null` through an unsafe type assertion.

## Generated Worker Source

`src/shared_array_buffer/worker_background/worker.ts` is the source of truth.
`src/shared_array_buffer/worker_background/worker_blob.ts` is generated output
and must not be edited manually. Any source change to the coordinator must run
the repository's normal blob generation step, and tests must verify that the
generated worker contains the new lifecycle behavior.

## Testing Strategy

Unit tests cover lifecycle transitions and request completion without requiring
timing-sensitive worker execution:

- first-caller election through compare-and-exchange;
- repeated and concurrent synchronous destroy;
- asynchronous waiters for `Destroyed` and `Failed`;
- delayed `DestroyerHandle` use across microtasks and tasks;
- exactly-once request completion among ready, failure, and cancellation;
- late-ready rejection;
- idempotent individual Animal removal.

Real-Worker integration tests cover behavior that mocks cannot establish:

- coordinator startup success and startup failure;
- child script load, Animal construction, and instantiate failure before
  `ready`;
- destroy while spawn is waiting for `ready`;
- destroy while blocking and asynchronous start callers are waiting;
- error or exit from a worker that must itself be terminated;
- rejection of spawn and start after logical destroy;
- coordinator self-close and owner fallback termination;
- external `DestroyerHandle.async_destroy()` completion;
- managed `DestroyerHandle.async_destroy()` requester-last behavior;
- correct rebinding through `WASIFarmAnimal.init_destroyer()` after transfer;
- `kill_animal()` terminating only the selected Animal;
- late callbacks not restoring cleared registry entries.

Tests use messages and shared-state conditions instead of arbitrary sleeps.
Every test that creates a Worker or runtime owns cleanup in `finally`, including
failure-path tests.

The suite runs against the source coordinator and the generated worker blob so
the two forms cannot silently diverge. Browser and Node integration coverage
must exercise the same lifecycle assertions where both environments support
the operation.

## Documentation Changes

The README and public type comments must document:

- the difference between logical synchronous destroy and asynchronous teardown
  completion;
- the unchanged Park-only scope of `WASIFarm.destroy()`;
- the runtime-wide scope of `WASIFarmAnimal.destroy()`;
- the requester-last guarantee for a managed handle;
- the required `WASIFarmAnimal.init_destroyer()` rebinding step after transfer
  into a managed worker;
- `kill_animal()` as the individual termination API;
- the prohibition on starting new work after any destroy method begins.

`architecture/destroy_flow.md` must either be updated to reference this design
or be marked superseded so it cannot continue to imply unimplemented behavior.

## Acceptance Criteria

- No destroy path waits for the spawn/start command lock.
- Exactly one caller atomically replaces `Running` with packed `Destroying` and
  requester metadata.
- Every pending operation reaches one terminal state and wakes all waiters.
- Every owned worker is captured and terminated at most once.
- The coordinator does not remain alive after successful teardown.
- Delayed and repeated `DestroyerHandle` calls remain safe.
- `async_destroy()` never remains pending for any handled worker error,
  message error, exit, bootstrap failure, or instantiate failure.
- The elected managed requester follows the documented requester-last contract;
  concurrent non-elected managed callers receive no requester-last guarantee.
- `kill_animal()` terminates only the selected registered Worker.
- Park and BaseCall lifecycle behavior remains unchanged.
- Source and generated coordinator worker tests pass in the supported browser
  and Node environments.
