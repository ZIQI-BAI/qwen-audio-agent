// ESS-1165 regression: a delegated task's final answer must reach the ear
// as the answer, exactly once.
//
// ESS-1157 redeployed the ESS-1156 fix and re-ran the real
// `text.message -> qwen-audio-agent -> Codex -> WSS -> ffplay` chain. Notification
// ownership was fixed — one claim, one delivery — and both delegated cases
// still failed, because ownership says nothing about what the model actually
// says:
//
//   weather   session ess990-capture-bb94afee
//             task work_f10290f9-173e-47c1-bb79-8be99c43f8bd
//             segment 0 read verbatim, segment 1 reworked into a second
//             complete answer -> answer heard 2x
//   knowledge session ess990-capture-944cca5a
//             task work_906bcf82-fc5a-4482-8285-7e068c640e3b
//             all 4 segments replaced by "已经开始处理 / 正在查找，请稍候"
//             -> answer heard 0x
//
// A probe against the real DashScope model (qwen-audio-3.0-realtime-plus,
// see ess1165-dashscope-verbatim.e2e.test.mjs) reproduced this directly: the
// old speak response reads 0/4 knowledge segments verbatim. Its `conversation:
// 'none'` marks the response out-of-band but does not remove its input, so the
// model still sees the whole conversation and answers the user's question from
// it — including "抱歉，我没法直接访问您个人的 Obsidian 知识库".
//
// The fix has three parts, and this file covers all of them:
//   1. the answer is read, not re-authored: one utterance, empty input,
//      reader instructions;
//   2. the reading is held back until it has been checked against the text it
//      was handed, so a rewritten utterance is dropped before the client sees
//      a single audio frame — verifying afterwards would only label a delivery
//      that already happened, which is what the ESS-1165 review rejected;
//   3. recovery is deterministic: the discarded attempt is retried, then
//      synthesized, then delivered as text. No path narrates the answer in the
//      model's own words, and only audio that actually went out can mark the
//      task notification delivered (ESS-1168).
//
// Frame ordering follows ESS-1110 and the ESS-1168 ruling: the lifecycle
// terminal stays behind the response/audio drain barrier, and
// `task.stream.done` is the last frame of the task stream.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'

process.env.QWAUDIO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'qwaudio-ess1165-'))
process.env.QWEN_AUDIO_AGENT_AUTH_SECRET = 'test-secret-that-is-long-enough-1234567890'
process.env.DASHSCOPE_API_KEY = 'sk-fake'

const { attachRealtimeGateway } = await import('../src/voice/realtime-gateway.mjs')
const { IdentityManager } = await import('../src/core/identity.mjs')
const { taskManager } = await import('../src/task/task-manager.mjs')
const { createRealtimeProviderRegistry } = await import(
  '../src/voice/providers/provider-registry.mjs'
)
const { openAiCompatibleProtocol } = await import(
  '../src/voice/providers/openai-compatible-protocol.mjs'
)
const { dashscopeProvider } = await import('../src/voice/providers/dashscope.mjs')
const {
  isVerbatimSpeech,
  normalizeSpokenText,
} = await import('../src/voice/terminal-speech-fidelity.mjs')
const {
  VERBATIM_SPEECH_CLOSE_TAG,
  VERBATIM_SPEECH_OPEN_TAG,
} = await import('../src/voice/frontend-tools.mjs')
const { config } = await import('../src/core/config.mjs')

/**
 * Minimal stand-in for the DashScope TTS endpoint: it answers with a real
 * mono/16-bit/24 kHz WAV, so the gateway exercises its actual HTTP + container
 * decoding path rather than a stubbed buffer.
 */
function wavOf(samples) {
  const pcm = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(index / 8) * 8000), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24)
  header.writeUInt32LE(24000 * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function startTtsStub() {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      requests.push(payload.input?.text || '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        output: { audio: { data: wavOf(4800).toString('base64') } },
      }))
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      requests,
      url: `http://127.0.0.1:${server.address().port}/tts`,
      close: () => new Promise(done => server.close(done)),
    }))
  })
}

