// Repro for Context2d residual leak.
// See ../context2d-residual-leak.md for hypothesis and observed numbers.
//
//   node --expose-gc context2d-residual.js [iterations] [width] [height] [steps]
//
// steps is a comma-separated list of operations per iteration:
//   create   — call canvas.createCanvas(W, H)
//   ctx      — call c.getContext('2d')
//   fillrect — fillStyle + fillRect after ctx
//   clear    — clearRect(0,0,1,1) before zero
//   zero     — set c.width = 0, c.height = 0
//
// Examples:
//   node --expose-gc context2d-residual.js 10000 200 200 'create,zero'        ✅ no leak
//   node --expose-gc context2d-residual.js 10000 200 200 'create,ctx,zero'    🚨 ~9 KiB/iter

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

const ITER = parseInt(process.argv[2] || "10000", 10);
const W = parseInt(process.argv[3] || "200", 10);
const H = parseInt(process.argv[4] || "200", 10);
const STEPS = process.argv[5] || "create,ctx,zero";
const REPORT_EVERY = 1000;
const enabled = new Set(STEPS.split(","));
const mb = (n) => +(n / 1024 / 1024).toFixed(1);

(async () => {
    console.log(`steps=${STEPS} size=${W}x${H} iter=${ITER}`);
    gc();
    gc();
    const baseline = mb(process.memoryUsage().rss);
    let last = baseline;
    console.log(`baseline rss=${baseline} MiB`);
    for (let i = 1; i <= ITER; i++) {
        let c;
        if (enabled.has("create")) c = canvas.createCanvas(W, H);
        if (enabled.has("ctx") && c) c.getContext("2d");
        if (enabled.has("fillrect") && c) {
            const ctx = c.getContext("2d");
            ctx.fillStyle = "red";
            ctx.fillRect(0, 0, W, H);
        }
        if (enabled.has("clear") && c) {
            try {
                c.getContext("2d").clearRect(0, 0, 1, 1);
            } catch (_) {}
        }
        if (enabled.has("zero") && c) {
            c.width = 0;
            c.height = 0;
        }
        if (i % REPORT_EVERY === 0) {
            gc();
            gc();
            const rss = mb(process.memoryUsage().rss);
            console.log(
                `iter=${String(i).padStart(6)} rss=${String(rss).padStart(6)}M slope=${(((rss - last) * 1024) / REPORT_EVERY).toFixed(2)} KiB/iter`
            );
            last = rss;
        }
    }
    gc();
    gc();
    const end = mb(process.memoryUsage().rss);
    console.log(
        `\nbaseline=${baseline}M end=${end}M delta=${(end - baseline).toFixed(1)}M per-iter=${(((end - baseline) * 1024) / ITER).toFixed(2)} KiB`
    );
})();
