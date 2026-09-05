// ESS-1165 contract E2E against the real DashScope realtime model.
//
// The scripted upstream in ess1165-terminal-result-fidelity.test.mjs proves the
// gateway sends the right response and reacts to what comes back. It cannot
// prove the premise the fix rests on: that the real model reads an isolated
// verbatim response and rewrites everything else. ESS-1157 was signed off twice
// on scripted evidence and failed twice on the real chain, so that premise is
// measured here, on the exact answers the captures contain.
//
// Opt-in, because it spends real quota and needs network:
//
//   QWEN_AUDIO_E2E=1 DASHSCOPE_API_KEY=... DASHSCOPE_WORKSPACE_ID=... \
//     node --test server/test/ess1165-dashscope-verbatim.e2e.test.mjs
//
// Recorded result on qwen-audio-3.0-realtime-plus (2026-09-06):
//   old speak shape       0/4 knowledge segments verbatim (rewrites, refusals)
//   verbatim shape        4/4 verbatim
//   verbatim, one shot    weather and knowledge answers read exactly

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { WebSocket } from 'ws'

import {
  buildFrontendInstructions,
  speakResponseInstructions,
  verbatimSpeechInstructions,
} from '../src/voice/frontend-tools.mjs'
import { isVerbatimSpeech } from '../src/voice/terminal-speech-fidelity.mjs'

const ENABLED = process.env.QWEN_AUDIO_E2E === '1'
  && Boolean(process.env.DASHSCOPE_API_KEY)
const MODEL = process.env.QWEN_AUDIO_REALTIME_MODEL || 'qwen-audio-3.0-realtime-plus'
const VOICE = process.env.QWEN_AUDIO_REALTIME_VOICE || 'longanqian'

function realtimeUrl() {
  if (process.env.QWEN_AUDIO_REALTIME_BASE_URL) {
    return `${process.env.QWEN_AUDIO_REALTIME_BASE_URL}?model=${MODEL}`
  }
  const workspace = process.env.DASHSCOPE_WORKSPACE_ID
  const host = workspace
    ? `${workspace}.cn-beijing.maas.aliyuncs.com`
    : 'dashscope.aliyuncs.com'
  return `wss://${host}/api-ws/v1/realtime?model=${MODEL}`
}

const QUESTION = '我个人的 Obsidian 知识库里面的最新文章的观点是什么？'
// The four segments the old projector produced for the ESS-1157 knowledge
// answer, and the answer itself.
const KNOWLEDGE_SEGMENTS = [
  '知识库中最新收录的是九月四日的《今起 Codex 每天重置一次》。',
  '核心观点是：Codex 据称将提供每日额度重置，但适用范围和规则尚无官方确认；',
  '新版 Responses API 更适合长程智能体任务，支持异步调用、任务转向和推理强度调整；',
  '模型升级后可以精简冗余的 AGENTS.md 指令，但身份、安全和授权边界必须保留。'
  + '总体而言，它更适合作为产品动态线索，关于 GPT-6 Astra、二十七万二千 token '
  + '和评测成绩的说法仍需官方核验。目前知识库没有记录你本人对它的明确观点。'
  + '— Jackson\'Avatar',
]
const KNOWLEDGE_ANSWER = KNOWLEDGE_SEGMENTS.join('')
const WEATHER_ANSWER = '杭州现在大约二十五摄氏度，晴到多云，湿度约百分之八十，'
  + '北风二级左右，空气质量优。凌晨气温变化不大，体感偏潮湿。— Jackson\'Avatar'
const PROGRESS = '已经开始处理您的 Obsidian 知识库最新文章的观点总结。'

const oldSpeakResponse = content => ({
  conversation: 'none',
  modalities: ['text', 'audio'],
  instructions: speakResponseInstructions(content),
})
const verbatimResponse = content => ({
  conversation: 'none',
  input: [],
  tool_choice: 'none',
  modalities: ['text', 'audio'],
  instructions: verbatimSpeechInstructions(content),
})

