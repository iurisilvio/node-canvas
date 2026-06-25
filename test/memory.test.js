/* eslint-env mocha */

'use strict'

// These tests require --expose-gc (see the "test" script in package.json).
// Skip gracefully if gc is not available.
const gcAvailable = typeof gc === 'function'

const assert = require('assert')
const { createCanvas } = require('../')

// Drain deferred N-API finalizers. gc() only *schedules* the ObjectWrap
// destructors (which free the cairo surfaces) to run on the next event-loop
// turn under the standard (non-nogc) finalization model, so we must let
// setImmediate fire before the native memory is actually released.
async function drainGc () {
  for (let i = 0; i < 3; i++) {
    gc()
    await new Promise(resolve => setImmediate(resolve))
  }
}

describe('Memory management', function () {
  before(function () {
    if (!gcAvailable) this.skip()
  })

  it('Canvas objects are freed by GC', async function () {
    this.timeout(20000)
    const ITERATIONS = 100
    const SIZE = 1024 // 1024x1024 ARGB = 4 MiB per canvas

    for (let i = 0; i < ITERATIONS; i++) {
      const canvas = createCanvas(SIZE, SIZE)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = 'red'
      ctx.fillRect(0, 0, SIZE, SIZE)
      if (i % 10 === 0) await drainGc()
    }

    await drainGc()

    // 100 canvases x 4 MiB = ~400+ MiB resident if the surfaces leak. With them
    // freed it settles around ~110 MiB. The threshold sits between the two so it
    // catches a real surface leak without being flaky on CI base-RSS variance.
    const rssMiB = process.memoryUsage().rss / 1024 / 1024
    assert(rssMiB < 256, `RSS is ${rssMiB.toFixed(0)} MiB, expected < 256 MiB`)
  })
})
