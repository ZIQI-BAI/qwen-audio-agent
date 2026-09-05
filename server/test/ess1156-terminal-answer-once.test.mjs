// ESS-1156 regression: a delegated task's terminal answer must reach the ear
// exactly once.
//
// ESS-1147 drove the real `text.message -> qwen-audio-agent -> Codex -> WSS`
// chain and captured every downlink frame. Both delegated cases failed:
//
//   weather   turn text_06df95864ae64d13b873b89509a3bd17
//             task work_7f801e19-fbdf-47e1-adaa-d54d2003739f
//             2 task.stream.segment frames, 3 responses, answer heard 2x
//   knowledge turn text_3b9a73ddb0d444b88e60b2ad0aa8d220
//             task work_8701a64e-1cbf-4e19-b763-0d6352023cd2
//             4 task.stream.segment frames, 5 responses, answer heard 4x
//
// The extra response in both captures is the announcement surface: TaskManager
// emits `task.completed` and `task.notification.pending` in the same tick, and
// the streamed projection used to claim the notification only after every
// segment had drained. The announcement therefore claimed the same task,
// injected the whole result as a conversation item and spoke it — and from
// that injection on, every remaining projector segment made the model re-speak
// the whole answer instead of the segment. That is what turned one duplicate
// into 2x (weather, 2 segments) and 4x (knowledge, 4 segments).
//
// This test drives the real gateway over a real WebSocket against a scripted
// realtime upstream, replaying both captured results, and asserts the answer
// is spoken exactly once.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'

process.env.QWAUDIO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'qwaudio-ess1156-'))
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
const { TaskTerminalDelivery } = await import(
  '../src/voice/task-terminal-delivery.mjs'
)
const { CodexStreamProjector } = await import(
  '../src/voice/codex-stream-projector.mjs'
)

// The two results ESS-1147 captured, verbatim from the `task.completed` frames
// of the attached JSONL. Segment counts below (2 and 4) are what the real
// CodexStreamProjector produces for them.
const WEATHER_ANSWER = '杭州现在大约二十六摄氏度，多云，湿度约百分之八十四，北风二级，'
  + '空气质量优。夜间气温会逐步降到二十五度左右。— Jackson\'Avatar'
const KNOWLEDGE_ANSWER = '知识库中最新收录的是九月四日的《今起 Codex 每天重置一次》。'
  + '核心观点是：Codex 据称将提供每日额度重置，但适用范围和规则尚无官方确认；'
  + '新版 Responses API 更适合长程智能体任务，支持异步调用、任务转向和推理强度调整；'
  + '模型升级后可以精简冗余的 AGENTS.md 指令，但身份、安全和授权边界必须保留。'
  + '总体而言，它更适合作为产品动态线索，关于 GPT-6 Astra、二十七万二千 token '
  + '和评测成绩的说法仍需官方核验。目前知识库没有记录你本人对它的明确观点。'
  + '— Jackson\'Avatar'

const SPEAK_INSTRUCTION_PREFIX = '请以自然口语传达下面的信息'
const AUDIO_FRAME = Buffer.alloc(960).toString('base64')

/**
 * Scripted realtime upstream. It answers the OpenAI-compatible handshake and,
 * for every `response.create`, speaks one utterance back.
 *
 * The model behaviour that ESS-1147 recorded is reproduced faithfully: a
 * `speak` response reads its own content verbatim, but once a result has been
 * injected into the conversation (what AnnouncementManager does), the model
 * answers from that injected result instead — so every later segment repeats
 * the whole answer.
 */
function startRealtimeUpstream({ answerText, responseDelayMs = 40 }) {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const responses = []
  wss.on('connection', ws => {
    let resultInjected = false
    let sequence = 0
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
        const text = (event.item?.content || [])
          .map(part => part.text || '')
          .join('')
        if (text.includes(answerText)) resultInjected = true
        ws.send(JSON.stringify({
          type: 'conversation.item.created',
          item: { id: event.item?.id },
        }))
        return
      }
      if (event.type !== 'response.create') return
      const id = `resp_fake_${++sequence}`
      const instructions = String(event.response?.instructions || '')
      const speakContent = instructions.startsWith(SPEAK_INSTRUCTION_PREFIX)
        ? instructions.slice(instructions.indexOf('\n') + 1)
        : ''
      const spoken = resultInjected ? answerText : speakContent
      responses.push({ id, instructions, spoken, resultInjected })
      ws.send(JSON.stringify({ type: 'response.created', response: { id } }))
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (spoken) {
          ws.send(JSON.stringify({
            type: 'response.audio.delta', response_id: id, delta: AUDIO_FRAME,
          }))
          ws.send(JSON.stringify({
            type: 'response.audio_transcript.done',
            response_id: id,
            transcript: spoken,
          }))
        }
        ws.send(JSON.stringify({
          type: 'response.done',
          response: { id, status: 'completed' },
        }))
      }, responseDelayMs)
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

