# Base-Call Allocator Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent base-call payload allocator size option and configure WebShell with 64 MiB so a 32,408,960-byte sysroot file no longer fails with `OutOfMemory`.

**Architecture:** `WASIFarm` will pass a new `base_call_allocator_size` option through `WASIFarmParkUseArrayBuffer` to the existing `BaseCallParkUseArrayBuffer.allocatorBytes` setting. The default remains 10 MiB. WebShell alone opts into 64 MiB; the v2 transport, codec, WIT, and sysroot protocol remain unchanged.

**Tech Stack:** TypeScript, Bun test, Web Workers, SharedArrayBuffer, Vite, npm, Bun workspaces, Deno, Rust/WASI.

## Global Constraints

- Modify browser library files only under `/home/oligami/projects/browser_wasi_shim/threads`; use its existing `dev` branch and do not create a browser-library worktree.
- Modify rubrc on `/home/oligami/projects/rubrc` `main`; preserve all existing untracked scratch files and unrelated changes.
- The option name is exactly `base_call_allocator_size` and is measured in bytes.
- An omitted option keeps the existing 10 MiB base-call allocator default.
- WebShell configures exactly `64 * 1024 * 1024` bytes.
- Do not apply `allocator_size` implicitly to the base-call allocator.
- Do not change the base-call control/slot layout, codec, WIT interfaces, sysroot chunk protocol, or generated VFS Wasm for this fix.
- Package version is 0.4.1. The user, not the implementation agent, performs npm publication.
- Do not commit local tarball paths, package links, node_modules changes, or unrelated lockfile re-resolution.
- New or changed public library API must have a complete DocComment.

---

### Task 1: Expose And Verify The Independent Allocator Option

**Files:**
- Modify: `/home/oligami/projects/browser_wasi_shim/threads/src/farm.ts:18-41,89-100`
- Modify: `/home/oligami/projects/browser_wasi_shim/threads/src/shared_array_buffer/park.ts:111-156`
- Test: `/home/oligami/projects/browser_wasi_shim/threads/src/shared_array_buffer/farm_base_call.test.ts:14-56`
- Test: `/home/oligami/projects/browser_wasi_shim/threads/src/shared_array_buffer/base_call_worker.test.ts:61-111`

**Interfaces:**
- Consumes: `BaseCallParkUseArrayBuffer(handler, { allocatorBytes?: number })`, which already validates an 8-byte multiple from 64 through `0x7ffffff8`.
- Produces: `WASIFarm` option `base_call_allocator_size?: number` and final `WASIFarmParkUseArrayBuffer` constructor argument `base_call_allocator_size?: number`.

- [ ] **Step 1: Add failing public propagation and validation tests**

Extend the helper in `farm_base_call.test.ts`:

```ts
function createTestFarm(
  unknown_fn?: (arg: unknown) => Promise<unknown> | unknown,
  max_base_calls_limit = 4,
  base_call_allocator_size?: number,
): WASIFarm {
  return new WASIFarm(
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    new OpenFile(new File([])),
    [new PreopenDirectory("/", new Map())],
    {
      unknown_fn,
      max_base_calls_limit,
      base_call_allocator_size,
    },
  );
}
```

Add this test:

