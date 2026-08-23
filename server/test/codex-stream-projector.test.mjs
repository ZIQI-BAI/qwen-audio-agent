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
    speak: async text => spoken.push(text),
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
    speak: async text => spoken.push(text),
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
  releases.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  releases.shift()()
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

