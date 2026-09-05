# Task 5 Report

## Review Fixes

The requested report was not present in either checkout, so this file was created in the Task 5 worktree to retain the review-fix evidence.

### Root Causes

- The command word moved directly from `Idle` to `Published`, allowing teardown to observe no command after a caller owned the mutex but before it published the command.
- Published commands had no atomic claimant, so adding bootstrap-side cancellation would have allowed two consumers to release the same URL/object payloads.
- Every runtime-error waiter called `take_memory()` for the same serialized error allocation.
- `kill_animal()` and `terminate_all_workers()` bypassed lifecycle checks and could publish after teardown started.
- `JSON.stringify(undefined)` reached `TextEncoder.encode()` as an omitted argument and produced an empty, invalid JSON payload.
- The owner-termination test directly called `markDestroyed()` instead of exercising coordinator teardown.
- A coordinator bootstrap/runtime failure could publish terminal lifecycle state while a pre-ready operation remained blocked on command acknowledgement.

### RED Evidence

Initial focused run: `bun test src/shared_array_buffer/worker_destroy.test.ts`

- Result: 16 passed, 6 failed.
- Bootstrap failure test timed out waiting for pre-ready command acknowledgement.
- Mutex/publication test observed command state `1` (`Idle`) instead of `2` (`Preparing`).
- Coordinator reached `Destroyed` while command state was `Preparing`.
- Omitted `post_obj` decoded as `""` instead of `"{}"`.
- Mutation lifecycle test reported a missing `WorkerDestroyError`.
- Two runtime-error consumers left the allocator active count at `-1` instead of `0`.

Acquisition-boundary focused run: `bun test src/shared_array_buffer/worker_destroy.test.ts -t "teardown waits when mutex acquisition precedes Preparing"`

- Result: 0 passed, 1 failed.
- Coordinator reached `Destroyed` while the command mutex was owned and the command word still read `Idle`, proving the instruction-sized CAS-to-`Preparing` gap.

### Implemented Fixes

- Added `WorkerCommandState.Published`, `Idle`, `Preparing`, and `Claimed`.
- Command mutex acquisition publishes and notifies `Preparing`; abort restores `Idle`.
- Coordinator teardown and failed-coordinator cleanup wait through preparation, recognize `Idle + locked mutex`, and atomically claim `Published` before consuming payloads.
- Bootstrap/runtime coordinator failure cancels and acknowledges a pending pre-ready command without adding a readiness gate to synchronous operations.
- Added a single-winner `Error -> Completing -> ErrorConsumed` runtime payload transition.
- Added before-lock and after-lock lifecycle checks to `kill_animal()` and `terminate_all_workers()`.
- Encoded omitted `post_obj` as `{}` while retaining validation for other non-JSON values.
- Replaced direct `markDestroyed()` test mutation with real coordinator teardown and assertions that handlers are detached before exactly one owner termination.
- Added coverage showing coordinator errors during `Destroying` still publish runtime failure.
- Removed coordinator startup's unconditional command-mutex reset so pre-ready callers retain mutex ownership.

### GREEN And Verification Evidence

- Focused: `bun test src/shared_array_buffer/worker_request.test.ts src/shared_array_buffer/worker_destroy.test.ts` -> 35 passed, 0 failed.
- Full: `bun test src` -> 129 passed, 0 failed across 11 files.
- Worker artifacts: `bun run worker` -> SWC bundle and minification completed successfully.
- Biome: `./node_modules/.bin/biome check .` -> checked 134 files, no fixes or errors.
- Whitespace: `git diff --check` -> no output.
- Direct TypeScript: `./node_modules/.bin/tsc --noEmit` -> one pre-existing error at `src/animals.ts:1431`: `Property 'precision' does not exist on type 'Subscription'`.

`npm` and `npx` are unavailable in this shell, so the package script was run through Bun and static tools were invoked directly from `node_modules/.bin`.