// Verbatim from the `task.completed` frames of the ESS-1157 JSONL captures.
const WEATHER_ANSWER = '杭州现在大约二十五摄氏度，晴到多云，湿度约百分之八十，'
  + '北风二级左右，空气质量优。凌晨气温变化不大，体感偏潮湿。— Jackson\'Avatar'
const KNOWLEDGE_ANSWER = '知识库中最新收录的是九月四日的《今起 Codex 每天重置一次》。'
  + '核心观点是：Codex 据称将提供每日额度重置，但适用范围和规则尚无官方确认；'
  + '新版 Responses API 更适合长程智能体任务，支持异步调用、任务转向和推理强度调整；'
  + '模型升级后可以精简冗余的 AGENTS.md 指令，但身份、安全和授权边界必须保留。'
  + '总体而言，它更适合作为产品动态线索，关于 GPT-6 Astra、二十七万二千 token '
  + '和评测成绩的说法仍需官方核验。目前知识库没有记录你本人对它的明确观点。'
  + '— Jackson\'Avatar'

// What the real model said instead, from the same captures.
const WEATHER_REWRITE = '杭州现在天气不错哦！气温大概25摄氏度，晴到多云，湿度有点高，'
  + '约80%，感觉会有点潮湿。北风二级左右，吹起来挺舒服的。空气质量是优，适合出门活动呢！'
const KNOWLEDGE_REWRITE = '正在为您查找 Obsidian 知识库中的最新文章并总结其观点，请您稍候。'

const AUDIO_FRAME = Buffer.alloc(960).toString('base64')

function verbatimContent(instructions) {
  const text = String(instructions || '')
  // The instructions name the delimiters in prose before using them, so the
  // material is what the LAST pair encloses.
  const open = text.lastIndexOf(VERBATIM_SPEECH_OPEN_TAG)
  const close = text.lastIndexOf(VERBATIM_SPEECH_CLOSE_TAG)
  if (open < 0 || close < 0) return null
  return text.slice(open + VERBATIM_SPEECH_OPEN_TAG.length, close).trim()
}

/**
 * Scripted realtime upstream reproducing what ESS-1157 recorded.
 *
 * `rewrite` is the utterance the real model produced instead of reading the
 * text. It is used for every response that is NOT an isolated verbatim request
 * — which is exactly the shape the old code sent. A response that both carries
 * the reader instructions and has its conversation input removed is read back
 * verbatim, as the real model does.
 */
function startRealtimeUpstream({ rewrite, rewriteAttempts = 0, silent = false }) {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const responses = []
  wss.on('connection', ws => {
    let sequence = 0
    let verbatimRequests = 0
    ws.send(JSON.stringify({ type: 'session.created', session: { id: 'sess' } }))
    ws.on('message', raw => {
      let event
      try {
        event = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (event.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.updated', session: event.session }))
        return
      }
      if (event.type === 'conversation.item.create') {
        ws.send(JSON.stringify({
          type: 'conversation.item.created',
          item: { id: event.item?.id },
        }))
        return
      }
      if (event.type !== 'response.create') return
      const id = `resp_fake_${++sequence}`
      const response = event.response || {}
      const asked = verbatimContent(response.instructions)
      const isolated = Array.isArray(response.input) && response.input.length === 0
      // `rewriteAttempts` reproduces a model that refuses to read for the first
      // N requests: Infinity is the ESS-1157 knowledge case, 1 is a model that
      // complies on the retry.
      const refuses = asked && isolated
        ? ++verbatimRequests <= rewriteAttempts
        : true
      const spoken = refuses ? rewrite : asked
      responses.push({ id, response, asked, isolated, spoken })
      ws.send(JSON.stringify({ type: 'response.created', response: { id } }))
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (!silent) {
          ws.send(JSON.stringify({
            type: 'response.audio.delta', response_id: id, delta: AUDIO_FRAME,
          }))
        }
        ws.send(JSON.stringify({
          type: 'response.audio_transcript.done',
          response_id: id,
          transcript: spoken,
        }))
        ws.send(JSON.stringify({
          type: 'response.done',
          response: { id, status: 'completed' },
        }))
      }, 40)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        responses,
        url: `ws://127.0.0.1:${server.address().port}/realtime`,
        close: () => new Promise(done => {
          for (const client of wss.clients) client.terminate()
          server.close(done)
        }),
      })
    })
  })
}

