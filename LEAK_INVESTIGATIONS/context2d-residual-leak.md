# Investigation: Context2d residual leak (~4 KiB per `getContext("2d")`)

## What

`canvas.createCanvas(w, h)` alone doesn't leak. Adding `getContext("2d")` and immediately discarding the canvas adds a consistent **~9 KiB per iteration** on macOS arm64 and **~4 KiB per iteration** on Linux x64/arm64, sustained for at least 50,000 iterations without plateau.

The leak is:
- **Independent of canvas dimensions** — 50×50 leaks the same as 1000×1000 (~10 KiB/iter). Only at 2000×2000 does the per-iter grow to ~21 KiB, suggesting some component scales with size and some is fixed.
- **Per-call**, not warmup — RSS grows linearly across 50K iterations.
- **C++ side, not JS** — `FinalizationRegistry` confirms every JS Canvas/Context2d wrapper is finalized (`alive` count stays at 0 after `gc()`).

In a sustained server workload this contributes on the order of ~0.5 MiB/min of background noise — annoying but not catastrophic. Worth fixing if cheap; absolutely worth fixing if there's a per-instance scaling effect under heavy load that hasn't been measured.

## Minimal repro

```js
'use strict';
if (typeof gc !== 'function') {
  console.error('Run with --expose-gc');
  process.exit(1);
}
const canvas = require('canvas');

const ITER = parseInt(process.argv[2] || '10000', 10);
const W = parseInt(process.argv[3] || '200', 10);
const H = parseInt(process.argv[4] || '200', 10);
const STEPS = process.argv[5] || 'create,ctx,zero';   // comma list
const REPORT_EVERY = 1000;
const enabled = new Set(STEPS.split(','));
const mb = (n) => +(n / 1024 / 1024).toFixed(1);

(async () => {
  gc(); gc();
  const baseline = mb(process.memoryUsage().rss);
  let last = baseline;
  console.log(`baseline rss=${baseline} MiB`);
  for (let i = 1; i <= ITER; i++) {
    let c;
    if (enabled.has('create')) c = canvas.createCanvas(W, H);
    if (enabled.has('ctx') && c) c.getContext('2d');
    if (enabled.has('zero') && c) { c.width = 0; c.height = 0; }
    if (i % REPORT_EVERY === 0) {
      gc(); gc();
      const rss = mb(process.memoryUsage().rss);
      console.log(`iter=${String(i).padStart(6)} rss=${String(rss).padStart(6)}M slope=${(((rss - last) * 1024) / REPORT_EVERY).toFixed(2)} KiB/iter`);
      last = rss;
    }
  }
})();
```

Run:

```
node --expose-gc repro.js 50000 200 200 'create,zero'        # no leak (0.8 KiB/iter)
node --expose-gc repro.js 50000 200 200 'create,ctx,zero'    # LEAK (~4-10 KiB/iter)
```

## Observed (Linux arm64, node-canvas 3.2.3, glibc malloc, no jemalloc)

```
STEPS              | per-iter
-------------------|---------
create             | 0.84 KiB ✅
create,zero        | 0.81 KiB ✅
create,ctx         | 9.05 KiB 🚨
create,ctx,zero    | 8.95 KiB 🚨
+ clearRect        | 8.98 KiB 🚨
+ fillRect         | 8.99 KiB 🚨
```

50K iter at `create,ctx,zero` 200×200 → +211 MiB delta, **no plateau** through the run. Slope is consistent ~4 KiB/iter on Linux glibc, ~9 KiB/iter on macOS.

Scaling with size (Linux, `create,ctx,zero`):

```
50×50     →  10.12 KiB/iter
200×200   →  10.12 KiB/iter
1000×1000 →  10.92 KiB/iter
2000×2000 →  21.35 KiB/iter
```

Mostly fixed-size per call (consistent with cairo/pango internal state, not surface buffers).

## What we know about the Context2d lifecycle

`Context2d` (in `src/CanvasRenderingContext2d.cc` and `.h`) on construction:

1. Calls `_canvas->createCairoContext()` → `_context = cairo_t*`
2. Calls `pango_cairo_create_layout(_context)` → `_layout = PangoLayout*`
3. Sets pango options (round glyph positions, auto dir off)
4. `states.emplace()` — pushes a `canvas_state_t` whose default constructor allocates `fontDescription = pango_font_description_from_string("sans")` plus sizing call

