# Investigation: image decoder error paths leave native resources attached

## What

Several image decoder error paths allocate native resources and then return an error without fully releasing them. The biggest reproduced case is malformed SVG input that creates an `RsvgHandle` but has no intrinsic width/height.

This is separate from the JPEG EXIF rotation leak and the ObjectWrap finalizer issue. It is smaller per call, but it is directly reachable from `canvas.loadImage()` on invalid user-supplied image bytes.

## Confirmed SVG repro

Input:

```js
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M1,1"/></svg>');
```

Before cleanup fixes, repeated `loadImage(svg)` failures on macOS/Node 20.19.5:

```
iter=2000 rss=64.3M slope=8.192 KiB/iter
iter=10000 rss=99.8M slope=4.250 KiB/iter
iter=20000 rss=141.1M slope=4.198 KiB/iter

baseline=48.3M end=141.1M delta=92.8M per-iter=4.751 KiB
```

After native SVG cleanup plus clearing `image.src` in `loadImage`'s `onerror` handler:

```
iter=2000 rss=58.0M slope=5.069 KiB/iter
iter=10000 rss=62.7M slope=0.358 KiB/iter
iter=20000 rss=66.9M slope=0.410 KiB/iter

baseline=48.1M end=66.9M delta=18.8M per-iter=0.963 KiB
```

The remaining slope is similar to finalizer/context allocator noise.

## Causes

### SVG missing dimensions

`Image::loadSVGFromBuffer()` creates `_rsvg` with `rsvg_handle_new_from_data()`, then returns `CAIRO_STATUS_READ_ERROR` when width/height are not set. The old path left `_rsvg` attached until the JS `Image` wrapper was collected.

Fix:

- initialize `d_width`/`d_height`
- check the return value of `rsvg_handle_get_intrinsic_size_in_pixels()`
- `g_object_unref(_rsvg)`, set `_rsvg = NULL`, and reset `_is_svg` before returning the error

### SVG render failures

`Image::renderSVGToSurface()` unreffed `_rsvg` on some failures but did not consistently clear `_rsvg`, destroy `_surface`, or destroy the cairo context. Some callers could then double-unref later through `clearData()`.

Fix:

- destroy any created cairo context before returning
- destroy and null `_surface`
- unref and null `_rsvg`
- do not unref `_rsvg` again in callers after `renderSVGToSurface()` has already cleaned up

### `loadImage()` JS helper

The exported `loadImage()` helper only removed `onload`/`onerror` handlers on failure. It did not clear `image.src`, so any native state left on the `Image` object survived until finalization.

Fix:

```js
image.onerror = (err) => {
  cleanup()
  image.src = Buffer.alloc(0)
  reject(err)
}
```

### GIF with no color table

`Image::loadGIFFromBuffer()` allocates `data` before validating that either a local or global color map exists. If `colormap == nullptr`, it closes the GIF and returns without `delete[] data`.

Fix: `delete[] data` before returning `CAIRO_STATUS_READ_ERROR`.

The minimal GIF repro is tiny, so RSS does not show a large slope, but the ownership bug is real.

### JPEG MIME data attachment failure

`Image::assignDataAsMime()` allocates `mime_data` and `mime_closure`, adjusts external memory, then calls `cairo_surface_set_mime_data()`. If cairo rejects the mime data, the old path returns the error without freeing either allocation or reversing `AdjustExternalMemory()`.

Fix: on non-success status, undo external memory accounting and free both allocations.

### Transparent pattern OOM branch

`create_transparent_pattern()` creates `mask_surface` and `mask_context`; if `cairo_status(mask_context)` fails, the old path returns `NULL` without destroying either object.

Fix: destroy `mask_context` and `mask_surface` before returning.

## Production relevance

Malformed SVG uploads are the most plausible production hit from this batch, especially if clients submit SVGs without explicit dimensions. The other fixes are mostly corrupt-input or OOM paths, but they reduce damage during exactly the failure modes that tend to coincide with RSS pressure.