/**
 * The scripted provider mirrors the real DashScope response shapes, including
 * the verbatim contract under test.
 */
function scriptedProvider(url) {
  return {
    key: 'ess1165-scripted',
    label: 'ESS-1165 Scripted Realtime',
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    protocol: openAiCompatibleProtocol,
    capabilities: { perResponseInstructions: true, conversationItemIdEcho: true },
    visibility: 'gateway-only',
    model: () => 'scripted-realtime',
    voice: () => 'test',
    isConfigured: () => true,
    missingConfigurationMessage: 'scripted provider is always configured',
    connectTimeoutMessage: 'scripted provider connect timeout',
    url: () => url,
    headers: () => ({}),
    classifyError: () => 'other',
    modelProfile: () => ({
      id: 'scripted-realtime',
      label: 'scripted',
      family: 'scripted',
      modelCapabilities: {
        textInput: true, audioInput: true, imageInput: false, videoInput: false,
        textOutput: true, audioOutput: true, functionCalling: false,
      },
      transportCapabilities: {
        textInput: true, audioInput: false, imageInput: false,
        observationInput: false, nativeVideoInput: false,
      },
      sessionDefaults: { voice: 'test', turnDetection: null },
    }),
    buildSession: () => ({ instructions: 'scripted' }),
    buildSpeakResponse: dashscopeProvider.buildSpeakResponse,
    buildVerbatimSpeechResponse: dashscopeProvider.buildVerbatimSpeechResponse,
    buildResultInjection: dashscopeProvider.buildResultInjection,
    buildPermissionInjection: dashscopeProvider.buildPermissionInjection,
  }
}

