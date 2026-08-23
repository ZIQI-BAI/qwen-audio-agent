import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamingLatencyWindow } from '../src/voice/streaming-latency-window.mjs'

test('reports P95 over a bounded first-audio latency window', () => {
  const window = new StreamingLatencyWindow({ maxSamples: 20 })
  let result
  for (let latency = 100; latency <= 2000; latency += 100) {
    result = window.record(latency)
  }
  assert.deepEqual(result, {
    latencyMs: 2000,
    sampleCount: 20,
    p95Ms: 1900,
    windowSize: 20,
  })
  result = window.record(50)
  assert.equal(result.sampleCount, 20)
  assert.equal(result.p95Ms, 1900)
})
