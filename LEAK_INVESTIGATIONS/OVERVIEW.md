# node-canvas memory leak investigations

State of every memory leak or native-lifetime bug found in or around node-canvas during a May 2026
investigation of an image-upload pipeline OOM. Some are upstream PRs, some are local fix candidates,
and some are watch items that need better production evidence.

## Environment used for all repros

- node-canvas `v3.2.3` (latest tagged release at investigation time)
- Patched fork [`iurisilvio/node-canvas`](https://github.com/iurisilvio/node-canvas) at `release-fix-memory-leak`, released as `v3.2.3-memfix.1`
- Node 20.19.5
- Linux x64/arm64 in docker (`/tmp/canvas-docker/Dockerfile` — Ubuntu 22.04 + libcairo/libpango/libjpeg/librsvg/libgif system libs + valgrind + binutils)

All scripts assume:
- Run with `node --expose-gc`
- `canvas` is resolvable (either via `require("canvas")` from a project with it installed, or `require("/canvas")` inside the docker setup)

## Status

| # | Bug | Magnitude | Status |
|---|-----|-----------|--------|
| 1 | ObjectWrap finalization is too delayed without `NAPI_EXPERIMENTAL` | 100 × 1024 canvas repro ends around 450 MiB without it vs. 67 MiB with it | ⬜ **upstream PR** — [#2562](https://github.com/Automattic/node-canvas/pull/2562), see [`napi-experimental-coupling.md`](./napi-experimental-coupling.md) |
| 2 | `rotate90`/`rotate270` lambdas never `delete[]` the rotated pixel buffer | 8 MiB/iter for a 1200×1800 image | ✅ **PR filed** — [#2572](https://github.com/Automattic/node-canvas/issues/2572), PR #2574, see [`jpeg-exif-rotation-buffer-leak.md`](./jpeg-exif-rotation-buffer-leak.md) |
| 3 | `decodeJPEGIntoSurface` OOM path mixes `new[]`/`free()` | UB, OOM-only | ✅ **PR filed** — [#2573](https://github.com/Automattic/node-canvas/issues/2573), PR #2575, see [`jpeg-decode-allocator-mismatch.md`](./jpeg-decode-allocator-mismatch.md) |
| 4 | `CanvasPattern` can outlive its source `Image`/`Canvas` | correctness failure when prompt finalizers destroy temporary source canvases | ✅ **local fix candidate** — see [`canvas-pattern-source-lifetime.md`](./canvas-pattern-source-lifetime.md) |
| 5 | `canvas_state_t` does not own `cairo_pattern_t*` refs correctly | per-context leak when fill/stroke style is a gradient or pattern | ✅ **local fix candidate** — see [`canvas-state-pattern-leak.md`](./canvas-state-pattern-leak.md) |
| 6 | Image decoder error paths leave native resources attached | malformed SVG without dimensions leaked ~4.8 KiB/failed `loadImage()` before cleanup | ✅ **local fix candidate** — see [`image-error-path-cleanup-leaks.md`](./image-error-path-cleanup-leaks.md) |
| 7 | Context2d residual leak (`getContext("2d")` alone) | originally ~4-10 KiB/iter sustained; after prompt-finalizer build about 1 KiB/iter on macOS | ⬜ **open/watch** — see [`context2d-residual-leak.md`](./context2d-residual-leak.md) |
| 8 | `canvas.loadImage` error path leaves partial cairo surface | not reproduced with rejecting generated JPEGs | ⬜ **watch** — see [`loadImage-error-path-leak.md`](./loadImage-error-path-leak.md) |

## Things ruled out

- **node-canvas C++ destructors don't fire**: false alarm. Destructors fire correctly when `Finalize` is overridden via `NAPI_EXPERIMENTAL`. My initial debug `fprintf` had no `fflush(stderr)`, so the output never made it to the terminal.
- **glibc malloc fragmentation**: bundling jemalloc via `LD_PRELOAD` in staging showed no measurable difference once the rotate90 leak was fixed. The fragmentation pattern people often blame for sharp/canvas RSS climb is not the primary driver here.
- **Heap snapshot endpoint itself leaking**: real Heisenbug — `v8.getHeapSnapshot()` retained ~200 MiB per call when not properly piped. Fix is to pipe with `node:stream/promises` `pipeline()`. Not a node-canvas issue.
- **The 800-byte `loadImage` truncated JPEG repro**: on macOS/libjpeg-turbo it succeeds as a 1024×1024 image, so its ~4 MiB/iter slope is the ObjectWrap finalizer issue rather than the `onerror` path.
