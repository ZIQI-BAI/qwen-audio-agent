import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TASK_STREAM_PROTOCOL_VERSION,
  TaskStreamProtocol,
} from '../src/voice/task-stream-protocol.mjs'

const identity = {
  taskId: 'task-1', requestId: 'request-1', sessionId: 'session-1', generation: 2,
}

function fixture(options = {}) {
  const frames = []
  const logs = []
  let clock = 0
  const protocol = new TaskStreamProtocol({
    send: frame => { frames.push(frame); return true },
    now: () => clock,
    log: {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
    },
    ...options,
  })
  return { protocol, frames, logs, advance: ms => { clock += ms } }
}

test('maps increments to versioned identity-preserving frames with category-local order', () => {
  const { protocol, frames } = fixture()
  protocol.progress(identity, 'started')
  protocol.text(identity, 'first')
  protocol.audio(identity, { bytes: 10 })
  protocol.text(identity, 'second')
  protocol.audio(identity, { bytes: 20 })

  assert.deepEqual(frames.map(({ category, seq }) => [category, seq]), [
    ['progress', 0], ['text', 0], ['audio', 0], ['text', 1], ['audio', 1],
  ])
  for (const frame of frames) {
    assert.equal(frame.protocolVersion, TASK_STREAM_PROTOCOL_VERSION)
    assert.equal(frame.taskId, identity.taskId)
    assert.equal(frame.requestId, identity.requestId)
    assert.equal(frame.sessionId, identity.sessionId)
    assert.equal(frame.generation, identity.generation)
  }
})

test('coalesces duplicate burst progress while valid activity remains a keepalive', () => {
  const { protocol, frames, logs, advance } = fixture()
  assert.equal(protocol.progress(identity, 'working'), true)
  advance(100)
  assert.equal(protocol.progress(identity, 'working'), false)
  assert.equal(protocol.progress(identity, 'reading'), true)
  advance(800)
  assert.equal(protocol.progress(identity, 'reading'), true)

  assert.deepEqual(frames.map(frame => frame.message), ['working', 'reading', 'reading'])
  assert.ok(logs.some(item => item.fields.reason === 'progress_throttled'))
})

test('terminal waits for both task and response barriers', () => {
  const { protocol, frames } = fixture()
  protocol.text(identity, 'answer')
  assert.equal(protocol.taskDone(identity, 'completed'), false)
  assert.equal(frames.some(frame => frame.category === 'terminal'), false)
  assert.equal(protocol.responseDone(identity, { finalAudioSequence: 4 }), true)
  const terminal = frames.at(-1)
  assert.equal(terminal.category, 'terminal')
  assert.equal(terminal.status, 'completed')
  assert.equal(terminal.finalAudioSequence, 4)
})

test('drops stale generation and isolates session streams', () => {
  const { protocol, frames, logs } = fixture()
  protocol.text(identity, 'current')
  protocol.text({ ...identity, generation: 1 }, 'stale')
  protocol.text({ ...identity, sessionId: 'session-2', generation: 1 }, 'other')
  assert.deepEqual(frames.map(frame => frame.delta), ['current', 'other'])
  assert.ok(logs.some(item => item.fields.reason === 'stale_generation'))
})

test('cancel closes its own barrier without affecting foreground or announcement streams', () => {
  const { protocol, frames } = fixture()
  const foreground = { ...identity, taskId: 'foreground', requestId: 'foreground' }
  const announcement = { ...identity, taskId: 'announcement', requestId: 'announcement' }
  protocol.text(foreground, 'work')
  protocol.text(announcement, 'notice')
  protocol.cancel(announcement, 'announcement_interrupted')
  protocol.text(foreground, 'continues')
  assert.deepEqual(
    frames.filter(frame => frame.category === 'text').map(frame => frame.delta),
    ['work', 'notice', 'continues'],
  )
  assert.equal(frames.filter(frame => frame.category === 'terminal').length, 1)
})

test('socket close records disconnect point and rejects later frames', () => {
  const { protocol, frames, logs, advance } = fixture()
  protocol.progress(identity, 'started')
  advance(2_400)
  protocol.close()
  protocol.text(identity, 'lost')
  assert.equal(frames.length, 1)
  assert.ok(logs.some(item => (
    item.fields.reason === 'socket_closed' && item.fields.disconnectAtMs === 2_400
  )))
})

test('simulated 24s Codex task sends immediate status, incremental content and complete terminal', () => {
  const { protocol, frames, advance } = fixture()
  protocol.progress(identity, 'accepted')
  advance(4_000)
  for (const chunk of ['一', '个', '完整', '答案']) {
    protocol.text(identity, chunk)
    advance(5_000)
  }
  protocol.taskDone(identity, 'completed')
  protocol.responseDone(identity, { answer: '一个完整答案' })

  assert.equal(frames[0].category, 'progress')
  assert.equal(frames[0].seq, 0)
  assert.equal(frames.filter(frame => frame.category === 'text').map(frame => frame.delta).join(''), '一个完整答案')
  assert.equal(frames.at(-1).category, 'terminal')
  assert.equal(frames.at(-1).answer, '一个完整答案')
  assert.equal(frames.at(-1).metrics.totalMs, 24_000)
})