async function startGateway(url) {
  const server = createServer()
  const provider = scriptedProvider(url)
  attachRealtimeGateway(server, {
    identityManager: new IdentityManager({
      secret: process.env.QWEN_AUDIO_AGENT_AUTH_SECRET,
      mode: 'personal',
    }),
    memoryService: {
      list: () => [],
      remember: async () => ({ id: 'mem_1' }),
      replace: async () => ({}),
      forget: async () => ({}),
    },
    notesStore: {
      lists: () => [],
      show: () => ({ name: '', items: [] }),
      add: async () => ({}),
      remove: async () => ({}),
      clear: async () => ({}),
      drop: async () => ({}),
    },
    coordinator: null,
    backendAvailability: {
      snapshot: () => ({ configured: true, ok: true, known: true }),
    },
    respondPermission: async () => ({}),
    permissionPolicy: { resolveDecision: () => null, rememberDecision: () => {} },
    realtimeProviderRegistry: createRealtimeProviderRegistry({
      providers: [provider],
      defaultProvider: provider.key,
    }),
    defaultRealtimeProvider: provider.key,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

function connectClient(server, sessionId) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime?sessionId=${sessionId}`,
  )
  const frames = []
  const started = new Set()
  socket.on('message', raw => {
    let event
    try {
      event = JSON.parse(raw.toString())
    } catch {
      return
    }
    frames.push(event)
    if (event.type === 'audio.delta' && event.responseId) {
      if (!started.has(event.responseId)) {
        started.add(event.responseId)
        socket.send(JSON.stringify({
          type: 'playback.started', responseId: event.responseId,
        }))
      }
      return
    }
    if (event.type === 'audio.done' && started.has(event.responseId)) {
      socket.send(JSON.stringify({
        type: 'playback.ended', responseId: event.responseId,
      }))
    }
  })
  return new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'connect',
        timeZone: 'Asia/Shanghai',
        locale: 'zh-CN',
        voiceEnabled: true,
        inputEnabled: false,
        outputEnabled: true,
        clientType: 'web',
        clientLabel: 'ess1165',
        clientInstanceId: `ess1165-${sessionId}`,
      }))
      resolve({ socket, frames })
    })
  })
}

function waitFor(frames, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      const hit = frames.find(predicate)
      if (hit) return resolve(hit)
      if (Date.now() > deadline) {
        return reject(new Error(
          `frame never arrived; saw ${
            [...new Set(frames.map(item => item.type))].join(', ')
          }`,
        ))
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

async function runDelegatedTurn({
  answerText, rewrite, sessionId, rewriteAttempts = 0, silent = false,
  terminalFrameType = 'task.stream.done',
}) {
  const upstream = await startRealtimeUpstream({ rewrite, rewriteAttempts, silent })
  const server = await startGateway(upstream.url)
  const { socket, frames } = await connectClient(server, sessionId)
  await waitFor(frames, frame => frame.type === 'voice.ready')

  const turnId = `text_${sessionId}`
  const created = taskManager.create({
    objective: '回答用户的问题',
    ownerId: 'user_personal',
    sessionId,
    turnId,
    runner: async () => ({
      content: answerText,
      metadata: { presentation: { speech: answerText } },
    }),
  })

  const done = await waitFor(
    frames,
    frame => frame.type === terminalFrameType && frame.taskId === created.id,
  )
  // Nothing may follow the terminal frame, so give a late duplicate a window.
  await new Promise(resolve => setTimeout(resolve, 500))

  socket.close()
  await new Promise(resolve => server.close(resolve))
  await upstream.close()

  return {
    taskId: created.id,
    turnId,
    frames,
    done,
    upstream,
    // What the task ledger believes about its own notification, which is the
    // question "was the answer delivered?" in its authoritative form.
    notificationStatus: taskManager.get(created.id)?.notificationStatus ?? null,
  }
}

/** Did the Gateway tell the client this task's notification was delivered? */
function notificationDelivered(frames, taskId) {
  return frames.some(frame => (
    frame.type === 'task.notification.delivered' && frame.task?.id === taskId
  ))
}

function assistantTranscriptsFor(frames, taskId) {
  return frames
    .filter(frame => (
      frame.type === 'transcript.final'
      && frame.role === 'assistant'
      && frame.taskId === taskId
    ))
    .map(frame => frame.content)
}

test('the weather answer the real model reworded is now read verbatim, once', async () => {
  const { taskId, frames, done, upstream } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    rewrite: WEATHER_REWRITE,
    sessionId: 'ess1165-weather',
  })

  const spoken = assistantTranscriptsFor(frames, taskId)
  assert.deepEqual(
    spoken, [WEATHER_ANSWER],
    `the answer must be heard once, verbatim; heard ${spoken.length} utterances`,
  )
  assert.equal(
    frames.filter(frame => (
      frame.type === 'audio.done' && frames.some(item => (
        item.type === 'transcript.final'
        && item.responseId === frame.responseId
        && item.taskId === taskId
      ))
    )).length,
    1,
    'the answer produced exactly one audio.done',
  )
  assert.equal(done.verbatim, true, 'task.stream.done reports a verbatim delivery')
  assert.equal(
    frames.filter(frame => frame.type === 'task.stream.fallback').length, 0,
  )

  const answerResponses = upstream.responses.filter(item => item.asked)
  assert.equal(answerResponses.length, 1, 'the answer is one realtime response')
  assert.equal(answerResponses[0].asked, WEATHER_ANSWER)
  assert.ok(
    answerResponses[0].isolated,
    'the answer response carries no conversation input, so the model cannot '
    + 're-answer the user question from it',
  )
  assert.equal(answerResponses[0].response.tool_choice, 'none')
})

test('the knowledge answer the real model dropped entirely is now read verbatim', async () => {
  const { taskId, frames, done } = await runDelegatedTurn({
    answerText: KNOWLEDGE_ANSWER,
    rewrite: KNOWLEDGE_REWRITE,
    sessionId: 'ess1165-knowledge',
  })

  const spoken = assistantTranscriptsFor(frames, taskId)
  assert.deepEqual(
    spoken, [KNOWLEDGE_ANSWER],
    `the answer must be heard once, verbatim; heard ${spoken.length} utterances`,
  )
  assert.ok(
    !spoken.some(text => text.includes('请您稍候')),
    'progress speech never replaces the answer',
  )
  assert.equal(done.verbatim, true)
})

test('a rewritten utterance never reaches the client, and the retry does', async () => {
  const {
    taskId, frames, done, upstream, notificationStatus,
  } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    rewrite: WEATHER_REWRITE,
    sessionId: 'ess1165-retry',
    // The model rewrites once, then complies — the ESS-1157 weather shape.
    rewriteAttempts: 1,
  })

  assert.equal(
    upstream.responses.filter(item => item.asked).length, 2,
    'the discarded reading was re-requested',
  )
  const spoken = assistantTranscriptsFor(frames, taskId)
  assert.deepEqual(
    spoken, [WEATHER_ANSWER],
    'the answer is heard once; the rewrite is not heard at all',
  )
  assert.ok(
    !frames.some(frame => (
      frame.type === 'transcript.final' && frame.content === WEATHER_REWRITE
    )),
    'the rewritten transcript never left the gateway',
  )
  const audioResponseIds = new Set(
    frames.filter(frame => frame.type === 'audio.delta').map(frame => frame.responseId),
  )
  assert.equal(audioResponseIds.size, 1, 'only one utterance produced audio')
  assert.equal(done.verbatim, true)
  assert.equal(done.delivery, 'verbatim')
  assert.equal(notificationStatus, 'delivered', 'the answer was heard, so it is delivered')
  assert.equal(notificationDelivered(frames, taskId), true)
})

test('an answer the model will not read is synthesized, not narrated', async () => {
  const tts = await startTtsStub()
  const previous = config.deterministicTtsBaseUrl
  config.deterministicTtsBaseUrl = tts.url
  try {
    const { taskId, frames, done, notificationStatus } = await runDelegatedTurn({
      answerText: WEATHER_ANSWER,
      rewrite: WEATHER_REWRITE,
      sessionId: 'ess1165-synth',
      // Never complies — the ESS-1157 knowledge case.
      rewriteAttempts: Number.POSITIVE_INFINITY,
    })

    assert.deepEqual(tts.requests, [WEATHER_ANSWER], 'the exact answer was synthesized')
    const spoken = assistantTranscriptsFor(frames, taskId)
    assert.deepEqual(
      spoken, [WEATHER_ANSWER],
      'the listener gets the answer, and gets it once',
    )
    assert.ok(
      !frames.some(frame => (
        frame.type === 'transcript.final' && frame.content === WEATHER_REWRITE
      )),
      'no attempt at rewriting was ever delivered',
    )
    const audio = frames.filter(frame => frame.type === 'audio.delta')
    assert.ok(audio.length > 0, 'synthesized audio reached the client')
    assert.equal(
      new Set(audio.map(frame => frame.responseId)).size, 1,
      'exactly one utterance carried audio',
    )
    assert.equal(audio[0].sampleRate, 24000)
    assert.equal(done.delivery, 'synthesized')
    assert.equal(done.verbatim, true, 'the delivered content is the answer')
    assert.equal(notificationStatus, 'delivered')
  } finally {
    config.deterministicTtsBaseUrl = previous
    await tts.close()
  }
})

test('with no synthesis the answer degrades to text and stays undelivered', async () => {
  const previous = config.deterministicTtsModel
  config.deterministicTtsModel = ''
  try {
    const { taskId, frames, notificationStatus } = await runDelegatedTurn({
      answerText: KNOWLEDGE_ANSWER,
      rewrite: KNOWLEDGE_REWRITE,
      sessionId: 'ess1165-textonly',
      rewriteAttempts: Number.POSITIVE_INFINITY,
      terminalFrameType: 'task.stream.fallback',
    })

    const spoken = assistantTranscriptsFor(frames, taskId)
    assert.deepEqual(
      spoken, [KNOWLEDGE_ANSWER],
      'the authoritative answer is still delivered, as text',
    )
    assert.ok(
      !frames.some(frame => (
        frame.type === 'transcript.final' && frame.content === KNOWLEDGE_REWRITE
      )),
      'the progress boilerplate the model produced was never delivered',
    )
    assert.equal(
      frames.filter(frame => frame.type === 'audio.delta').length, 0,
      'nothing was played, because nothing could be played faithfully',
    )
    const fallback = frames.find(frame => frame.type === 'task.stream.fallback')
    assert.equal(fallback.streaming_fallback_reason, 'speech_not_verbatim')
    // The claim is released rather than consumed: nothing was heard, so the
    // notification must not be spent — and it is not re-announced either,
    // because announcing it means narrating the answer in the model's own
    // words (ESS-1168 blocking item 1).
    assert.notEqual(notificationStatus, 'delivered')
    assert.equal(notificationDelivered(frames, taskId), false)
  } finally {
    config.deterministicTtsModel = previous
  }
})

test('a transcript with no audio is not a delivery', async () => {
  const previous = config.deterministicTtsModel
  config.deterministicTtsModel = ''
  try {
    const { taskId, frames, done, notificationStatus } = await runDelegatedTurn({
      answerText: WEATHER_ANSWER,
      rewrite: WEATHER_REWRITE,
      sessionId: 'ess1165-silent',
      // The model reads the answer back, but the provider emits no audio.
      silent: true,
    })

    assert.deepEqual(
      assistantTranscriptsFor(frames, taskId), [WEATHER_ANSWER],
      'the text still reaches the client',
    )
    assert.equal(
      frames.filter(frame => frame.type === 'audio.delta').length, 0,
      'nothing was audible',
    )
    assert.equal(done.delivery, null, 'a silent response is not a spoken delivery')
    assert.equal(done.verbatim, null)
    assert.notEqual(
      notificationStatus, 'delivered',
      'an answer nobody could hear must not spend the notification',
    )
  } finally {
    config.deterministicTtsModel = previous
  }
})

test('the lifecycle terminal stays behind the drain barrier (ESS-1110)', async () => {
  const { taskId, frames } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    rewrite: WEATHER_REWRITE,
    sessionId: 'ess1165-order',
  })

  const answerResponseId = frames.find(frame => (
    frame.type === 'transcript.final'
    && frame.role === 'assistant'
    && frame.taskId === taskId
  )).responseId
  const indexOf = predicate => frames.findIndex(predicate)
  const terminal = indexOf(frame => (
    frame.type === 'task.stream'
    && frame.category === 'terminal'
    && frame.taskId === taskId
  ))
  const streamDone = indexOf(frame => (
    frame.type === 'task.stream.done' && frame.taskId === taskId
  ))
  const audioDones = frames.filter(frame => (
    frame.type === 'audio.done' && frame.responseId === answerResponseId
  ))
  const lastAudioDone = frames.lastIndexOf(audioDones.at(-1))

  assert.equal(audioDones.length, 1, 'the answer has exactly one audio.done')
  // ESS-1168 ruled that ESS-1110's order stands: the terminal follows the
  // response/audio drain rather than preceding the answer's audio.done.
  assert.ok(
    lastAudioDone < terminal && terminal < streamDone,
    'audio drain -> lifecycle terminal -> task.stream.done',
  )
  const taskStreamFrames = frames.filter(frame => (
    frame.type.startsWith('task.stream') && (frame.taskId === taskId)
  ))
  assert.equal(
    taskStreamFrames.at(-1).type, 'task.stream.done',
    'task.stream.done is the last frame of the task stream',
  )
})

test('fidelity ignores what a listener cannot hear', () => {
  assert.equal(isVerbatimSpeech('晴到多云，湿度约百分之八十。', '晴到多云 湿度约百分之八十'), true)
  assert.equal(isVerbatimSpeech('空气质量优。', '空气质量优！'), true)
  assert.equal(
    isVerbatimSpeech('杭州现在大约二十五摄氏度。', '气温大概25摄氏度'), false,
    'a reworded answer is not verbatim, even though it means the same thing',
  )
  assert.equal(isVerbatimSpeech('最终答案。', '正在查找，请稍候。'), false)
  // An empty expectation cannot be violated: nothing was asked for.
  assert.equal(isVerbatimSpeech('', '任何内容'), true)
  assert.equal(
    normalizeSpokenText(`${VERBATIM_SPEECH_OPEN_TAG}答案${VERBATIM_SPEECH_CLOSE_TAG}`),
    '答案',
    'a model that reads the delimiters out is still judged on the content',
  )
})