```ts
test("validates and propagates base_call_allocator_size", () => {
  for (const allocatorSize of [
    -Infinity,
    -1,
    0,
    63,
    65,
    1.5,
    Number.NaN,
    Infinity,
  ]) {
    assert.throws(
      () => createTestFarm(undefined, 4, allocatorSize),
      RangeError,
    );
  }

  const defaultFarm = createTestFarm();
  const minimumFarm = createTestFarm(undefined, 4, 64);
  const configuredFarm = createTestFarm(undefined, 4, 64 * 1024 * 1024);
  try {
    const defaultTransport = defaultFarm.get_ref() as unknown as {
      baseCall: BaseCallTransportObject;
    };
    const configuredTransport = configuredFarm.get_ref() as unknown as {
      baseCall: BaseCallTransportObject;
    };
    assert.strictEqual(
      defaultTransport.baseCall.allocator.share_arrays_memory.byteLength,
      10 * 1024 * 1024,
    );
    assert.strictEqual(
      configuredTransport.baseCall.allocator.share_arrays_memory.byteLength,
      64 * 1024 * 1024,
    );
    const minimumTransport = minimumFarm.get_ref() as unknown as {
      baseCall: BaseCallTransportObject;
    };
    assert.strictEqual(
      minimumTransport.baseCall.allocator.share_arrays_memory.byteLength,
      64,
    );
  } finally {
    destroyFarm(defaultFarm);
    destroyFarm(minimumFarm);
    destroyFarm(configuredFarm);
  }
});
```

- [ ] **Step 2: Run the propagation test and confirm RED**

Run:

```bash
bun test src/shared_array_buffer/farm_base_call.test.ts --test-name-pattern "base_call_allocator_size"
```

Expected: TypeScript compilation fails because `base_call_allocator_size` is not a known `WASIFarm` option, or the configured transport still reports 10 MiB.

- [ ] **Step 3: Add a failing actual-Worker capacity test**

Extend `createTestFarm` in `base_call_worker.test.ts` with the same optional final parameter and option property. Add:

```ts
test("custom allocator carries a payload larger than the default through an actual Worker", async () => {
  const payloadLength = 11 * 1024 * 1024;
  const payload = "x".repeat(payloadLength);

  const callback = (arg: unknown) => {
    assert.deepStrictEqual(arg, { kind: "large-response" });
    return { payload };
  };
  const defaultFarm = createTestFarm(callback);
  const expandedFarm = createTestFarm(
    callback,
    4,
    12 * 1024 * 1024,
  );
  const defaultWorker = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );
  const expandedWorker = new Worker(
    new URL("./test_workers/base_call_outer_worker.ts", import.meta.url).href,
  );

  try {
    const rejected = await runWorker(
      defaultWorker,
      { wasiRef: defaultFarm.get_ref(), arg: { kind: "large-response" } },
      60_000,
    );
    assert.strictEqual(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.error, /OutOfMemory/i);

    const accepted = await runWorker(
      expandedWorker,
      { wasiRef: expandedFarm.get_ref(), arg: { kind: "large-response" } },
      60_000,
    );
    assert.strictEqual(accepted.ok, true);
    if (accepted.ok) {
      const value = accepted.value as { payload: string };
      assert.strictEqual(value.payload.length, payloadLength);
      assert.strictEqual(value.payload[0], "x");
      assert.strictEqual(value.payload.at(-1), "x");
    }
  } finally {
    defaultWorker.terminate();
    expandedWorker.terminate();
    destroyFarm(defaultFarm);
    destroyFarm(expandedFarm);
  }
});
```

- [ ] **Step 4: Run the Worker test and confirm RED**

Run:

```bash
bun test src/shared_array_buffer/base_call_worker.test.ts --test-name-pattern "payload larger than the default"
```

Expected: compilation fails on the unknown farm option, or the expanded farm still returns `OutOfMemory` because the value is not propagated.

- [ ] **Step 5: Implement the minimal library propagation**

In `farm.ts`, add this property after `allocator_size`:

```ts
/**
 * Shared payload allocator size for multiplexed base calls, in bytes.
 *
 * Defaults to 10 MiB. This is independent from `allocator_size`; requests
 * and responses fail with `OutOfMemory` when the configured free capacity is
 * insufficient.
 */
base_call_allocator_size?: number;
```

Pass it as the final park constructor argument:

```ts
this.park = new WASIFarmParkUseArrayBuffer(
  this.fds_ref(),
  stdin_,
  stdout_,
  stderr_,
  default_allow_fds,
  options.allocator_size,
  options.max_fds_limit,
  options.unknown_fn,
  options.max_base_calls_limit,
  options.base_call_allocator_size,
);
```

