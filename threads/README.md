# A pure javascript shim for WASI Preview 1 threads

> [!WARNING]
> The code in this directory is less production ready than the main browser_wasi_shim code.
> This code requires `SharedArrayBuffer`, `waitAsync` and `Atomics` to be enabled in the browser, so it may not work in all browsers.
> For example, Firefox failed to run the demo in this directory.
> Chrome worked fine.
> This library require `cross-origin isolation` to be enabled in the browser.

This project implement threads on browser_wasi_shim

# Features

- [x] thread creation
- [x] Filesystem wrapper accessible by multiple workers
- [ ] thread pool

# Building

```sh
$ npm install
$ npm run build
```

# Running the demo

```sh
$ git submodule update --init
$ cd examples && npm install && npm run dev
```

And visit http://localhost

## Farm base calls

`WASIFarm` accepts an `unknown_fn` callback that Animals invoke with
`call_unknown_fn`. Calls from different Animals can run concurrently, and each
caller receives its own result or thrown error even when callbacks complete out
of order.

`max_base_calls_limit` controls concurrent user calls. It defaults to 128 and
must be an integer from 1 through 1024; one additional slot is reserved for
system operations. Synchronous Animal calls fail immediately with
`BaseCallCapacityError` when every user slot is occupied.

Animal base calls use blocking `Atomics.wait`, so they must run in a Worker that
is separate from the agent running the Park listener. The Park agent must remain
able to process callbacks asynchronously; do not make a blocking Animal call on
that same agent or on a browser agent where `Atomics.wait` is forbidden.

Forcibly terminating a Worker while it owns a base-call slot cannot run the
caller's SharedArrayBuffer cleanup. The slot therefore remains occupied until
the Farm is destroyed. Terminate callers cooperatively when the Farm must remain
usable; otherwise call `WASIFarm.destroy()` to cancel the remaining slots and
discard late response payloads.

## Worker runtime destruction

`WASIFarm.destroy()` remains Park-only. It synchronously and idempotently
destroys the Farm's owned Park, rejects new Park calls, wakes blocked callers,
discards late callback results, and makes later `get_ref()` calls fail. It does
not destroy Animals, the worker runtime, or external Workers.

`WASIFarmAnimal.destroy()` and `DestroyerHandle.destroy()` synchronously make
the shared worker runtime reject new work and initiate runtime-wide teardown.
Returning means logical teardown has started, not that every Worker has
physically exited. Neither method destroys a Park.

`WASIFarmAnimal.async_destroy()` and `DestroyerHandle.async_destroy()` observe
logical teardown completion, including released coordinator state and issued
termination operations. Browser platforms do not provide a physical thread
join, so resolution does not guarantee host thread reclamation. When an elected
managed requester initiates teardown, its Promise resolves after every other
managed Worker receives termination and its own close is scheduled; code after
the `await` must not start new runtime work.

A transferred `DestroyerHandleObject` inside a managed worker must be
reconstructed with `WASIFarmAnimal.init_destroyer()` so the receiving Animal is
bound as the local requester. `DestroyerHandle.init_self()` creates an unbound
handle for an external controller.

`WASIFarmAnimal.kill_animal(animal_id)` affects only the published, registered
Animal with that ID. Unknown, unpublished, completed, or already killed IDs are
idempotent no-ops and do not change the runtime lifecycle.

The Park-specific methods remain separate: `destroy_park(n)` destroys one
referenced Park, `destroy_park_all()` destroys all referenced Parks, and
`destroy_with_park()` destroys the referenced Parks before initiating worker
runtime teardown.

# Architecture

In the thread that maintains the file system for `@bjorn3/browser_wasi_shim`, file access is awaited asynchronously, while in the thread executing the WASM, file access is performed synchronously.

Since the functions called within the WASM are invoked synchronously, it is not possible to properly create web workers. Therefore, it is necessary to first create a dedicated thread for generating web workers.

Please refer to the diagram below for more details.

<!-- @/architecture/slide1.svg -->
![slide1](./architecture/slide1.svg)

Additionally, since data of unknown size is being exchanged, an allocator is essential. A simple allocator is implemented on the assumption that the allocated memory will be released promptly.

<!-- @/architecture/slide2.svg -->
![slide2](./architecture/slide2.svg)
