# Configurable Base-Call Allocator Capacity

## Problem

`@oligami/browser_wasi_shim-threads` 0.4.0 moved `call_unknown_fn` request and response payloads from the general farm allocator to a dedicated multiplexed base-call allocator. The new allocator defaults to 10 MiB and is not affected by the existing `allocator_size` option.

WebShell configures the general allocator to 100 MiB and transfers sysroot files through `sysrootReadFileChunk`. The shell permits a single chunk of up to 50 MiB. A reported 32,408,960-byte file produces a 32,408,974-byte encoded base-call response, which cannot fit in the dedicated allocator's 10,485,728 usable bytes. The park publishes `OutOfMemory`, and WebShell aborts while loading the sysroot.

## Goals

- Let a farm owner configure the dedicated base-call allocator independently.
- Preserve the current 10 MiB default for existing consumers.
- Let WebShell receive its existing maximum 50 MiB sysroot chunk without base-call allocator exhaustion when no competing large call occupies the allocator.
- Preserve the v2 slot protocol, fail-fast capacity behavior, and existing public APIs.
- Release the fix as `@oligami/browser_wasi_shim-threads` 0.4.1.

## Non-Goals

- Changing the sysroot WIT interface or chunking protocol.
- Splitting a single `sysrootReadFileChunk` call into smaller base calls.
- Automatically applying `allocator_size` to both allocators.
- Guaranteeing that arbitrary concurrent payloads fit. The allocator remains bounded and reports `OutOfMemory` when its configured capacity is exhausted.

## Public API

Add the optional farm option:

```ts
base_call_allocator_size?: number;
```

The option is measured in bytes and controls only the shared payload allocator used by multiplexed base calls. It receives a public DocComment that distinguishes it from `allocator_size`, states the 10 MiB default, and documents bounded `OutOfMemory` behavior.

`WASIFarmParkUseArrayBuffer` receives the corresponding optional final constructor argument. Adding it at the end preserves existing positional call sites. It forwards the value as `allocatorBytes` to `BaseCallParkUseArrayBuffer`, which already owns allocator validation and construction.

An omitted value continues to use the existing private 10 MiB constructor default. Invalid values continue to fail through `BaseCallAllocatorUseArrayBuffer` validation rather than introducing a second validation policy.

## WebShell Configuration

The production farm created by `page/src/xterm.tsx` sets:

```ts
base_call_allocator_size: 64 * 1024 * 1024
```

The current maximum sysroot response is 50 MiB plus codec and allocator headers, so a 64 MiB allocator accommodates one such response. The existing 100 MiB general allocator remains unchanged. WebShell therefore reserves approximately 164 MiB across these two shared allocators instead of implicitly doubling the existing 100 MiB value.

The setting applies to the parent farm. Child `WASIFarmAnimal` instances reuse that farm and require no separate configuration.

## Data Flow

1. `WASIFarm` accepts `base_call_allocator_size` and passes it to `WASIFarmParkUseArrayBuffer`.
2. `WASIFarmParkUseArrayBuffer` passes the value to `BaseCallParkUseArrayBuffer` as `allocatorBytes`.
3. `BaseCallParkUseArrayBuffer` allocates the dedicated shared payload buffer at the requested size.
4. A sysroot callback encodes its response into that allocator as before.
5. The reference decodes and frees the response using the existing ownership protocol.

No control-layout, slot-layout, generation, codec, WIT, or generated VFS artifact changes are required.

## Error Handling

- Invalid allocator sizes fail during farm construction with the existing range error.
- Requests or responses that exceed the configured free capacity continue to receive allocation-free `OutOfMemory` terminal errors.
- Destruction and late-completion behavior remain unchanged.
- WebShell keeps the existing 50 MiB caller-side limit; payloads larger than the 64 MiB base-call capacity are not made silently partial.

## Testing

Library tests will prove:

- The new public option is accepted and propagated.
- The default remains 10 MiB.
- A response larger than the default allocator fails with `OutOfMemory`.
- The same response succeeds through an actual Worker when a sufficiently large custom allocator is configured.
- Invalid custom sizes are rejected.
- Existing concurrency, destroy, OOM recovery, and declaration/build tests remain green.

Rubrc verification will prove:

- `page/src/xterm.tsx` compiles with the 64 MiB option.
- A local 0.4.1 package can transfer a response larger than 10 MiB without `OutOfMemory`.
- `bun run build` succeeds.
- Existing Cargo E2Es, Deno bridge tests, and VFS Rust tests remain green.
- The final registry-backed installation resolves 0.4.1 in all active package contexts.

Manual acceptance is loading WebShell after `bun run build` and confirming `load_sysroot wasm32-wasip1` progresses past the reported 32,408,960-byte entry without `base call failed: OutOfMemory`.

## Release Sequence

1. Implement and verify the library change, bumping the package to 0.4.1.
2. Pack the library and verify rubrc against the local tarball without committing local dependency links.
3. Commit the library and rubrc source configuration separately.
4. Stop for the user to publish 0.4.1.
5. After publication is confirmed, update rubrc manifests and lockfiles to registry range `^0.4.1`.
6. Reinstall from the registry, rerun the complete verification matrix, commit, and push the approved branches.

## Acceptance Criteria

- The new option is independently configurable and documented.
- Existing consumers that omit it retain the 10 MiB default.
- WebShell configures 64 MiB and no longer fails on the reported 32,408,960-byte sysroot file.
- No local package links or tarball references remain in committed rubrc manifests or lockfiles.
- Library and rubrc reviews report no blocking findings.