On destruction (`~Context2d`):

```cpp
Context2d::~Context2d() {
  if (_layout) g_object_unref(_layout);
  if (_context) cairo_destroy(_context);
}
```

Plus `Finalize(Napi::Env)` resets persistent JS handles. `canvas_state_t::~canvas_state_t()` frees `fontDescription` via `pango_font_description_free`.

All of these look symmetric. So if 10 KiB/iter leaks, it's likely:

1. **Pango font map cache** — `pango_cairo_create_layout` calls `pango_cairo_create_context` which calls `pango_cairo_font_map_get_default` (a process-wide singleton). Each new layout may add entries to per-font caches that the singleton never releases.
2. **Pango context internal state** — `pango_cairo_create_context` allocates a `PangoContext` per call. The layout's context is reffed by the layout. `g_object_unref(_layout)` should drop both refs. Verify this is actually the case.
3. **Cairo's font face cache** — cairo maintains a hashtable of `cairo_font_face_t` per scaled font; deletions happen via internal LRU. May not return to zero across iterations.
4. **`canvas_state_t` copy semantics** — `states.emplace()` is the default constructor; no copy. But during `save()`/`restore()` the copy constructor runs and deep-copies `fontDescription` via `pango_font_description_copy`. Our minimal test doesn't call `save`/`restore`, so this shouldn't matter.

## What we already tried

- Removed `Context2d::Finalize` to force destruction via default ObjectWrap path — destructors still run, leak unchanged.
- Toggled `NAPI_EXPERIMENTAL` — destructors fire in both cases, leak rate same.
- Tested with debug build of node-canvas — same leak pattern.

## Follow-up after prompt finalizer fixes

After re-enabling the `NAPI_EXPERIMENTAL` finalizer path from [#2562](https://github.com/Automattic/node-canvas/pull/2562), fixing `CanvasPattern` source lifetime, and fixing `canvas_state_t` cairo pattern ownership, a local macOS/Node 20.19.5 run looked much healthier:

```
node --expose-gc LEAK_INVESTIGATIONS/repros/context2d-residual.js 50000 200 200 'create,ctx,zero'

baseline=51.8M end=98.8M delta=47.0M per-iter=0.96 KiB
```

That does not prove the original Linux glibc leak is gone. It does mean future investigation should retest in the Linux docker environment before assuming the old 4-10 KiB/iter slope still applies.

## What to try next

1. **Massif on the minimal repro with debug libpango/libcairo**. The bundled libpango/libcairo in the canvas-leak-debug docker are stripped binaries; install `libpango1.0-0-dbgsym` and `libcairo2-dbgsym` from Ubuntu debug repos to get symbol names. Look for what grows over the loop.
   ```
   apt-get install -y libpango1.0-0-dbgsym libcairo2-dbgsym
   valgrind --tool=massif --pages-as-heap=no --max-snapshots=30 --time-unit=ms \
     node --expose-gc repro.js 5000 200 200 'create,ctx,zero'
   ms_print massif.out.<pid>
   ```
2. **Run pango's own leak diagnostic**. `G_DEBUG=gc-friendly G_SLICE=always-malloc` makes glib use plain malloc instead of its slice allocator (lets valgrind see everything). Combined with `--show-leak-kinds=reachable`, this should pinpoint Pango caches.
3. **Manually compare `pango_cairo_create_layout` vs `pango_cairo_create_context` + `pango_layout_new`**. The latter is more explicit and might reveal which leg leaks.
4. **Try `pango_cairo_font_map_set_default(NULL)` between iterations** in the repro — if leak goes away, the font map singleton is the culprit. Then look for whether sharp/node-canvas should be calling this on shutdown.
5. **Add a synchronous `vips_thread_shutdown()`-equivalent in `~Context2d`**: pango exposes `pango_cairo_font_map_set_default(NULL)` to reset; using it on each destructor would be wasteful but informative.
6. **Patch `canvas_state_t` destructor to also free any non-null `fillPattern`/`strokePattern`/`fillGradient`/`strokeGradient`** (see `canvas-state-pattern-leak.md`) and re-test — those are nullptr in our minimal repro, so unlikely to change anything but worth ruling out.

## Acceptance criteria

A clean fix should drive the slope on `create,ctx,zero` 200×200 down to ≤ 1 KiB/iter sustained across 50K iterations on Linux glibc, matching the `create,zero` baseline.
