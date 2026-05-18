# Investigation: Why `NAPI_EXPERIMENTAL` is required and whether we can remove it

## What

`binding.gyp` defines `NAPI_EXPERIMENTAL` (added in commit `37f214b` "Bump node-addon-api to fix memory leak #2436"). Removing it causes a large leak — a 100-iteration test on 1024×1024 canvases ends at **450 MiB** without it versus **57 MiB** with it.

The define exists as a workaround for [Automattic/node-canvas#2436](https://github.com/Automattic/node-canvas/issues/2436) and is proposed upstream in [PR #2562](https://github.com/Automattic/node-canvas/pull/2562). It changes how `node-addon-api`'s `ObjectWrap<T>::FinalizeCallback` routes destruction:

```cpp
// In node-addon-api napi-inl.h, simplified:
if constexpr (details::HasExtendedFinalizer<T>::value) {
  #ifdef NODE_API_EXPERIMENTAL_HAS_POST_FINALIZER
    napi_status status = node_api_post_finalizer(env, PostFinalizeCallback, data, nullptr);
  #else
    HandleScope scope(env);
    PostFinalizeCallback(env, data, nullptr);   // immediate, may run during GC
  #endif
} else {
  delete instance;
}
```

`Context2d::Finalize(Napi::Env)` is an extended finalizer. With `NAPI_EXPERIMENTAL` defined, Node sets `NODE_API_EXPERIMENTAL_HAS_POST_FINALIZER` and the destruction is deferred via `node_api_post_finalizer`, which gives the callback a regular (non-basic) env that can call into JS. Without it, the framework runs `PostFinalizeCallback` synchronously inside the GC pass — and JS-touching code in `Context2d::Finalize` would crash or assert.

The cost we observed: **without `NAPI_EXPERIMENTAL`, 100 × 1024×1024 canvases consume 450 MiB; with it, 57 MiB.** That's an 8× difference. The likely explanation is that the in-GC `PostFinalizeCallback` path is somehow failing to actually delete the wrapper (or `AdjustExternalMemory` isn't credited), but we didn't isolate the exact mechanism.

The production-shaped repro in PR #2562 shows the same behavior more dramatically: 50 batches of concurrent JPEG thumbnail generation climbed to ~3.5 GiB without the fix and stayed around ~196 MiB with `node-addon-api` 8 + `NAPI_EXPERIMENTAL`.

## Why it matters

`NAPI_EXPERIMENTAL` is, by definition, unstable — node-addon-api may change `NODE_API_EXPERIMENTAL_HAS_POST_FINALIZER` behavior in future Node versions and break our build. We'd like to depend only on stable API.

## Repro

Same as the [memory test](https://github.com/iurisilvio/node-canvas/blob/release-fix-memory-leak/test/memory.test.js) already added to the patched fork:

```js
const { createCanvas } = require('canvas');
const SIZE = 1024;
for (let i = 0; i < 100; i++) {
  const c = createCanvas(SIZE, SIZE);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, SIZE, SIZE);
  gc();
}
gc(); gc();
console.log('rss=', (process.memoryUsage().rss / 1024 / 1024).toFixed(0), 'MiB (expect < 150)');
```

Run with `--expose-gc`. Build node-canvas with and without `NAPI_EXPERIMENTAL` in `binding.gyp` and compare end-of-run RSS.

## What to figure out

1. **What does `node_api_post_finalizer` do differently from the synchronous path?** Read the Node source. The deferred dispatch lets the callback do JS allocations safely, but for `Context2d::Finalize` which only does `_resetPersistentHandles()` (resets `Napi::Reference` instances), the difference shouldn't be functional. So why does RSS differ 8×?

2. **Is `AdjustExternalMemory(-_data_len)` the dependency?** `Canvas::destroySurface()` (called when the canvas is destroyed via `~Canvas`) calls `Napi::MemoryManagement::AdjustExternalMemory(env, -...)` which signals V8 to GC. If this call lands in the synchronous path before V8 has finished GC'ing the wrapper, maybe the wrapper isn't yet marked dead and V8 ignores the signal. Need to verify.

3. **Could we change `Context2d::Finalize` to use the basic finalizer signature** (`Finalize(Napi::BasicEnv)` instead of `Finalize(Napi::Env)`)? `HasBasicFinalizer<T>::value` branches synchronously without `node_api_post_finalizer`. If `_resetPersistentHandles()` only resets `Napi::Reference` instances and doesn't allocate JS values, it should work with BasicEnv. If we can do this, we'd no longer need `NAPI_EXPERIMENTAL`.

4. **Or just delete `Context2d::Finalize` entirely.** It only calls `_resetPersistentHandles()`. If the JS handles get cleaned up via `~Reference` (called by `~ObjectWrap` → `~Context2d`), we don't need the explicit Finalize at all. The original commit that added it ([`70645e1`](https://github.com/iurisilvio/node-canvas/commit/70645e1)) was paired with `Canvas::Finalize` and `CanvasPattern::Finalize`, but later [`3cd5329`](https://github.com/iurisilvio/node-canvas/commit/3cd5329) removed `Canvas::Finalize` ("Memory leak really fixed") — so the pattern of "no Finalize override + immediate `delete instance`" works for Canvas. Can it work for Context2d?

## Suggested experiments

```
1. Remove Context2d::Finalize, keep NAPI_EXPERIMENTAL → does memory.test.js pass?
2. Remove Context2d::Finalize AND remove NAPI_EXPERIMENTAL → does memory.test.js pass?
3. Change Context2d::Finalize signature to BasicEnv → does memory.test.js pass without NAPI_EXPERIMENTAL?
```

If any of (1), (2), or (3) keeps memory.test.js passing, we have a stable path.

## Follow-up finding

Re-enabling `NAPI_EXPERIMENTAL` made finalizers run promptly enough to expose a separate lifetime bug: `CanvasPattern` could outlive the temporary source `Canvas` used to create it, and `Canvas::destroySurface()` would finish the cairo surface while the pattern still referenced it. The fix is for `CanvasPattern` to retain its source `Image`/`Canvas` JS object until the pattern is destroyed.

Also, prompt finalization means style objects need real ownership:

- `Context2d` must keep strong references to active `CanvasGradient`/`CanvasPattern` JS objects.
- `canvas_state_t` must own `cairo_pattern_t*` fields with `cairo_pattern_reference()` / `cairo_pattern_destroy()`.

Those fixes make `npm test` pass with `NAPI_EXPERIMENTAL` enabled in the local Node 20.19.5 build.

## Acceptance criteria

- `binding.gyp` no longer defines `NAPI_EXPERIMENTAL`
- `npm test` passes including the memory test
- The 100×1024-canvas-RSS stays under 150 MiB

## Files

- `binding.gyp` — line that defines the macro
- `src/CanvasRenderingContext2d.h:217` — `void Finalize(Napi::Env env);` declaration
- `src/CanvasRenderingContext2d.cc:249-251` — implementation (calls `_resetPersistentHandles()`)
- `src/Canvas.cc:991-995` — `destroySurface` with `AdjustExternalMemory` call
- `node_modules/node-addon-api/napi-inl.h` — search for `FinalizeCallback`, `PostFinalizeCallback`, `HasExtendedFinalizer`, `NODE_API_EXPERIMENTAL_HAS_POST_FINALIZER`
- `test/memory.test.js` — the existing regression test
