// Direct port of test/memory.test.js as a standalone script.
// Build node-canvas with and without NAPI_EXPERIMENTAL in binding.gyp,
// run this each time, compare end-of-run RSS.
//
//   node --expose-gc napi-experimental-test.js
//
// Expected:
//   WITH    NAPI_EXPERIMENTAL: rss < 150 MiB after 100 iters
//   WITHOUT NAPI_EXPERIMENTAL: rss ~450 MiB (memory.test.js fails)

"use strict";
if (typeof gc !== "function") {
    console.error("Run with --expose-gc");
    process.exit(1);
}
let canvas;
try {
    canvas = require("canvas");
} catch (_) {
    canvas = require("../..");
}
const { createCanvas } = canvas;

const ITER = 100;
const SIZE = 1024;
const mb = (n) => +(n / 1024 / 1024).toFixed(1);

(async () => {
    for (let i = 0; i < ITER; i++) {
        const c = createCanvas(SIZE, SIZE);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "red";
        ctx.fillRect(0, 0, SIZE, SIZE);
        gc();
    }
    gc();
    gc();
    const rss = mb(process.memoryUsage().rss);
    const ok = rss < 150;
    console.log(`rss=${rss} MiB after ${ITER} × ${SIZE}×${SIZE} canvases — expected < 150`);
    console.log(ok ? "PASS" : "FAIL");
    process.exit(ok ? 0 : 1);
})();
