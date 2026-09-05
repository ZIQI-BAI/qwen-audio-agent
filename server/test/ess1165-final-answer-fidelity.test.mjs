// ESS-1165 regression: a task's authoritative final answer must reach the ear
// verbatim, exactly once — or not at all. It may never be replaced by whatever
// the realtime model felt like saying.
//
// ESS-1157 redeployed the ESS-1156 fix (PR #16) onto the real qwen-audio-agent
// LaunchAgent and drove the real `text.message -> qwen-audio-agent -> Codex ->
// WSS -> ffplay` chain. Both delegated cases still failed, and neither failure
// was a claim/idempotency failure — the task identity was claimed exactly once
// both times:
//
//   weather   session ess990-capture-bb94afee
//             turn text_79ab2d0aa6af4e71ab624a25324aa1f8
//             task work_f10290f9-173e-47c1-bb79-8be99c43f8bd
//             task.completed at 18.256s; the model then spoke the result at
//             21.811s and AGAIN at 26.464s, the second time rewritten into a
//             complete answer of its own ("杭州现在天气不错哦……")
//
//   knowledge session ess990-capture-944cca5a
//             turn text_2a5c0356bb0a48ab84e61a97d8f8b85b
//             task work_906bcf82-fc5a-4482-8285-7e068c640e3b
//             task.completed at 9.127s with the full article summary; all four
//             following responses spoke progress filler ("正在查找，请稍候")
//             and the result was delivered 0 times
//
// Root cause: the final answer was rendered by asking the conversational model
// to say it "naturally", once per projected segment. A real DashScope realtime
// model does not treat that as text-to-speech. So this suite does NOT script a
// faithful model — a faithful replay cannot reproduce either failure. It
// scripts the two misbehaviours the capture recorded and asserts the delivery
// stays correct anyway.

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
const {
  speakResponseInstructions,
  verbatimSpeechInstructions,
} = await import('../src/voice/frontend-tools.mjs')

// Verbatim from the ESS-1157 `task.completed` frames.
const WEATHER_ANSWER = '杭州现在大约二十五摄氏度，多云，湿度偏高，体感偏潮湿。'
  + '夜间气温会降到二十三度左右。— Jackson\'Avatar'
const KNOWLEDGE_ANSWER = '知识库中最新收录的是九月四日的《今起 Codex 每天重置一次》。'
  + '核心观点是：Codex 据称将提供每日额度重置，但适用范围和规则尚无官方确认；'
  + '新版 Responses API 更适合长程智能体任务，支持异步调用、任务转向和推理强度调整；'
  + '模型升级后可以精简冗余的 AGENTS.md 指令，但身份、安全和授权边界必须保留。'
  + '— Jackson\'Avatar'

// What the model actually said in the two captures instead of the answer.
const WEATHER_REWRITE = '杭州现在天气不错哦，大约二十五摄氏度，多云，'
  + '湿度偏高，体感有点潮湿，夜里会降到二十三度上下，出门记得带件外套。'
const PROGRESS_FILLER = '正在查找，请稍候。'

const AUDIO_FRAME = Buffer.alloc(960).toString('base64')

function speechScript(instructions) {
  const match = /<speech_script>\n([\s\S]*)\n<\/speech_script>/u.exec(
    String(instructions || ''),
  )
  return match ? match[1] : ''
}

/**
 * Scripted realtime upstream whose model misbehaves exactly the way the real
 * DashScope model misbehaved. `behaviour(script, attempt)` returns what the
 * model speaks for one rendering request; returning the script itself is a
 * faithful render.
 */
function startRealtimeUpstream({
  behaviour,
  publishesTranscript = true,
  responseDelayMs = 20,
}) {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const renderings = []
  wss.on('connection', ws => {
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
        ws.send(JSON.stringify({
          type: 'conversation.item.created',
          item: { id: event.item?.id },
        }))
        return
      }
      if (event.type !== 'response.create') return
      const id = `resp_fake_${++sequence}`
      const script = speechScript(event.response?.instructions)
      const spoken = script
        ? behaviour(script, renderings.length + 1)
        : ''
      if (script) renderings.push({ id, script, spoken })
      ws.send(JSON.stringify({ type: 'response.created', response: { id } }))
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (spoken) {
          ws.send(JSON.stringify({
            type: 'response.audio.delta', response_id: id, delta: AUDIO_FRAME,
          }))
          if (publishesTranscript) {
            ws.send(JSON.stringify({
              type: 'response.audio_transcript.done',
              response_id: id,
              transcript: spoken,
            }))
          }
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
        renderings,
        url: `ws://127.0.0.1:${server.address().port}/realtime`,
        close: () => new Promise(done => {
          for (const client of wss.clients) client.terminate()
          server.close(done)
        }),
      })
    })
  })
}