function scriptedProvider(url) {
  return {
    key: 'ess1156-scripted',
    label: 'ESS-1156 Scripted Realtime',
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    protocol: openAiCompatibleProtocol,
    capabilities: {
      perResponseInstructions: true,
      conversationItemIdEcho: true,
    },
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
        textInput: true,
        audioInput: true,
        imageInput: false,
        videoInput: false,
        textOutput: true,
        audioOutput: true,
        functionCalling: false,
      },
      transportCapabilities: {
        textInput: true,
        audioInput: false,
        imageInput: false,
        observationInput: false,
        nativeVideoInput: false,
      },
      sessionDefaults: { voice: 'test', turnDetection: null },
    }),
    buildSession: () => ({ instructions: 'scripted' }),
    buildSpeakResponse: content => ({
      conversation: 'none',
      modalities: ['text', 'audio'],
      instructions: `${SPEAK_INSTRUCTION_PREFIX}，保持事实一致，不调用工具：\n${content}`,
    }),
    buildResultInjection: content => ({
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: content }],
      },
      response: {
        modalities: ['text', 'audio'],
        tool_choice: 'none',
        instructions: '这是先前提交工作的最终结果。',
      },
    }),
    buildPermissionInjection: permission => ({
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: String(permission?.summary || '') }],
      },
      response: { modalities: ['text', 'audio'], instructions: '权限询问。' },
    }),
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
    permissionPolicy: {
      resolveDecision: () => null,
      rememberDecision: () => {},
    },
    realtimeProviderRegistry: createRealtimeProviderRegistry({
      providers: [provider],
      defaultProvider: provider.key,
    }),
    defaultRealtimeProvider: provider.key,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

/**
 * Connects a client that behaves like the ESS-1147 capture harness: it
 * acknowledges playback for every response, which is what releases buffered
 * transcripts and lets the announcement surface confirm its delivery.
 */
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
        clientLabel: 'ess1156',
        clientInstanceId: `ess1156-${sessionId}`,
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

async function runDelegatedTurn({ answerText, sessionId }) {
  const upstream = await startRealtimeUpstream({ answerText })
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
    frame => frame.type === 'task.stream.done' && frame.taskId === created.id,
  )
  // Nothing may follow the terminal frame, so give any late duplicate a
  // window to appear before the assertions run.
  await new Promise(resolve => setTimeout(resolve, 500))

  socket.close()
  await new Promise(resolve => server.close(resolve))
  await upstream.close()

  return { taskId: created.id, turnId, frames, done, upstream }
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

test('a weather answer is spoken exactly once (ESS-1147 2x repeat)', async () => {
  const { taskId, frames } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    sessionId: 'ess1156-weather',
  })

  // ESS-1165 stopped projecting a task's authoritative final answer into
  // segments: every segment was a separate prompt, and a real model answered
  // one of them with a restated whole answer. The final answer is now one
  // verified utterance.
  assert.equal(
    frames.filter(frame => (
      frame.type === 'task.stream.segment' && frame.taskId === taskId
    )).length,
    0,
    'the final answer is delivered as one utterance, not projected segments',
  )
  const answerText = frames.filter(frame => (
    frame.type === 'task.stream' && frame.category === 'text'
    && frame.taskId === taskId
  ))
  assert.equal(answerText.length, 1, 'exactly one final answer text frame')
  assert.equal(answerText[0].delta, WEATHER_ANSWER)

  const spoken = assistantTranscriptsFor(frames, taskId)
  assert.equal(
    spoken.join(''),
    WEATHER_ANSWER,
    `the answer must be heard exactly once; heard ${spoken.length} utterances`,
  )
})

test('a knowledge answer is spoken exactly once (ESS-1147 4x repeat)', async () => {
  const { taskId, frames } = await runDelegatedTurn({
    answerText: KNOWLEDGE_ANSWER,
    sessionId: 'ess1156-knowledge',
  })

  assert.equal(
    frames.filter(frame => (
      frame.type === 'task.stream.segment' && frame.taskId === taskId
    )).length,
    0,
    'the final answer is delivered as one utterance, not projected segments',
  )
  const answerText = frames.filter(frame => (
    frame.type === 'task.stream' && frame.category === 'text'
    && frame.taskId === taskId
  ))
  assert.equal(answerText.length, 1, 'exactly one final answer text frame')
  assert.equal(answerText[0].delta, KNOWLEDGE_ANSWER)

  const spoken = assistantTranscriptsFor(frames, taskId)
  assert.equal(
    spoken.join(''),
    KNOWLEDGE_ANSWER,
    `the answer must be heard exactly once; heard ${spoken.length} utterances`,
  )
})

