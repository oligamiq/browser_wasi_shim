# v0.1.0
first release

# v0.1.1
- fix: Fixed a bug where the main thread could not recover after an error occurred following block_start_on_thread.

# v0.5.0
- Reworked the shared worker runtime destruction lifecycle with explicit running, destroying, destroyed, and failed states.
- Added `WASIFarmAnimal.async_destroy()` and `DestroyerHandle.async_destroy()` for observing logical runtime teardown completion.
- Added lifecycle-aware destroy handles for managed workers, including `WASIFarmAnimal.init_destroyer()` and exported `DestroyerHandleObject`.
- Added typed worker teardown failures through `WorkerDestroyError` and `WorkerDestroyFailureCode`.
- Hardened worker coordinator teardown, startup failure handling, request completion, self-termination, and runtime shutdown races.
- Improved `kill_animal()` so it only terminates the targeted registered Animal while leaving sibling workers and the overall runtime usable.
- Added coordinated worker termination handoff to avoid terminating workers while they still own shared command or runtime state.
- Redesigned the BaseCall shared-memory allocator around coalescing extents and next-fit allocation.
- Fixed BaseCall payload ownership races involving asynchronous reads, frees, cancellation, response delivery, and slot reuse.
- Fixed WASI clock subscription precision and flags handling.
- Added extensive real-worker, lifecycle, termination, allocator, cancellation, and async BaseCall integration tests.
