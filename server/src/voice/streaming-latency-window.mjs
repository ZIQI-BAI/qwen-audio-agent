export class StreamingLatencyWindow {
  constructor({ maxSamples = 100 } = {}) {
    this.maxSamples = Math.max(1, Number(maxSamples) || 100)
    this.samples = []
  }

  record(value) {
    const latencyMs = Math.max(0, Number(value) || 0)
    this.samples.push(latencyMs)
    if (this.samples.length > this.maxSamples) this.samples.shift()
    const ordered = [...this.samples].sort((left, right) => left - right)
    const index = Math.max(0, Math.ceil(ordered.length * 0.95) - 1)
    return {
      latencyMs,
      sampleCount: ordered.length,
      p95Ms: ordered[index],
      windowSize: this.maxSamples,
    }
  }
}
