# Adjacent: Sharp / libvips global codec state

Not a node-canvas leak, but in the same upload pipeline. Documenting for completeness so an agent doesn't repeat the investigation.

## What

When upload code falls back from `canvas.loadImage` to `sharp(buf).toFormat('jpeg').toBuffer()` for WebP / HEIC / AVIF, RSS grows steadily even though `sharp.cache(false)` is set, `sh.destroy()` is called per request, and sharp internally calls `vips_thread_shutdown()` at the end of every pipeline.

Steady-state slope on Linux x64, sharp 0.34.5, after warmup (~500 iters):

```
Format        | sustained KiB/iter
--------------|-------------------
AVIF          |  1-3
WebP          |  3-5
HEIC          |  ~2 (can't test sharp HEIC without libheif decoder)
```

Warmup is large (~600 KiB/iter for the first 200-500 calls) as the codec arenas fill, then stabilizes. For a process doing thousands of these calls per hour, the warmup is one-time but the residual adds up.

## Why it leaks

`sharp.destroy()` is `stream.Duplex.prototype.destroy` (Sharp instances are Node streams). It releases stream-side resources but **does not release libvips memory**. Sharp's per-pipeline `vips_thread_shutdown()` cleans thread-local state but not the format decoders' global state:

- libheif maintains a global codec plugin registry and per-decoder caches
- libaom (AV1 decoder used for AVIF) has internal state pools
- libwebp's WebP decoder caches
- libvips operation graph caches (we disable via `sharp.cache(false)` but not all)

None of these get a per-call reset path from sharp's JS API. Two known issues track this:

- [strukturag/libheif#1684](https://github.com/strukturag/libheif/issues/1684) (closed) — memory leak in `heif_image_create` from corrupt files
- [strukturag/libheif#1718](https://github.com/strukturag/libheif/issues/1718) (open) — same family, different fuzzer corpus

The canonical sharp maintainer guidance for this kind of leak is "run sharp in a `child_process`" ([lovell/sharp#1041](https://github.com/lovell/sharp/issues/1041)).

## App-side workaround

One viable workaround is to detect AVIF and HEIC from magic bytes (`ftyp` box brand) inside the application's image-loading helper and route them to dedicated WASM decoders before falling back to sharp:

- AVIF → `@jsquash/avif` decoder + small sharp call to convert raw RGBA → JPEG
- HEIC → `heic-convert` (pure WASM, no libvips)
- WebP and unknown → sharp

This avoids hitting libheif/libavif for the formats that can be decoded otherwise. WebP still goes through sharp unless a separate WebP decoder is bundled.

## What's not yet tried (could move the residual further down)

1. **`@jsquash/webp`** as a sharp replacement for WebP. Would close the residual leak from WebP entirely.
2. **Worker thread isolation** — move all sharp calls into a `worker_threads` Worker that's recycled every N requests. Cheaper than `child_process`. Bounds the leak by worker lifetime.
3. **Build sharp with debug libvips + libheif + libaom** and run valgrind massif. Identify the exact symbols that grow over iterations. Then either patch upstream or work around.

## Acceptance criteria

If you're going to investigate this further, the target is to drive the steady-state slope of a long-running sharp repro (e.g. inside a docker-debug setup) to ≤ 1 KiB/iter for all of AVIF, WebP, HEIC after 5000 iterations.
