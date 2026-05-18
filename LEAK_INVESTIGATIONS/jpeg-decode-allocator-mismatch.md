# Investigation: `decodeJPEGIntoSurface` allocator mismatch on OOM path

## What

`Image::decodeJPEGIntoSurface()` allocates `data` with `new uint8_t[]`, then frees it with `free(data)` if allocating the scanline `src` buffer fails. Mixing `new[]` and `free()` is undefined behavior.

This is tracked upstream as [Automattic/node-canvas#2573](https://github.com/Automattic/node-canvas/issues/2573) with fix PR [#2575](https://github.com/Automattic/node-canvas/pull/2575).

## Impact

This is an OOM-only correctness bug, not the main steady-state leak. The trigger requires:

1. `data = new uint8_t[naturalWidth * naturalHeight * channels]` succeeds.
2. `src = new uint8_t[naturalWidth * output_components]` fails.
3. The error path calls `free(data)` instead of `delete[] data`.

That combination is rare, but under memory pressure it can corrupt allocator metadata or crash instead of failing cleanly.

## Cause

The rest of `Image.cc` already frees `new[]` image buffers with `delete[]`. This branch was the outlier:

```cpp
uint8_t *data = new uint8_t[naturalWidth * naturalHeight * channels];
uint8_t *src = new uint8_t[naturalWidth * args->output_components];
if (!src) {
  free(data); // wrong allocator
  jpeg_abort_decompress(args);
  jpeg_destroy_decompress(args);
  return CAIRO_STATUS_NO_MEMORY;
}
```

GCC reports this as `-Wmismatched-new-delete`.

## Fix

Replace `free(data)` with `delete[] data`.

## Production relevance

Low probability but worth fixing. It only fires under severe memory pressure, which is exactly when predictable cleanup matters most.