// Mirrors the DashScope provider contract, including the verbatim rendering
// request the gateway verifies against. The upstream above is the only part
// that is scripted.
function scriptedProvider(url) {
  return {
    key: 'ess1165-scripted',
    label: 'ESS-1165 Scripted Realtime',
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
      instructions: speakResponseInstructions(content),
    }),
    buildVerbatimSpeechResponse: content => ({
      conversation: 'none',
      modalities: ['text', 'audio'],
      tool_choice: 'none',
      instructions: verbatimSpeechInstructions(content),
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
  answerText,
  sessionId,
  behaviour,
  publishesTranscript = true,
}) {
  const upstream = await startRealtimeUpstream({ behaviour, publishesTranscript })
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

  await waitFor(
    frames,
    frame => frame.type === 'task.stream.done' && frame.taskId === created.id,
  )
  // Nothing may follow the turn's terminal frame, so give a late duplicate a
  // window to show up before the assertions run.
  await new Promise(resolve => setTimeout(resolve, 500))

  socket.close()
  await new Promise(resolve => server.close(resolve))
  await upstream.close()

  return { taskId: created.id, turnId, frames, renderings: upstream.renderings }
}

const assistantTranscripts = (frames, taskId) => frames
  .filter(frame => (
    frame.type === 'transcript.final'
    && frame.role === 'assistant'
    && frame.taskId === taskId
  ))
  .map(frame => frame.content)

const finalAnswerText = (frames, taskId) => frames.filter(frame => (
  frame.type === 'task.stream'
  && frame.category === 'text'
  && frame.taskId === taskId
))

const lifecycleTerminals = (frames, taskId) => frames.filter(frame => (
  frame.type === 'task.stream'
  && frame.category === 'terminal'
  && frame.taskId === taskId
))

test('a model that restates the answer in its own words is never heard (weather 2x)', async () => {
  // The capture's weather failure: the model produced a complete answer of its
  // own instead of reading the result. It reads faithfully on the retry.
  const { taskId, frames, renderings } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    sessionId: 'ess1165-weather-rewrite',
    behaviour: (script, attempt) => (attempt === 1 ? WEATHER_REWRITE : script),
  })

  assert.equal(renderings.length, 2, 'the diverged rendering was retried once')
  assert.equal(renderings[0].spoken, WEATHER_REWRITE)

  const spoken = assistantTranscripts(frames, taskId)
  assert.deepEqual(
    spoken,
    [WEATHER_ANSWER],
    'only the verbatim answer reaches the user, exactly once',
  )
  assert.ok(
    !frames.some(frame => (
      typeof frame.content === 'string' && frame.content.includes('天气不错哦')
    )),
    'the rewritten utterance never reaches the client on any frame',
  )
  // The rewritten rendering produced audio upstream; none of it was forwarded.
  const audioResponses = new Set(
    frames.filter(frame => frame.type === 'audio.delta').map(frame => frame.responseId),
  )
  assert.equal(audioResponses.size, 1, 'exactly one rendering was ever audible')
  assert.ok(
    !audioResponses.has(renderings[0].id),
    'the diverged rendering’s audio was discarded, not played',
  )
})

test('a model that answers with progress filler cannot swallow the result (knowledge 0x)', async () => {
  // The capture's knowledge failure: every response after task.completed was
  // "正在查找，请稍候" and the authoritative result was never spoken. Here the
  // model never recovers, so speech has to be withheld — but the answer must
  // still be delivered, and filler must never be presented as the answer.
  const { taskId, frames, renderings } = await runDelegatedTurn({
    answerText: KNOWLEDGE_ANSWER,
    sessionId: 'ess1165-knowledge-progress',
    behaviour: () => PROGRESS_FILLER,
  })

  assert.equal(renderings.length, 2, 'both attempts diverged')
  assert.ok(
    !frames.some(frame => (
      typeof frame.content === 'string' && frame.content.includes('正在查找')
    )),
    'progress filler is never delivered as the assistant’s answer',
  )
  assert.deepEqual(
    assistantTranscripts(frames, taskId), [],
    'no utterance is attributed to this task when none of them said the answer',
  )
  assert.equal(
    frames.filter(frame => frame.type === 'audio.delta').length,
    0,
    'no audio at all is better than audio that is not the answer',
  )

  // The answer itself is still delivered: the authoritative text frame does
  // not depend on the model, and the failure is reported explicitly.
  const answerText = finalAnswerText(frames, taskId)
  assert.equal(answerText.length, 1, 'exactly one final answer text frame')
  assert.equal(answerText[0].delta, KNOWLEDGE_ANSWER)
  const fallbacks = frames.filter(frame => frame.type === 'task.stream.fallback')
  assert.equal(fallbacks.length, 1, 'the withheld speech is reported once')
  assert.equal(fallbacks[0].streaming_fallback_reason, 'speech_rewritten')
  assert.equal(lifecycleTerminals(frames, taskId).length, 1)
})