In `shared_array_buffer/park.ts`, append the constructor parameter:

```ts
base_call_allocator_size?: number,
```

Add this DocComment line:

```ts
* @param base_call_allocator_size Optional byte size of the multiplexed base-call payload allocator.
```

Forward it without fallback to the old allocator size:

```ts
this.baseCall = new BaseCallParkUseArrayBuffer(
  this.handleBaseCall.bind(this),
  {
    maxBaseCalls: max_base_calls_limit,
    allocatorBytes: base_call_allocator_size,
    onBeginDestroy: () => this.stopFdListeners(),
  },
);
```

- [ ] **Step 6: Run focused and complete library tests**

Run:

```bash
bun test src/shared_array_buffer/farm_base_call.test.ts src/shared_array_buffer/base_call_worker.test.ts
npm test
```

Expected: focused tests pass; complete suite reports at least 78 passing tests and zero failures.

- [ ] **Step 7: Check formatting and commit Task 1**

Run:

```bash
npx biome check src/farm.ts src/shared_array_buffer/park.ts src/shared_array_buffer/farm_base_call.test.ts src/shared_array_buffer/base_call_worker.test.ts
git diff --check
```

Expected: no new diagnostics and no whitespace errors. If Biome reports only a pre-existing repository baseline outside these files, record it and do not broaden scope.

Commit:

```bash
git add src/farm.ts src/shared_array_buffer/park.ts src/shared_array_buffer/farm_base_call.test.ts src/shared_array_buffer/base_call_worker.test.ts
git commit -m "feat(threads): configure base call allocator"
```

### Task 2: Build The 0.4.1 Package

**Files:**
- Modify: `/home/oligami/projects/browser_wasi_shim/threads/package.json:3`
- Modify: `/home/oligami/projects/browser_wasi_shim/threads/package-lock.json`
- Generated by build: `/home/oligami/projects/browser_wasi_shim/threads/src/shared_array_buffer/worker_background/worker_background_worker_minify.js`
- Generated by build: `/home/oligami/projects/browser_wasi_shim/threads/src/shared_array_buffer/worker_background/worker_blob.ts`

**Interfaces:**
- Consumes: verified `base_call_allocator_size` implementation from Task 1.
- Produces: local package tarball `@oligami/browser_wasi_shim-threads@0.4.1` for rubrc integration and a publish-ready library commit.

- [ ] **Step 1: Bump package metadata without creating a tag**

Run:

```bash
npm version 0.4.1 --no-git-tag-version
```

Expected: `package.json` and root `package-lock.json` report version 0.4.1; no Git tag or commit is created.

- [ ] **Step 2: Build declarations and distributable files**

Run:

```bash
npm test
npm run build
```

Expected: all tests pass and Vite exits zero. The known baseline declaration diagnostics in unrelated `animals.ts`, `destroyer_handle.ts`, or worker code may still be printed by `vite-plugin-dts`; record them if present, but do not claim they were introduced by this change.

- [ ] **Step 3: Pack into the approved temporary directory and inspect it**

Run:

```bash
test -d /tmp/opencode
npm pack --ignore-scripts --json --pack-destination /tmp/opencode > /tmp/opencode/threads-0.4.1-pack.json
```

Expected: `/tmp/opencode/threads-0.4.1-pack.json` reports a freshly written tarball named `oligami-browser_wasi_shim-threads-0.4.1.tgz`, package version 0.4.1, and a non-empty `integrity`. `--ignore-scripts` avoids running the already-completed build a second time from the package `prepare` hook.

Also run:

```bash
tar -xOf /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.1.tgz package/package.json
tar -xOf /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.1.tgz package/dist/index.d.ts > /tmp/opencode/threads-0.4.1-index.d.ts
node -e "const fs=require('node:fs'); const d=fs.readFileSync('/tmp/opencode/threads-0.4.1-index.d.ts','utf8'); if (!d.includes('base_call_allocator_size?: number')) process.exit(1)"
```

