# Investigation: `CanvasPattern` can outlive its source surface

## What

`CanvasPattern` stores a `cairo_pattern_t*` created from a source `Image` or `Canvas`, but it does not retain the JS source object. When native finalizers run promptly, the source `Canvas` can be garbage-collected and `Canvas::destroySurface()` can finish/destroy the cairo surface while the pattern still points at it.

This surfaced while re-enabling the `NAPI_EXPERIMENTAL` finalizer path from [Automattic/node-canvas#2562](https://github.com/Automattic/node-canvas/pull/2562). With slower/deferred finalization, the source often survived long enough by accident.

## Repro shape

The existing `Context2d#createPattern(Canvas).setTransform()` test is enough when finalizers run promptly:

```js
const pat = ctx.createPattern(makeCheckerboard(w, h), "repeat");
ctx.fillStyle = pat;

pat.setTransform(new DOMMatrix().scale(0.5));
ctx.fillRect(0, 0, w * 0.5, h * 0.5);
```

`makeCheckerboard(w, h)` returns a temporary canvas with no JS reference after `createPattern()` returns. Prompt GC can destroy that canvas before the pattern is used again.

Observed failure with `NAPI_EXPERIMENTAL` enabled before the fix:

```
Context2d#createPattern(Canvas).setTransform()
AssertionError: assert.ok(r==clr && g==clr && b==clr && a==255)
```

## Cause

`Pattern::Pattern()` does:

```cpp
surface = canvas->ensureSurface();
_pattern = cairo_pattern_create_for_surface(surface);
```

The cairo pattern references the cairo surface internally, but `Canvas::destroySurface()` calls `cairo_surface_finish(_surface)` before `cairo_surface_destroy(_surface)`. A finished surface is no longer a valid live backing store for pattern rendering, even if cairo still has a reference.

## Fix

Have `CanvasPattern` retain the source JS object for as long as the pattern exists:

```cpp
Napi::Reference<Napi::Object> _source;
_source.Reset(obj, 1);
```

Then reset `_source` in `Pattern::~Pattern()`.

## Production relevance

This is a correctness bug more than an RSS leak. It matters because the memory fix in PR #2562 makes finalization prompt enough to expose latent lifetime issues. Any production build using the prompt finalizer path should keep the source object alive from `CanvasPattern`.
