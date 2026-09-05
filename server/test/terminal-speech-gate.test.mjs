// Unit contract for the two pieces that make a task answer's delivery
// deterministic: the gate that withholds an unverified utterance, and the
// synthesizer that produces the answer when no reading will (ESS-1165).

import assert from 'node:assert/strict'
import test from 'node:test'

import { TerminalSpeechGate } from '../src/voice/terminal-speech-gate.mjs'
import { isVerbatimSpeech } from '../src/voice/terminal-speech-fidelity.mjs'
import {
  DeterministicSpeech,
  decodeWav,
  pcmFrames,
} from '../src/voice/deterministic-speech.mjs'

const IDENTITY = { sessionId: 's', taskId: 'work_1', generation: 1 }

function collector() {
  const sent = []
  return { sent, send: frame => sent.push(frame) }
}

function wav({
  channels = 1, bits = 16, rate = 24000, format = 1, samples = 8,
} = {}) {
  const pcm = Buffer.alloc(samples * 2, 7)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(format, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function ttsFetch(buffer, { status = 200 } = {}) {
  return async () => ({
    ok: status === 200,
    status,
    json: async () => ({ output: { audio: { data: buffer.toString('base64') } } }),
  })
}

test('a verified utterance is released in arrival order', () => {
  const { sent, send } = collector()
  const gate = new TerminalSpeechGate({ send })
  gate.open('resp_1', { expected: '最终答案。', identity: IDENTITY })

  assert.equal(gate.hold('resp_1', { type: 'audio.delta', seq: 0 }), true)
  assert.equal(gate.hold('resp_1', { type: 'audio.delta', seq: 1 }), true)
  assert.equal(gate.hold('resp_1', { type: 'audio.done' }), true)
  assert.deepEqual(sent, [], 'nothing leaves before the verdict')

  assert.equal(gate.settle('resp_1', { spoken: '最终答案。' }), true)
  assert.equal(gate.release('resp_1'), 3)
  assert.deepEqual(sent.map(frame => frame.type), [
    'audio.delta', 'audio.delta', 'audio.done',
  ])
  assert.equal(sent[0].seq, 0)
  assert.equal(sent[1].seq, 1)
})

test('a rewritten utterance is dropped whole, so nothing was ever heard', () => {
  const { sent, send } = collector()
  const warnings = []
  const gate = new TerminalSpeechGate({
    send, log: { warn: (event, detail) => warnings.push({ event, detail }) },
  })
  gate.open('resp_1', { expected: '最终答案。', identity: IDENTITY })
  gate.hold('resp_1', { type: 'audio.delta' })
  gate.hold('resp_1', { type: 'audio.done' })

  assert.equal(gate.settle('resp_1', { spoken: '正在查找，请稍候。' }), false)
  assert.deepEqual(
    gate.divergence('resp_1'),
    { expected: '最终答案。', spoken: '正在查找，请稍候。' },
  )
  assert.equal(gate.discard('resp_1'), 2)
  assert.deepEqual(sent, [], 'the client never saw a frame of it')
  assert.equal(warnings[0].event, 'task.stream.speech_discarded')
  assert.equal(warnings[0].detail.taskId, 'work_1')

  // A discarded response is no longer gated, so a retry starts clean.
  assert.equal(gate.isOpen('resp_1'), false)
  assert.equal(gate.hold('resp_1', { type: 'audio.delta' }), false)
})

test('frames for an ungated response pass straight through', () => {
  const { sent, send } = collector()
  const gate = new TerminalSpeechGate({ send })
  assert.equal(gate.hold('resp_other', { type: 'audio.delta' }), false)
  assert.equal(gate.verdict('resp_other'), null)
  assert.deepEqual(sent, [])
})

test('closing the gate drops everything still awaiting a verdict', () => {
  const { sent, send } = collector()
  const gate = new TerminalSpeechGate({ send })
  gate.open('resp_1', { expected: '答案', identity: IDENTITY })
  gate.hold('resp_1', { type: 'audio.delta' })
  gate.close()
  assert.deepEqual(sent, [], 'a socket that went away flushes nothing')
  assert.equal(gate.isOpen('resp_1'), false)
})

test('WAV decoding yields the PCM payload and its format', () => {
  const decoded = decodeWav(wav({ samples: 4 }))
  assert.equal(decoded.channels, 1)
  assert.equal(decoded.bitsPerSample, 16)
  assert.equal(decoded.sampleRate, 24000)
  assert.equal(decoded.pcm.length, 8)
  assert.throws(() => decodeWav(Buffer.from('not audio at all')), /WAVE/)
})

test('synthesis rejects a container the downlink cannot carry', async () => {
  const speech = new DeterministicSpeech({
    apiKey: 'k', baseUrl: 'http://tts.invalid', model: 'qwen-tts',
    fetchImpl: ttsFetch(wav({ channels: 2 })),
  })
  await assert.rejects(() => speech.synthesize('答案'), /格式不符/)

  const wrongRate = new DeterministicSpeech({
    apiKey: 'k', baseUrl: 'http://tts.invalid', model: 'qwen-tts',
    sampleRate: 24000,
    fetchImpl: ttsFetch(wav({ rate: 16000 })),
  })
  await assert.rejects(() => wrongRate.synthesize('答案'), /采样率不符/)
})

test('synthesis reports a refusing endpoint instead of returning silence', async () => {
  const speech = new DeterministicSpeech({
    apiKey: 'k', baseUrl: 'http://tts.invalid', model: 'qwen-tts',
    fetchImpl: ttsFetch(wav(), { status: 503 }),
  })
  await assert.rejects(() => speech.synthesize('答案'), /HTTP 503/)

  const unconfigured = new DeterministicSpeech({ apiKey: '', model: '' })
  assert.equal(unconfigured.available, false)
  await assert.rejects(() => unconfigured.synthesize('答案'), /未配置/)
})

test('PCM is framed on whole samples', () => {
  const pcm = Buffer.alloc(10, 1)
  const frames = pcmFrames(pcm, { frameBytes: 5 })
  assert.equal(frames.length, 3, '5 rounds down to 4 bytes per frame')
  const joined = Buffer.concat(frames.map(frame => Buffer.from(frame, 'base64')))
  assert.deepEqual(joined, pcm, 'framing loses nothing')
})

// The gate releases whatever `isVerbatimSpeech` accepts, so the comparison is
// the last thing standing between a wrong number and the user's ear.
// Normalisation has to forgive punctuation — a transcript renders it
// inconsistently — but forgiving it next to a digit changes the value: `10+2=12`
// and `10212` are not the same answer, and neither are `-3°C` and `3°C`.
test('a symbol that carries a number is never normalised away', () => {
  const different = [
    ['温度范围 -3～5°C', '温度范围 35°C', 'a range collapsed into one number'],
    ['10+2=12', '10212', 'an expression collapsed into digits'],
    ['今晚最低 -3°C', '今晚最低 3°C', 'a dropped minus sign flips the value'],
    ['三点零五分是 3:05', '三点零五分是 305', 'a dropped colon is a different time'],
    ['误差 0.5 米', '误差 05 米', 'a dropped decimal point is a different length'],
    ['涨了 50%', '涨了 50', 'a dropped percent sign is a different quantity'],
    ['3-5 天', '35 天', 'a range read as one number'],
  ]
  for (const [expected, spoken, why] of different) {
    assert.equal(
      isVerbatimSpeech(expected, spoken), false,
      `${why}: ${expected} / ${spoken}`,
    )
  }
})

test('punctuation a listener cannot hear is still forgiven', () => {
  const same = [
    ['杭州二十五摄氏度，多云。', '杭州二十五摄氏度 多云'],
    ['— Jackson\'Avatar', '- Jackson’Avatar'],
    ['新版 Responses API', '新版 responses api'],
    ['结果 — 完成', '结果 完成'],
  ]
  for (const [expected, spoken] of same) {
    assert.equal(isVerbatimSpeech(expected, spoken), true, `${expected} / ${spoken}`)
  }
})