test('the lifecycle terminal precedes the single task.stream.done, which is last', async () => {
  const { taskId, frames } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    sessionId: 'ess1156-order',
  })

  const taskFrames = frames.filter(frame => (
    ['task.stream', 'task.stream.done', 'task.stream.aborted', 'task.stream.fallback']
      .includes(frame.type)
    && frame.taskId === taskId
  ))
  const terminals = taskFrames.filter(frame => (
    frame.type === 'task.stream' && frame.category === 'terminal'
  ))
  const dones = taskFrames.filter(frame => frame.type === 'task.stream.done')

  assert.equal(terminals.length, 1, 'exactly one lifecycle terminal frame')
  assert.equal(dones.length, 1, 'exactly one task.stream.done')
  assert.equal(terminals[0].status, 'completed')
  assert.ok(
    taskFrames.indexOf(terminals[0]) < taskFrames.indexOf(dones[0]),
    'the lifecycle terminal must precede task.stream.done',
  )
  assert.equal(
    taskFrames.at(-1),
    dones[0],
    'task.stream.done must be the last frame of the task stream',
  )
  assert.equal(
    frames.filter(frame => frame.type === 'task.stream.fallback').length,
    0,
    'no streaming fallback',
  )

  // TaskStreamProtocol assigns a per-category sequence before it writes, so a
  // frame the socket refused (`socket_not_open`) shows up here as a gap.
  const sequences = new Map()
  for (const frame of taskFrames) {
    if (frame.type !== 'task.stream') continue
    const seen = sequences.get(frame.category) || []
    seen.push(frame.seq)
    sequences.set(frame.category, seen)
  }
  for (const [category, seen] of sequences) {
    assert.deepEqual(
      seen,
      seen.map((_, index) => index),
      `${category} frames arrived without a gap`,
    )
  }
})

test('a repeated terminal for the same task and generation is dropped by identity', () => {
  const claims = []
  const delivery = new TaskTerminalDelivery({
    claim: taskIds => { claims.push(taskIds); return taskIds.map(id => ({ id })) },
    release: () => {},
    markDelivered: () => {},
  })
  const identity = { sessionId: 's', taskId: 'work_1', generation: 1 }

  assert.equal(delivery.begin(identity), true)
  assert.equal(delivery.begin(identity), false, 'the same terminal never replays')
  // A rerun bumps the stream generation and is a different delivery, even
  // though the answer text may be identical.
  assert.equal(delivery.begin({ ...identity, generation: 2 }), true)
})

test('a streamed delivery that never reached the ear is handed back to the announcement', () => {
  const released = []
  const delivered = []
  const delivery = new TaskTerminalDelivery({
    claim: taskIds => taskIds.map(id => ({ id })),
    release: taskIds => released.push(...taskIds),
    markDelivered: taskIds => delivered.push(...taskIds),
  })
  const identity = { sessionId: 's', taskId: 'work_1', generation: 1 }

  delivery.begin(identity)
  assert.deepEqual(delivery.claimStream(identity), ['work_1'])
  assert.deepEqual(
    delivery.claimStream(identity), [],
    'a second claim for the same delivery is a no-op',
  )
  delivery.settle(identity, { delivered: false })
  assert.deepEqual(released, ['work_1'])
  assert.deepEqual(delivered, [])
  assert.deepEqual(
    delivery.settle(identity, { delivered: true }), [],
    'settling twice cannot mark a released claim delivered',
  )
})

test('a claim outliving the lease is renewed while the segments drain', () => {
  const renewed = []
  let tick = null
  const delivery = new TaskTerminalDelivery({
    claim: taskIds => taskIds.map(id => ({ id })),
    release: () => {},
    markDelivered: () => {},
    renew: taskIds => renewed.push(...taskIds),
    setTimer: fn => { tick = fn; return { unref() {} } },
    clearTimer: () => { tick = null },
  })
  const identity = { sessionId: 's', taskId: 'work_1', generation: 1 }

  delivery.begin(identity)
  delivery.claimStream(identity)
  tick()
  tick()
  assert.deepEqual(renewed, ['work_1', 'work_1'])
  delivery.settle(identity, { delivered: true })
  assert.equal(tick, null, 'renewal stops once the delivery is settled')
})

test('a socket close releases in-flight streamed claims', () => {
  const released = []
  const delivery = new TaskTerminalDelivery({
    claim: taskIds => taskIds.map(id => ({ id })),
    release: taskIds => released.push(...taskIds),
    markDelivered: () => {},
  })
  const identity = { sessionId: 's', taskId: 'work_1', generation: 1 }

  delivery.begin(identity)
  delivery.claimStream(identity)
  delivery.close()
  assert.deepEqual(released, ['work_1'])
})

test('a late chunk cannot resurrect a stream that already reached terminal', async () => {
  const spoken = []
  const projector = new CodexStreamProjector({
    speak: async text => { spoken.push(text); return { completed: true } },
  })
  const identity = {
    requestId: 'work_1', turnId: 't', taskId: 'work_1', generation: 1,
  }

  projector.push(identity, '最终答案。')
  const first = await projector.terminal(identity)
  assert.deepEqual(spoken, ['最终答案。'])

  // A duplicate terminal answer arriving after the drain used to open a second
  // stream and speak it again.
  projector.push(identity, '最终答案。')
  const second = await projector.terminal(identity)
  assert.deepEqual(spoken, ['最终答案。'], 'the answer is never spoken twice')
  assert.equal(second, first, 'terminal stays settled for this identity')
})
