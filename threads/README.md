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

Call `WASIFarm.destroy()` to synchronously and idempotently destroy the Farm's
owned Park. It rejects new calls, wakes blocked callers, discards late callback
results, and makes later `get_ref()` calls fail. It does not destroy Animals or
terminate external Workers that hold a reference.

The existing Animal destruction methods retain their narrower meanings:

- `animal.destroy()` destroys the Animal and its owned thread resources, but no Park.
- `animal.destroy_park(n)` destroys only the selected referenced Park.
- `animal.destroy_park_all()` destroys all Parks referenced by the Animal, but not the Animal.
- `animal.destroy_with_park()` destroys all referenced Parks and then the Animal.

Forcibly terminating a Worker while it owns a base-call slot cannot run the
caller's SharedArrayBuffer cleanup. The slot therefore remains occupied until
the Farm is destroyed. Terminate callers cooperatively when the Farm must remain
usable; otherwise call `WASIFarm.destroy()` to cancel the remaining slots and
discard late response payloads.

# Architecture

In the thread that maintains the file system for `@bjorn3/browser_wasi_shim`, file access is awaited asynchronously, while in the thread executing the WASM, file access is performed synchronously.

Since the functions called within the WASM are invoked synchronously, it is not possible to properly create web workers. Therefore, it is necessary to first create a dedicated thread for generating web workers.

Please refer to the diagram below for more details.

<!-- @/architecture/slide1.svg -->
![slide1](./architecture/slide1.svg)

Additionally, since data of unknown size is being exchanged, an allocator is essential. A simple allocator is implemented on the assumption that the allocated memory will be released promptly.

<!-- @/architecture/slide2.svg -->
![slide2](./architecture/slide2.svg)