/**
 * Drive one real session: seed the user question, speak a progress line the way
 * the gateway does, then issue one response per utterance and return what the
 * model actually said, in order.
 */
function speakAll(utterances, shapeFor, { question = QUESTION } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(realtimeUrl(), {
      headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` },
    })
    const spoken = []
    let index = -1
    const send = payload => ws.send(JSON.stringify({
      event_id: `event_${randomUUID().replaceAll('-', '')}`,
      ...payload,
    }))
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('DashScope realtime did not answer in time'))
    }, 180_000)

    const next = () => {
      index += 1
      if (index === 0) {
        send({
          type: 'response.create',
          response: oldSpeakResponse(PROGRESS),
        })
        return
      }
      if (index > utterances.length) {
        clearTimeout(timer)
        ws.close()
        resolve(spoken)
        return
      }
      send({ type: 'response.create', response: shapeFor(utterances[index - 1]) })
    }

    ws.on('open', () => send({
      type: 'session.update',
      session: {
        instructions: buildFrontendInstructions({}),
        modalities: ['text', 'audio'],
        voice: VOICE,
        output_audio_format: 'pcm',
        input_audio_format: 'pcm',
        turn_detection: null,
      },
    }))
    ws.on('message', raw => {
      let event
      try {
        event = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (event.type === 'session.updated') {
        send({
          type: 'conversation.item.create',
          item: {
            id: `item_${randomUUID().replaceAll('-', '')}`,
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: question }],
          },
        })
        setTimeout(next, 400)
        return
      }
      if (event.type === 'response.done') {
        const parts = []
        for (const item of event.response?.output || []) {
          for (const part of item.content || []) {
            parts.push(part.transcript || part.text || '')
          }
        }
        // index 0 is the progress utterance, which is deliberately free-form.
        if (index > 0) spoken.push(parts.join('').trim())
        setTimeout(next, 400)
      }
    })
    ws.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

test('the old speak shape lets the real model rewrite the answer (ESS-1157)', {
  skip: ENABLED ? false : 'set QWEN_AUDIO_E2E=1 and DASHSCOPE_API_KEY to run',
}, async () => {
  const spoken = await speakAll(KNOWLEDGE_SEGMENTS, oldSpeakResponse)
  const verbatim = spoken.filter(
    (text, index) => isVerbatimSpeech(KNOWLEDGE_SEGMENTS[index], text),
  )
  assert.ok(
    verbatim.length < KNOWLEDGE_SEGMENTS.length,
    'the premise of ESS-1165 is that this shape is not reliable; if the model '
    + 'now reads every segment, re-derive the fix instead of trusting this test',
  )
})

test('the verbatim shape makes the real model read every segment', {
  skip: ENABLED ? false : 'set QWEN_AUDIO_E2E=1 and DASHSCOPE_API_KEY to run',
}, async () => {
  const spoken = await speakAll(KNOWLEDGE_SEGMENTS, verbatimResponse)
  assert.equal(spoken.length, KNOWLEDGE_SEGMENTS.length)
  spoken.forEach((text, index) => {
    assert.ok(
      isVerbatimSpeech(KNOWLEDGE_SEGMENTS[index], text),
      `segment ${index} was not read verbatim:\n  want ${
        KNOWLEDGE_SEGMENTS[index]}\n  got  ${text}`,
    )
  })
})

test('the real model reads a complete answer as one utterance', {
  skip: ENABLED ? false : 'set QWEN_AUDIO_E2E=1 and DASHSCOPE_API_KEY to run',
}, async () => {
  const [knowledge] = await speakAll([KNOWLEDGE_ANSWER], verbatimResponse)
  assert.ok(
    isVerbatimSpeech(KNOWLEDGE_ANSWER, knowledge),
    `the knowledge answer was not read verbatim:\n  got ${knowledge}`,
  )

  const [weather] = await speakAll([WEATHER_ANSWER], verbatimResponse, {
    question: '杭州的天气怎么样？',
  })
  assert.ok(
    isVerbatimSpeech(WEATHER_ANSWER, weather),
    `the weather answer was not read verbatim:\n  got ${weather}`,
  )
})
