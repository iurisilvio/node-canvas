# Memory leak investigations

Working notes on memory leaks in/around node-canvas, with self-contained reproducers. Intended as input for autonomous agents continuing the work.

## Layout

- [`OVERVIEW.md`](./OVERVIEW.md) — index of all investigations, status, and what's been ruled out
- Per-investigation dossiers:
  - [`napi-experimental-coupling.md`](./napi-experimental-coupling.md) — why PR #2562 needs `NAPI_EXPERIMENTAL`, what it fixes, and the remaining stable-API question
  - [`jpeg-exif-rotation-buffer-leak.md`](./jpeg-exif-rotation-buffer-leak.md) — EXIF rotate90/rotate270 temporary buffer leak
  - [`jpeg-decode-allocator-mismatch.md`](./jpeg-decode-allocator-mismatch.md) — OOM-only `new[]`/`free()` mismatch in JPEG decode
  - [`context2d-residual-leak.md`](./context2d-residual-leak.md) — ~4 KiB/iter sustained from `getContext("2d")` alone
  - [`loadImage-error-path-leak.md`](./loadImage-error-path-leak.md) — `canvas.loadImage` doesn't clear `src` on `onerror`
  - [`image-error-path-cleanup-leaks.md`](./image-error-path-cleanup-leaks.md) — SVG/GIF/MIME/Cairo error paths that leave native resources attached
  - [`canvas-state-pattern-leak.md`](./canvas-state-pattern-leak.md) — `cairo_pattern_t*` members in `canvas_state_t` never freed
  - [`canvas-pattern-source-lifetime.md`](./canvas-pattern-source-lifetime.md) — `CanvasPattern` must retain its source when finalizers run promptly
  - [`sharp-libvips-globals.md`](./sharp-libvips-globals.md) — adjacent leak in libvips/libheif (not node-canvas)
- `repros/` — runnable scripts for each open investigation

## Running

All scripts require `node --expose-gc`. They `require('canvas')` and resolve from `node_modules` in the project they're run from, so they expect a project (or a `node_modules/canvas` in `cwd`).

```
cd <project-with-canvas-installed>
node --expose-gc <path-to-this-repo>/LEAK_INVESTIGATIONS/repros/context2d-residual.js 10000 200 200 'create,ctx,zero'
```

For valgrind/massif investigations, use the existing docker setup at `/tmp/canvas-docker/` (Ubuntu 22.04 + libcairo/libpango/libjpeg + valgrind + binutils). The Dockerfile rebuilds node-canvas from this repo's `src/` against the system libs.

## Status snapshot (May 2026)

Fixed locally / PR filed:
- [#2572](https://github.com/Automattic/node-canvas/issues/2572) / PR [#2574](https://github.com/Automattic/node-canvas/pull/2574) — JPEG EXIF rotation leak (rotate90/rotate270)
- [#2573](https://github.com/Automattic/node-canvas/issues/2573) / PR [#2575](https://github.com/Automattic/node-canvas/pull/2575) — `new[]`/`free()` allocator mismatch
- Local fix candidate — `canvas_state_t` pattern ownership via cairo refcounts
- Local fix candidate — `CanvasPattern` retains its source `Image`/`Canvas`
- Local fix candidate — SVG/GIF/MIME/Cairo error-path cleanup

Open:
- [#2562](https://github.com/Automattic/node-canvas/pull/2562) — `NAPI_EXPERIMENTAL` finalizer path fixes large canvas RSS growth, but still needs upstream review/stable-API decision
- Context2d residual (`getContext` alone): ~4 KiB/iter sustained
- `loadImage` error path: original 800-byte repro was measuring successful image finalization; rejecting truncations do not reproduce a standalone leak
