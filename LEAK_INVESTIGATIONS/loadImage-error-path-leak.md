# Investigation: `canvas.loadImage` error path leaks the partial cairo surface

## What

`canvas.loadImage(buf)` (the helper in `lib/image.js`) wraps `new Image()` + `image.src = buf`. On failure (`onerror` fires), the helper rejects the Promise but historically did not clear `image.src`. Clearing it is still a cheap way to release any native image state before the JS wrapper is collected.

A common app-side workaround is a `loadImageSafe` wrapper that explicitly assigns `image.src = Buffer.alloc(0)` in the `onerror` handler before rejecting. With glibc malloc under heavy concurrent decode of malformed JPEGs, this gives a visible reduction in RSS climb in staged tests.

**Standalone status:** the original 800-byte truncated JPEG repro was misleading on macOS/libjpeg-turbo: it resolves successfully as a 1024x1024 image, so the ~4 MiB/iter RSS growth was the ObjectWrap finalizer issue rather than `loadImage`'s error path. Shorter truncations that actually reject (100-600 bytes in this generated JPEG) do not show a per-call leak in the updated repro.

## Suggested repro

Need a buffer that JPEG-decodes far enough to allocate a cairo surface, then fails. The cleanest way is a JPEG with a valid SOI + SOF0 header (libjpeg learns the dimensions and allocates the surface) but truncated/garbage scan data (decode fails mid-stream).

```js
'use strict';
if (typeof gc !== 'function') {
  console.error('Run with --expose-gc');
  process.exit(1);
}
const canvas = require('canvas');

// Build a buffer: valid 1024x1024 JPEG header, then chop off the scan data.
// libjpeg learns the dimensions, allocates the cairo surface, then hits EOF
// during entropy decode and returns CAIRO_STATUS_READ_ERROR.
function makeTruncatedJpeg() {
  const c = canvas.createCanvas(1024, 1024);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, 1024, 1024);
  const full = c.toBuffer('image/jpeg', { quality: 0.9 });
  c.width = 0; c.height = 0;
  return full.slice(0, TRUNCATE_BYTES);
}

const ITER = parseInt(process.argv[2] || '2000', 10);
const TRUNCATE_BYTES = parseInt(process.argv[3] || '600', 10);
const mb = (n) => +(n / 1024 / 1024).toFixed(1);

(async () => {
  const buf = makeTruncatedJpeg();
  gc(); gc();
  const baseline = mb(process.memoryUsage().rss);
  let ok = 0;
  let fail = 0;
  console.log(`baseline rss=${baseline} MiB, truncated jpeg = ${buf.length} bytes`);

  for (let i = 1; i <= ITER; i++) {
    try { await canvas.loadImage(buf); ok++; } catch (_) { fail++; }
    if (i % 200 === 0) {
      gc(); gc();
      console.log(`iter=${i} rss=${mb(process.memoryUsage().rss)} MiB`);
    }
  }
  gc(); gc();
  const end = mb(process.memoryUsage().rss);
  console.log(`ok=${ok} fail=${fail}`);
  console.log(`\nbaseline=${baseline}M end=${end}M delta=${(end - baseline).toFixed(1)}M per-iter=${(((end - baseline) * 1024) / ITER).toFixed(2)} KiB`);
})();
```

Compare against a safe wrapper:

```js
function loadImageSafe(buf) {
  return new Promise((resolve, reject) => {
    const img = new canvas.Image();
    img.onload = () => { img.onload = null; img.onerror = null; resolve(img); };
    img.onerror = (e) => {
      img.onload = null;
      img.onerror = null;
      try { img.src = Buffer.alloc(0); } catch (_) {}
      reject(e);
    };
    img.src = buf;
  });
}
```

If `canvas.loadImage` shows a per-iter leak proportional to `1024 × 1024 × 4 ≈ 4 MiB` per call, first confirm `fail > 0`. If `ok === ITER`, the repro is measuring successful image finalization, not the error path.

## Where the fix would land

`lib/image.js` in node-canvas, in the `loadImage` exported helper. Mirror the safe wrapper above: null out `src` before rejecting.

## Acceptance criteria

Validate the repro on a stock build with a truncation length that actually rejects. Per-iter leak should stay at allocator noise (<1 KiB/iter on rejecting truncated JPEG decodes).
