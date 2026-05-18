// Repro for canvas_state_t cairo_pattern_t leak hypothesis.
// See ../canvas-state-pattern-leak.md.
//
//   node --expose-gc canvas-state-pattern.js [iterations] [mode]
//
// mode: 'gradient' (sets fillStyle to a gradient — suspected leak)
//        'color'   (control — sets fillStyle to a color string)
//
// Expected: 'gradient' shows positive slope, 'color' shows ~zero. If both
// show the same slope, this leak hypothesis is wrong (or dominated by the
// context2d-residual-leak).

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

const ITER = parseInt(process.argv[2] || "20000", 10);
const MODE = process.argv[3] || "gradient";
const mb = (n) => +(n / 1024 / 1024).toFixed(1);

(async () => {
    gc();
    gc();
    const baseline = mb(process.memoryUsage().rss);
    let last = baseline;
    console.log(`mode=${MODE} iter=${ITER} baseline rss=${baseline} MiB`);
    for (let i = 1; i <= ITER; i++) {
        const c = canvas.createCanvas(200, 200);
        const ctx = c.getContext("2d");
        if (MODE === "gradient") {
            const grad = ctx.createLinearGradient(0, 0, 200, 200);
            grad.addColorStop(0, "red");
            grad.addColorStop(1, "blue");
            ctx.fillStyle = grad;
        } else {
            ctx.fillStyle = "red";
        }
        ctx.fillRect(0, 0, 200, 200);
        c.width = 0;
        c.height = 0;
        if (i % 2000 === 0) {
            gc();
            gc();
            const rss = mb(process.memoryUsage().rss);
            console.log(
                `iter=${String(i).padStart(5)} rss=${String(rss).padStart(6)}M slope=${(((rss - last) * 1024) / 2000).toFixed(2)} KiB/iter`
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