test('a truncated rendering is rejected as firmly as a rewritten one', async () => {
  const { taskId, frames } = await runDelegatedTurn({
    answerText: KNOWLEDGE_ANSWER,
    sessionId: 'ess1165-knowledge-truncated',
    behaviour: script => script.slice(0, 40),
  })

  assert.deepEqual(assistantTranscripts(frames, taskId), [])
  const fallbacks = frames.filter(frame => frame.type === 'task.stream.fallback')
  assert.equal(fallbacks.length, 1)
  assert.equal(fallbacks[0].streaming_fallback_reason, 'speech_truncated')
})

test('a rendering that appends its own words to the answer is rejected', async () => {
  const { taskId, frames } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    sessionId: 'ess1165-weather-expanded',
    behaviour: script => `${script}还需要我帮你看看明天的天气吗？`,
  })

  assert.deepEqual(assistantTranscripts(frames, taskId), [])
  const fallbacks = frames.filter(frame => frame.type === 'task.stream.fallback')
  assert.equal(fallbacks.length, 1)
  assert.equal(fallbacks[0].streaming_fallback_reason, 'speech_expanded')
})

test('the verified answer ends the turn: terminal first, one audio.done last', async () => {
  const { taskId, frames } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    sessionId: 'ess1165-order',
    behaviour: script => script,
  })

  assert.equal(
    finalAnswerText(frames, taskId).length, 1,
    'the final answer text is delivered exactly once',
  )
  assert.equal(
    lifecycleTerminals(frames, taskId).length, 1,
    'exactly one lifecycle terminal',
  )
  assert.equal(
    frames.filter(frame => frame.type === 'task.stream.done').length, 1,
    'exactly one task.stream.done',
  )
  const audioDones = frames.filter(frame => frame.type === 'audio.done')
  assert.equal(audioDones.length, 1, 'exactly one final TTS')
  assert.ok(
    frames.indexOf(lifecycleTerminals(frames, taskId)[0]) < frames.indexOf(audioDones[0]),
    'the lifecycle terminal precedes the final audio.done',
  )
  assert.equal(
    frames.at(-1), audioDones[0],
    `audio.done must be the turn's last frame; saw ${frames.at(-1)?.type} after it`,
  )
  assert.equal(
    frames.filter(frame => frame.type === 'task.stream.fallback').length, 0,
    'a faithful rendering needs no fallback',
  )

  // TaskStreamProtocol assigns a per-category sequence before it writes, so a
  // frame the socket refused (`socket_not_open`) shows up here as a gap.
  const sequences = new Map()
  for (const frame of frames) {
    if (frame.type !== 'task.stream' || frame.taskId !== taskId) continue
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

test('a rendering that produced nothing is a failure, not a silent delivery', async () => {
  const { taskId, frames } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    sessionId: 'ess1165-silent',
    behaviour: () => '',
  })

  assert.deepEqual(assistantTranscripts(frames, taskId), [])
  assert.equal(frames.filter(frame => frame.type === 'audio.delta').length, 0)
  const fallbacks = frames.filter(frame => frame.type === 'task.stream.fallback')
  assert.equal(fallbacks.length, 1)
  assert.equal(fallbacks[0].streaming_fallback_reason, 'speech_missing')
  // The answer is still delivered as text and the stream still terminates.
  assert.equal(finalAnswerText(frames, taskId).length, 1)
  assert.equal(lifecycleTerminals(frames, taskId).length, 1)
})

test('a provider that publishes no transcript is not silenced by the check', async () => {
  // Verification needs the provider's own transcript. A provider that renders
  // audio without one (some speech-to-speech pipelines) must keep working:
  // the gap is logged, not turned into permanent silence.
  const { taskId, frames } = await runDelegatedTurn({
    answerText: WEATHER_ANSWER,
    sessionId: 'ess1165-no-transcript',
    behaviour: script => script,
    publishesTranscript: false,
  })

  assert.ok(
    frames.filter(frame => frame.type === 'audio.delta').length > 0,
    'the answer is still spoken',
  )
  assert.equal(
    frames.filter(frame => frame.type === 'task.stream.fallback').length, 0,
  )
  assert.equal(frames.filter(frame => frame.type === 'audio.done').length, 1)
  assert.equal(lifecycleTerminals(frames, taskId).length, 1)
})