Expected: package name is `@oligami/browser_wasi_shim-threads`, version is 0.4.1, and the packed public declarations contain the new option.

- [ ] **Step 4: Verify the release diff and commit**

Run:

```bash
git status --short
git diff --check
git diff -- package.json package-lock.json src/shared_array_buffer/worker_background/worker_background_worker_minify.js src/shared_array_buffer/worker_background/worker_blob.ts
```

Expected: only package metadata and deterministic build outputs are changed. Do not stage `dist`, temporary tarballs, or unrelated files.

Commit:

```bash
git add package.json package-lock.json src/shared_array_buffer/worker_background/worker_background_worker_minify.js src/shared_array_buffer/worker_background/worker_blob.ts
git commit -m "chore(threads): prepare 0.4.1"
```

### Task 3: Configure And Locally Verify WebShell

**Files:**
- Modify: `/home/oligami/projects/rubrc/page/src/xterm.tsx:349-357`
- Test: `/home/oligami/projects/rubrc/scripts/webshell_base_call_capacity_test.ts`

**Interfaces:**
- Consumes: local Task 2 tarball and `WASIFarm` option `base_call_allocator_size?: number`.
- Produces: WebShell farm configuration with a 64 MiB base-call allocator; no committed dependency or lockfile update before npm publication.

- [ ] **Step 1: Add a failing source-configuration regression test**

Create `scripts/webshell_base_call_capacity_test.ts`:

```ts
import assert from "node:assert";

const xterm = await Deno.readTextFile(
  new URL("../page/src/xterm.tsx", import.meta.url),
);

Deno.test("WebShell reserves 64 MiB for multiplexed base-call payloads", () => {
  assert.match(
    xterm,
    /base_call_allocator_size:\s*64\s*\*\s*1024\s*\*\s*1024/,
  );
});
```

- [ ] **Step 2: Run the configuration test and confirm RED**

Run:

```bash
deno test --no-lock -A scripts/webshell_base_call_capacity_test.ts
deno fmt --check scripts/webshell_base_call_capacity_test.ts
git diff --check
```

Expected: one failure because `xterm.tsx` does not configure `base_call_allocator_size`.

- [ ] **Step 3: Add the WebShell setting**

In the existing `WASIFarm` options object in `page/src/xterm.tsx`, add:

```ts
base_call_allocator_size: 64 * 1024 * 1024, // 64 MiB
```

Keep the existing general allocator setting unchanged:

```ts
allocator_size: 100 * 1024 * 1024, // 100MB
```

- [ ] **Step 4: Run the configuration test and static checks**

Run:

```bash
deno test --no-lock -A scripts/webshell_base_call_capacity_test.ts
deno fmt --check scripts/webshell_base_call_capacity_test.ts
git diff --check
```

Expected: one test passes and formatting/diff checks pass.

- [ ] **Step 5: Install the local 0.4.1 tarball operationally**

Preserve the five tracked locks before any temporary package-manager operation:

```bash
cp package-lock.json /tmp/opencode/rubrc-local-root-package-lock.json
cp bun.lockb /tmp/opencode/rubrc-local-root-bun.lockb
cp lib/package-lock.json /tmp/opencode/rubrc-local-lib-package-lock.json
cp page/package-lock.json /tmp/opencode/rubrc-local-page-package-lock.json
cp page/src/worker_process/vfs_bindings/bun.lock /tmp/opencode/rubrc-local-bindings-bun.lock
```

Define failure-safe restoration in the same shell that performs the install and build. The trap restores locks on command failure, interrupt, or termination:

