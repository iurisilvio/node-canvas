// Repro for canvas.loadImage error path leak.
// See ../loadImage-error-path-leak.md for context.
//
//   node --expose-gc loadImage-error-path.js [iterations]
//
// Generates a JPEG with a valid header but truncated scan data so libjpeg
// allocates the cairo surface, then fails. canvas.loadImage's onerror path
// doesn't clear image.src, so the partial surface stays attached until V8 GC.

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

const ITER = parseInt(process.argv[2] || "2000", 10);
const TRUNCATE_BYTES = parseInt(process.argv[4] || "600", 10);
const mb = (n) => +(n / 1024 / 1024).toFixed(1);

function makeTruncatedJpeg() {
    const c = canvas.createCanvas(1024, 1024);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 1024, 1024);
    const full = c.toBuffer("image/jpeg", { quality: 0.9 });
    c.width = 0;
    c.height = 0;
    return full.slice(0, TRUNCATE_BYTES);
}

// The fix candidate — clears src on error before rejecting
function loadImageSafe(buf) {
    return new Promise((resolve, reject) => {
        const img = new canvas.Image();
        img.onload = () => {
            img.onload = null;
            img.onerror = null;
            resolve(img);
        };
        img.onerror = (e) => {
            img.onload = null;
            img.onerror = null;
            try {
                img.src = Buffer.alloc(0);
            } catch (_) {}
            reject(e);
        };
        img.src = buf;
    });
}

(async () => {
    const buf = makeTruncatedJpeg();
    const mode = process.argv[3] === "safe" ? "loadImageSafe" : "canvas.loadImage";
    const fn = mode === "safe" ? loadImageSafe : canvas.loadImage.bind(canvas);
    gc();
    gc();
    const baseline = mb(process.memoryUsage().rss);
    let last = baseline;
    let ok = 0;
    let fail = 0;
    console.log(`mode=${mode} truncated jpeg = ${buf.length} bytes baseline rss=${baseline} MiB`);
    for (let i = 1; i <= ITER; i++) {
        try {
            await fn(buf);
            ok++;
        } catch (_) {
            fail++;
        }
        if (i % 200 === 0) {
            gc();
            gc();
            const rss = mb(process.memoryUsage().rss);
            console.log(
                `iter=${String(i).padStart(5)} rss=${String(rss).padStart(6)}M slope=${(((rss - last) * 1024) / 200).toFixed(2)} KiB/iter`
            );
            last = rss;
        }
    }
    gc();
    gc();
    const end = mb(process.memoryUsage().rss);
    console.log(`ok=${ok} fail=${fail}`);
    console.log(
        `\nbaseline=${baseline}M end=${end}M delta=${(end - baseline).toFixed(1)}M per-iter=${(((end - baseline) * 1024) / ITER).toFixed(2)} KiB`
    );
})();
