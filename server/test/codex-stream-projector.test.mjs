import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexStreamProjector } from '../src/voice/codex-stream-projector.mjs'

const identity = {
  requestId: 'request-1', turnId: 'turn-1', taskId: 'task-1', generation: 1,
}

test('projects 10+ ACP chunks in order without losing final text', async () => {
  const spoken = []
  const segments = []
  let done
  const projector = new CodexStreamProjector({
    speak: async text => {
      spoken.push(text)
      return { completed: true }
    },
    onSegment: segment => segments.push(segment),
    onDone: result => { done = result },
    windowMs: 10_000,
  })
  const chunks = ['第', '一', '句', '。', '第', '二', '句', '！', '最', '后', '。']
  chunks.forEach(chunk => projector.push(identity, chunk))
  const result = await projector.terminal(identity)

  assert.equal(result.text, chunks.join(''))
  assert.equal(spoken.join(''), chunks.join(''))
  assert.deepEqual(segments.map(item => item.sequence), [0, 1, 2])
  assert.equal(done.final_sequence, 2)
})
test('flushes text without punctuation at the bounded time window', async () => {
  let timerCallback
  const spoken = []
  const projector = new CodexStreamProjector({
    speak: async text => {
      spoken.push(text)
      return { completed: true }
    },
    setTimer: callback => { timerCallback = callback; return 1 },
    clearTimer: () => {},
  })
  projector.push(identity, '可以立即开始播放')
  assert.deepEqual(spoken, [])
  timerCallback()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(spoken, ['可以立即开始播放'])
  await projector.terminal(identity)
})

test('waits for all serial speech segments before terminal done', async () => {
  const releases = []
  let completed = false
  const projector = new CodexStreamProjector({
    speak: () => new Promise(resolve => releases.push(resolve)),
    onDone: () => { completed = true },
    windowMs: 10_000,
  })
  projector.push(identity, '一。二。')
  const terminal = projector.terminal(identity)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  releases.shift()({ completed: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  releases.shift()({ completed: true })
  await terminal
  assert.equal(completed, true)
})

test('reports a structured fallback reason while retaining the full answer', async () => {
  let fallback
  const projector = new CodexStreamProjector({
    speak: async () => { throw new Error('provider busy') },
    onFallback: event => { fallback = event },
  })
  projector.push(identity, '完整答案。')
  const result = await projector.terminal(identity)
  assert.equal(result.text, '完整答案。')
  assert.equal(result.streaming_fallback_reason, 'provider busy')
  assert.equal(fallback.streaming_fallback_reason, 'provider busy')
})

test('falls back when the realtime provider resolves a cancelled outcome', async () => {
  const spoken = []
  const projector = new CodexStreamProjector({
    speak: async text => {
      spoken.push(text)
      return spoken.length === 1
        ? { completed: true }
        : { cancelled: true, phase: 'completion' }
    },
    windowMs: 10_000,
  })
  projector.push(identity, '第一句。第二句。第三句。')
  const result = await projector.terminal(identity)
  assert.equal(result.text, '第一句。第二句。第三句。')
  assert.equal(result.streaming_fallback_reason, 'completion')
  assert.deepEqual(spoken, ['第一句。', '第二句。'])
})

test('retains chunks received while speech output is unavailable', async () => {
  const projector = new CodexStreamProjector({
    speak: async () => ({ completed: true }),
  })
  projector.fallback(identity, 'frontend_not_ready', '尚未连接')
  projector.fallback(identity, 'frontend_not_ready', '但答案完整')
  const result = await projector.terminal(identity)
  assert.equal(result.text, '尚未连接但答案完整')
  assert.equal(result.streaming_fallback_reason, 'frontend_not_ready')
})

test('aborts a cancelled task and clears its stream state', async () => {
  let timerCleared = false
  const projector = new CodexStreamProjector({
    speak: async () => ({ completed: true }),
    setTimer: () => 7,
    clearTimer: () => { timerCleared = true },
  })
  projector.push(identity, '未完成片段')
  assert.equal(projector.abort(identity), true)
  assert.equal(timerCleared, true)
  assert.equal(projector.streams.size, 0)
})