```bash
(
set -e
restore_local_locks() {
  cp /tmp/opencode/rubrc-local-root-package-lock.json package-lock.json
  cp /tmp/opencode/rubrc-local-root-bun.lockb bun.lockb
  cp /tmp/opencode/rubrc-local-lib-package-lock.json lib/package-lock.json
  cp /tmp/opencode/rubrc-local-page-package-lock.json page/package-lock.json
  cp /tmp/opencode/rubrc-local-bindings-bun.lock page/src/worker_process/vfs_bindings/bun.lock
}
trap restore_local_locks EXIT INT TERM
bun add --cwd=page --no-save /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.1.tgz
bun run build
restore_local_locks
trap - EXIT INT TERM
)
```

Expected: the physical page package reports 0.4.1, the complete build exits zero, and the five locks are restored even if either command fails. The other three contexts do not consume the new option before publication and remain on registry 0.4.0. Do not commit the local source.

Verify:

```bash
node -p "require('./page/node_modules/@oligami/browser_wasi_shim-threads/package.json').version"
git diff -- package.json package-lock.json bun.lockb lib/package.json lib/package-lock.json page/package.json page/package-lock.json page/src/worker_process/vfs_bindings/package.json page/src/worker_process/vfs_bindings/bun.lock
```

Expected: page physical version is 0.4.1 and the tracked dependency/lock diff is empty.

- [ ] **Step 6: Test the packed package's large response path**

Run the actual-Worker regression from the installed tarball, not from the library source tree. Set the command working directory to `/home/oligami/projects/rubrc/page/node_modules/@oligami/browser_wasi_shim-threads`:

```bash
bun test ./src/shared_array_buffer/base_call_worker.test.ts --test-name-pattern "payload larger than the default"
```

Expected: the test loaded from the installed 0.4.1 package proves the default allocator returns `OutOfMemory` and the expanded allocator transfers the 11 MiB response through an actual Worker. Also require an empty lock diff after the trapped build:

```bash
git diff -- package-lock.json bun.lockb lib/package-lock.json page/package-lock.json page/src/worker_process/vfs_bindings/bun.lock
```

Expected: the lock diff is empty.

- [ ] **Step 7: Run rubrc regressions**

Run:

```bash
deno test --no-lock --node-modules-dir=manual -A \
  scripts/webshell_base_call_capacity_test.ts \
  scripts/vfs_child_process_import_test.ts \
  scripts/vfs_child_process_bridge_test.ts \
  scripts/vfs_http_bridge_test.ts \
  scripts/vfs_http_import_test.ts \
  scripts/vfs_build_script_test.ts
cargo test -p vfs --lib
cargo fmt -p vfs -- --check
git diff --check
```

Expected: all Deno and VFS tests pass; only existing linked `wasi_virt_layer` warnings may be printed.

- [ ] **Step 8: Commit only the WebShell source and regression test**

Run:

```bash
git status --short
git diff -- page/src/xterm.tsx scripts/webshell_base_call_capacity_test.ts
```

Expected: existing user scratch files remain untracked and untouched. No generated artifact, manifest, lockfile, or node_modules path is staged.

Commit:

```bash
git add page/src/xterm.tsx scripts/webshell_base_call_capacity_test.ts
git commit -m "fix(webshell): size base call allocator for sysroot"
```

### Task 4: Publish Gate, Registry Update, Final Verification, And Push

**Files:**
- Modify: `/home/oligami/projects/rubrc/package.json:44`
- Modify: `/home/oligami/projects/rubrc/lib/package.json:15`
- Modify: `/home/oligami/projects/rubrc/page/package.json:27`
- Modify: `/home/oligami/projects/rubrc/page/src/worker_process/vfs_bindings/package.json:9`
- Modify: `/home/oligami/projects/rubrc/package-lock.json`
- Modify: `/home/oligami/projects/rubrc/bun.lockb`
- Modify: `/home/oligami/projects/rubrc/lib/package-lock.json`
- Modify: `/home/oligami/projects/rubrc/page/package-lock.json`
- Modify: `/home/oligami/projects/rubrc/page/src/worker_process/vfs_bindings/bun.lock`

