# Investigation: `canvas_state_t` cairo_pattern_t members not freed

## What

`canvas_state_t` (declared in `src/CanvasRenderingContext2d.h:19-72`) holds four `cairo_pattern_t*` members:

```cpp
struct canvas_state_t {
  ...
  cairo_pattern_t* fillPattern = nullptr;
  cairo_pattern_t* strokePattern = nullptr;
  cairo_pattern_t* fillGradient = nullptr;
  cairo_pattern_t* strokeGradient = nullptr;
  PangoFontDescription* fontDescription = nullptr;
  ...
  ~canvas_state_t() {
    pango_font_description_free(fontDescription);  // ← only this is freed
  }
};
```

The destructor only frees `fontDescription`. The four `cairo_pattern_t*` members are leaked whenever they're non-null at destruction.

The copy constructor copies the pattern pointers directly (no `cairo_pattern_reference`):

```cpp
canvas_state_t(const canvas_state_t& other) {
  ...
  fillPattern = other.fillPattern;       // raw pointer copy
  strokePattern = other.strokePattern;
  fillGradient = other.fillGradient;
  strokeGradient = other.strokeGradient;
  fontDescription = pango_font_description_copy(other.fontDescription);  // ← deep copy
  ...
}
```

This means a `save()` → `restore()` cycle (which copies state via `states.emplace(states.top())`) shares the same pattern pointer across multiple states. Without refcounting via `cairo_pattern_reference`, freeing it in any state's destructor would create dangling pointers in the others.

## Reachability

Triggered whenever JS code does `ctx.fillStyle = gradient` or `ctx.fillStyle = pattern`. Specifically:

- `CanvasGradient` (linear/radial) → assigned to `fillStyle`/`strokeStyle` → stored as `cairo_pattern_t*` in state
- `CanvasPattern` (image patterns) → same path
- Setting `fillStyle`/`strokeStyle` to a color (not a gradient/pattern) → does NOT touch these fields

For applications that use only colors, the four members stay nullptr forever and there's no leak. For applications that use gradients or patterns (data viz, charting, complex thumbnails), each Context2d that ends life with non-null pattern fields leaks them.

A solid-color thumbnail pipeline (`ctx.fillStyle = 'rgb(...)'` + `ctx.drawImage(...)`) never touches these fields, so it isn't bitten by this. Worth fixing for general node-canvas correctness.

## Audit result

Search code paths that set `fillPattern`/`strokePattern`/`fillGradient`/`strokeGradient`:

```
grep -n "fillPattern\|strokePattern\|fillGradient\|strokeGradient" src/CanvasRenderingContext2d.cc src/CanvasGradient.cc src/CanvasPattern.cc
```

The setters store raw pointers without refcounting:

- `SetFillStyle()` assigns `state->fillGradient = grad->pattern()` or `state->fillPattern = pattern->pattern()`.
- `SetStrokeStyle()` assigns `state->strokeGradient = grad->pattern()` or `state->strokePattern = pattern->pattern()`.
- `_setFillColor()` and `_setStrokeColor()` clear the pointers by assigning `NULL`, without destroying the previous pattern.

The fix is:

1. In setters: `cairo_pattern_reference(new_pattern)` before assigning; `cairo_pattern_destroy(old_pattern)` on the previous value if non-null
2. In `~canvas_state_t`: `if (fillPattern) cairo_pattern_destroy(fillPattern);` (etc.) for all four
3. In copy constructor: `cairo_pattern_reference(other.fillPattern)` for each non-null

cairo patterns are refcounted (`cairo_pattern_reference`/`cairo_pattern_destroy`), so the refcount discipline is straightforward.

## Fix candidate

Add helpers on `canvas_state_t` that:

- `cairo_pattern_reference()` a new non-null pattern when storing it
- `cairo_pattern_destroy()` any previous pattern being replaced or cleared
- copy pattern fields by reference in the copy constructor / assignment operator
- destroy all four pattern fields in `~canvas_state_t`

Also make `_fillStyle` and `_strokeStyle` strong references while a gradient or pattern is active. Without that, prompt finalizers can collect the JS `CanvasGradient`/`CanvasPattern` object while the state still references its native `cairo_pattern_t`.

Local validation with the fix candidate on Node 20.19.5 + `NAPI_EXPERIMENTAL`:

```
mode=color    iter=20000 baseline=49.0M end=87.3M per-iter=1.96 KiB
mode=gradient iter=20000 baseline=49.0M end=92.3M per-iter=2.22 KiB
```

The remaining gradient delta was about 0.26 KiB/iter over the color baseline on macOS.

## Suggested repro

Once the audit is done and you've confirmed setters store raw pointers, this should reproduce:

```js
'use strict';
if (typeof gc !== 'function') {
  console.error('Run with --expose-gc');
  process.exit(1);
}
const canvas = require('canvas');

const ITER = parseInt(process.argv[2] || '20000', 10);
const mb = (n) => +(n / 1024 / 1024).toFixed(1);

(async () => {
  gc(); gc();
  const baseline = mb(process.memoryUsage().rss);
  let last = baseline;
  console.log(`baseline rss=${baseline} MiB`);
  for (let i = 1; i <= ITER; i++) {
    const c = canvas.createCanvas(200, 200);
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 200, 200);
    grad.addColorStop(0, 'red');
    grad.addColorStop(1, 'blue');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 200, 200);
    c.width = 0; c.height = 0;
    if (i % 2000 === 0) {
      gc(); gc();
      const rss = mb(process.memoryUsage().rss);
      console.log(`iter=${i} rss=${rss}M slope=${(((rss - last) * 1024) / 2000).toFixed(2)} KiB/iter`);
      last = rss;
    }
  }
})();
```

Expected if there's a leak: slope > 0 per iter (each leaked `cairo_pattern_t` is small — a few hundred bytes for solid gradients, more for image patterns).

Compare two variants:
- A: `ctx.fillStyle = grad; ctx.fillRect(...)` (sets the gradient, may leak)
- B: `ctx.fillStyle = 'red'; ctx.fillRect(...)` (color only, should not leak from this path)

A clear delta between A and B confirms the cairo_pattern_t leak hypothesis.

## Acceptance criteria

- All four pattern fields are reliably freed in `~canvas_state_t` and never double-freed (cover save/restore via refcounting).
- Gradient/pattern repro slope drops to ~zero after fix.
- Existing save/restore + setStyle tests still pass (run `npm test`).
