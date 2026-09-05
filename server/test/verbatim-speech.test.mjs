import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyVerbatimDivergence,
  normalizeSpeech,
  verbatimVerdict,
} from '../src/voice/verbatim-speech.mjs'

test('punctuation and spacing are rendering choices, not divergence', () => {
  const answer = '杭州现在大约二十五摄氏度，多云，体感偏潮湿。'
  assert.equal(
    classifyVerbatimDivergence(answer, '杭州现在大约二十五摄氏度 多云 体感偏潮湿'),
    null,
  )
  // The signature the real captures carry, with the dash and quote rendered
  // differently by the transcript.
  assert.equal(
    classifyVerbatimDivergence('— Jackson\'Avatar', '- Jackson’Avatar'),
    null,
  )
})

test('case and width normalisation keep latin fragments from failing alone', () => {
  assert.equal(normalizeSpeech('Codex ＡＰＩ'), normalizeSpeech('codex api'))
  assert.equal(classifyVerbatimDivergence('新版 Responses API', '新版 responses api'), null)
})

test('a changed word is a rewrite, not a formatting difference', () => {
  assert.equal(
    classifyVerbatimDivergence('杭州现在二十五摄氏度。', '杭州现在二十六摄氏度。'),
    'speech_rewritten',
  )
})

test('the ESS-1165 failure modes each get their own classification', () => {
  const answer = '知识库中最新收录的是九月四日的《今起 Codex 每天重置一次》。'
  // knowledge: the model spoke progress filler instead of the result
  assert.equal(
    classifyVerbatimDivergence(answer, '正在查找，请稍候。'),
    'speech_rewritten',
  )
  // weather: the model kept the answer and added a whole restatement
  assert.equal(
    classifyVerbatimDivergence(answer, `${answer}还需要我再查点别的吗？`),
    'speech_expanded',
  )
  // a rendering that stopped early
  assert.equal(
    classifyVerbatimDivergence(answer, answer.slice(0, 10)),
    'speech_truncated',
  )
  // nothing was said at all
  assert.equal(classifyVerbatimDivergence(answer, ''), 'speech_missing')
})

test('an empty script has nothing to diverge from', () => {
  assert.equal(classifyVerbatimDivergence('', '随便说点什么'), null)
})

test('the verdict carries the evidence a log needs', () => {
  const verdict = verbatimVerdict('答案。', '完全不同的话。')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'speech_rewritten')
  assert.equal(verdict.intendedLength, 2)
  assert.equal(verdict.spokenLength, 6)
  assert.deepEqual(verbatimVerdict('答案。', '答案').ok, true)
})