**Interfaces:**
- Consumes: user-published npm package `@oligami/browser_wasi_shim-threads@0.4.1` and the Task 3 WebShell configuration.
- Produces: registry-only rubrc dependency graph resolving 0.4.1 in all four contexts, complete verification evidence, and pushed `browser_wasi_shim/dev` plus `rubrc/main`.

- [ ] **Step 1: Stop and request user publication**

Do not change rubrc manifests or locks until the user confirms publication. Provide the library commit, tarball hash, and this exact command so the published artifact is the verified tarball rather than a new rebuild:

```bash
npm publish /tmp/opencode/oligami-browser_wasi_shim-threads-0.4.1.tgz
```

Then wait.

- [ ] **Step 2: Confirm registry metadata after user publication**

Run:

```bash
npm view @oligami/browser_wasi_shim-threads@0.4.1 version dist.tarball dist.integrity dependencies
LOCAL_INTEGRITY=$(node -p "require('/tmp/opencode/threads-0.4.1-pack.json')[0].integrity")
REGISTRY_INTEGRITY=$(npm view @oligami/browser_wasi_shim-threads@0.4.1 dist.integrity)
test "$LOCAL_INTEGRITY" = "$REGISTRY_INTEGRITY"
```

Expected: version 0.4.1, an npm registry tarball URL ending in `browser_wasi_shim-threads-0.4.1.tgz`, a non-empty SHA-512 integrity exactly equal to the locally verified pack, and `@bjorn3/browser_wasi_shim: ^0.4.2`. If either integrity differs or the Bjorn range differs, stop before changing rubrc.

- [ ] **Step 3: Update all four manifest ranges**

Set exactly:

```json
"@oligami/browser_wasi_shim-threads": "^0.4.1"
```

in root, `lib`, `page`, and generated-bindings `package.json` files. Change no other dependency constraints.

- [ ] **Step 4: Regenerate active locks from the registry**

Run:

```bash
bun install
npm install --prefix lib --package-lock-only
bun install --cwd=page/src/worker_process/vfs_bindings
```

The root and page npm locks have known broad historical staleness, so do not run broad npm regeneration in those contexts. Run this deterministic focused updater after the commands above. It reads the verified registry metadata, updates every package-context edge for Threads in the three text npm locks, and updates only the Threads package node:

```bash
node --input-type=module -e '
  import { execFileSync } from "node:child_process";
  import { readFileSync, writeFileSync } from "node:fs";
  const name = "@oligami/browser_wasi_shim-threads";
  const metadata = JSON.parse(execFileSync(
    "npm",
    ["view", `${name}@0.4.1`, "version", "dist.tarball", "dist.integrity", "--json"],
    { encoding: "utf8" },
  ));
  for (const file of ["package-lock.json", "lib/package-lock.json", "page/package-lock.json"]) {
    const lock = JSON.parse(readFileSync(file, "utf8"));
    for (const entry of Object.values(lock.packages ?? {})) {
      if (entry.dependencies?.[name] !== undefined) entry.dependencies[name] = "^0.4.1";
    }
    const node = lock.packages?.[`node_modules/${name}`];
    if (node === undefined) throw new Error(`${file} has no Threads package node`);
    node.version = metadata.version;
    node.resolved = metadata["dist.tarball"];
    node.integrity = metadata["dist.integrity"];
    writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  }
'
```

The focused result must contain only these changes:

- package-context range `^0.4.0` to `^0.4.1`;
- Threads node version `0.4.0` to `0.4.1`;
- Threads `resolved` URL and `integrity` to the exact values returned by `npm view`;
- no Bjorn node change because Step 2 verified that the published package retains `@bjorn3/browser_wasi_shim: ^0.4.2`.

Do not retain unrelated Monaco, workspace, or transitive dependency churn.

