# Investigation: JPEG EXIF rotation leaks the temporary rotated buffer

## What

`Image::rotatePixels()` allocates a temporary `unrotated` buffer in the `rotate90` and `rotate270` lambdas and never frees it. Any JPEG with EXIF orientation 5, 6, 7, or 8 leaks `width * height * channels` bytes per decode.

This is tracked upstream as [Automattic/node-canvas#2572](https://github.com/Automattic/node-canvas/issues/2572) with fix PR [#2574](https://github.com/Automattic/node-canvas/pull/2574).

## Impact

This is high impact for upload workloads because phone-camera JPEGs commonly carry EXIF orientation. A 1200x1800 image with 4 channels leaks about 8.2 MiB per `loadImage()` call. In a 2 GiB container, the minimal repro OOMs around a few hundred iterations.

Observed on Linux arm64 with node-canvas 3.2.3:

```
baseline rss=74 MiB
iter=10  rss=171 MiB
iter=50  rss=500 MiB
iter=100 rss=911 MiB

baseline=74M end=911M delta=837M per-iter=8572 KiB
```

## Cause

The affected lambdas allocate `unrotated` with `new uint8_t[n_bytes]`, copy the original pixels into it, then copy rotated pixels back into `pixels`. They return without `delete[] unrotated`.

```cpp
auto rotate90 = [](uint8_t* pixels, int width, int height, int channels) {
  const int n_bytes = width * height * channels;
  uint8_t *unrotated = new uint8_t[n_bytes];
  // copy and rotate...
  // missing delete[] unrotated
};
```

`mirrorHoriz` and `mirrorVert` are not affected because they swap pixels in place.

## Fix

Add `delete[] unrotated;` before returning from both `rotate90` and `rotate270`.

After the fix, the same repro plateaus after allocator warmup instead of growing linearly.

## Production relevance

Very likely relevant to any pipeline that decodes user-uploaded JPEGs. It scales with decoded image area, so even a modest error rate or repeated thumbnail generation on EXIF-rotated phone images can dominate RSS growth.
