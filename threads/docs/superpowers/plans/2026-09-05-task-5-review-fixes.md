# Task 5 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the coordinator teardown, command publication, and payload ownership races identified in the Task 5 review without changing pre-ready synchronous API behavior.

**Architecture:** Extend the existing command word with an explicit `Preparing` state set immediately after mutex acquisition. A coordinator or bootstrap-failure cleanup waits for preparation to finish, atomically claims a published command, and only the claimant consumes its payload and acknowledges the caller. Runtime error readers similarly claim the serialized payload once, while lifecycle checks guard mutation publication and owner shutdown detaches handlers before termination.

**Tech Stack:** TypeScript, SharedArrayBuffer/Atomics, Bun test, Biome, TypeScript compiler, SWC worker generation.

## Global Constraints

- Use deterministic TDD for every review finding.
- Preserve one owner for every allocator payload.
- Preserve synchronous operation behavior while coordinator readiness is pending.
- Bootstrap failure and lifecycle termination must always settle command acknowledgement.
- Regenerate coordinator worker artifacts from `worker.ts`.
- Commit once as `fix(threads): close coordinator teardown races`; do not amend.

---

### Task 1: Command Publication And Bootstrap Cleanup

**Files:**
- Modify: `src/shared_array_buffer/worker_background/worker_export.ts`
- Modify: `src/shared_array_buffer/worker_background/worker_background_ref.ts`
- Modify: `src/shared_array_buffer/worker_background/worker.ts`
- Modify: `src/shared_array_buffer/thread_spawn.ts`
- Test: `src/shared_array_buffer/worker_destroy.test.ts`

**Interfaces:**
- Produces: named command states for `Published`, `Idle`, `Preparing`, and `Claimed`.
- Produces: an asynchronous failed-coordinator cleanup that claims or waits for a command and acknowledges it exactly once.

- [x] **Step 1: Write deterministic failing tests**

Cover destroy immediately after mutex acquisition, coordinator bootstrap failure with a pre-ready command, mutation commands after teardown, omitted `post_obj`, and pre-ready operation publication.

- [x] **Step 2: Run focused tests and verify RED**

Run: `bun test src/shared_array_buffer/worker_destroy.test.ts`

Expected: assertion failures or timeout from the absent preparation/cleanup protocol, lifecycle guards, and invalid undefined JSON encoding.

- [x] **Step 3: Implement minimal command-state protocol**

Set `Preparing` only after winning the command mutex. Restore `Idle` when publication is aborted, transfer payload ownership only when storing `Published`, and let teardown/bootstrap failure claim `Published` before consuming payload and acknowledging the caller.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `bun test src/shared_array_buffer/worker_destroy.test.ts`

Expected: all Task 5 coordinator and command tests pass.

### Task 2: Runtime Error Ownership And Owner Finalization

**Files:**
- Modify: `src/shared_array_buffer/worker_request.ts`
- Modify: `src/shared_array_buffer/worker_background/worker_background_ref.ts`
- Modify: `src/shared_array_buffer/thread_spawn.ts`
- Test: `src/shared_array_buffer/worker_request.test.ts`
- Test: `src/shared_array_buffer/worker_destroy.test.ts`

**Interfaces:**
- Produces: a single-winner transition from runtime `Error` to `ErrorConsumed`.
- Preserves: genuine coordinator errors during `Destroying` and detached owner handlers before terminal-state termination.

- [x] **Step 1: Write deterministic failing tests**

Run two runtime error consumers against one payload, emit a genuine coordinator error after destroy starts, and replace direct lifecycle mutation with a real coordinator teardown asserting one detached termination.

- [x] **Step 2: Run focused tests and verify RED**

Run: `bun test src/shared_array_buffer/worker_request.test.ts src/shared_array_buffer/worker_destroy.test.ts`

Expected: duplicate payload free or unknown completion state, plus any owner lifecycle regression exposed by genuine teardown.

- [x] **Step 3: Implement minimal ownership/finalization changes**

Claim `Error` with compare-and-exchange before `take_memory`, publish `ErrorConsumed` after the payload is released, and keep coordinator failure handling active through `Destroying`. Detach all owner event handlers before post-terminal `terminate()`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `bun test src/shared_array_buffer/worker_request.test.ts src/shared_array_buffer/worker_destroy.test.ts`

Expected: all focused tests pass with allocator count returning to zero.

### Task 3: Generated Artifacts, Verification, And Evidence

**Files:**
- Generated: `src/shared_array_buffer/worker_background/worker_blob.ts`
- Generated: `src/shared_array_buffer/worker_background/worker_background_worker_minify.js`
- Modify: `task-5-report.md`

**Interfaces:**
- Produces: generated coordinator code matching source and a complete verification record.

- [x] **Step 1: Regenerate artifacts**

Run: `npm run worker`

Expected: SWC/minifier succeeds and generated files reflect command states and teardown behavior.

- [x] **Step 2: Run full verification**

Run: `bun test src`, `npx biome check .`, and `npx tsc --noEmit`.

Expected: all source tests pass and both static checks exit zero.

- [x] **Step 3: Append evidence**

Record RED failure reasons, focused/full test counts, artifact generation, Biome, and direct TypeScript results in `task-5-report.md`.

- [x] **Step 4: Review and commit**

Inspect `git status`, `git diff`, and recent history; stage only Task 5 review-fix files and commit as `fix(threads): close coordinator teardown races`.