- [ ] **Step 5: Verify registry-only physical resolution**

Run:

```bash
npm ls @oligami/browser_wasi_shim-threads
npm ls --prefix lib @oligami/browser_wasi_shim-threads
npm ls --prefix page @oligami/browser_wasi_shim-threads
npm ls --prefix page/src/worker_process/vfs_bindings @oligami/browser_wasi_shim-threads
test ! -L node_modules/@oligami/browser_wasi_shim-threads
test ! -L lib/node_modules/@oligami/browser_wasi_shim-threads
test ! -L page/node_modules/@oligami/browser_wasi_shim-threads
test ! -L page/src/worker_process/vfs_bindings/node_modules/@oligami/browser_wasi_shim-threads
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const files = [
    "package.json", "package-lock.json", "lib/package.json", "lib/package-lock.json",
    "page/package.json", "page/package-lock.json",
    "page/src/worker_process/vfs_bindings/package.json",
    "page/src/worker_process/vfs_bindings/bun.lock",
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (/browser_wasi_shim-threads[^\n]*(?:file:|\.tgz|link:)/.test(text)) {
      throw new Error(`${file} contains a local Threads source`);
    }
  }
'
```

Expected: all four contexts report 0.4.1 and no 0.4.0 copy. Verify each physical package directory is not a symbolic link and no manifest or lock contains `.tgz`, `file:`, or link metadata for Threads.

- [ ] **Step 6: Run the complete final verification matrix**

Library:

```bash
npm test
npm run build
test -d /tmp/opencode
npm pack --ignore-scripts --json --pack-destination /tmp/opencode
git diff --check
```

Rubrc:

```bash
bun run build
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_run_test.ts
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_add_test.ts
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_info_test.ts
deno run --no-lock --node-modules-dir=manual -A scripts/vfs_debug_cargo_pipe_test.ts
deno test --no-lock --node-modules-dir=manual -A \
  scripts/webshell_base_call_capacity_test.ts \
  scripts/vfs_child_process_import_test.ts \
  scripts/vfs_child_process_bridge_test.ts \
  scripts/vfs_http_bridge_test.ts \
  scripts/vfs_http_import_test.ts \
  scripts/vfs_build_script_test.ts
cargo test -p vfs --lib
cargo fmt -p vfs -- --check
git diff --check
```

Expected: library tests and build pass; rubrc build and four E2Es exit zero; Deno and VFS tests have zero failures; formatting and diff checks pass.

- [ ] **Step 7: Commit the registry dependency update**

Inspect `git status`, complete diffs, and recent log. Stage exactly the four manifests and five active locks. Commit:

```bash
git add package.json package-lock.json bun.lockb lib/package.json lib/package-lock.json page/package.json page/package-lock.json page/src/worker_process/vfs_bindings/package.json page/src/worker_process/vfs_bindings/bun.lock
git diff --cached --check
git commit -m "chore: require configurable base call allocator"
```

- [ ] **Step 8: Obtain independent reviews**

Review the complete library diff from `a462b91` through the final 0.4.1 commit and the complete rubrc diff from `c5342d6` through the registry update. Require explicit spec PASS and code-quality APPROVED. Fix Critical or Important findings with tests and new commits before continuing.

- [ ] **Step 9: Manual WebShell acceptance**

Ask the user to open the freshly built WebShell and run or observe `load_sysroot wasm32-wasip1`. Acceptance requires the reported entry:

```text
data_len: 32408960
```

to complete without:

```text
base call failed: OutOfMemory
```

- [ ] **Step 10: Push the approved branches**

After all automated checks, reviews, and manual acceptance pass, inspect status/diff/log and push without force:

```bash
git push origin dev
git push origin main
```

Run the first command from `/home/oligami/projects/browser_wasi_shim/threads` and the second from `/home/oligami/projects/rubrc`. Do not push or modify Cargo for this fix.
