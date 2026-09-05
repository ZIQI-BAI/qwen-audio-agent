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

// Normalisation tolerates punctuation so a transcript pass is not punished for
// rendering it differently. That tolerance is exactly what makes numbers
// dangerous: every character below decides a value, and dropping it would let
// audio saying a different number pass as verbatim.
test('a symbol that carries a number is never normalised away', () => {
  const numeric = [
    ['温度范围 -3～5°C', '温度范围 35°C', 'a range collapsed into one number'],
    ['10+2=12', '10212', 'an expression collapsed into digits'],
    ['今晚最低 -3°C', '今晚最低 3°C', 'a dropped minus sign flips the value'],
    ['三点零五分是 3:05', '三点零五分是 305', 'a dropped colon is a different time'],
    ['误差 0.5 米', '误差 05 米', 'a dropped decimal point is a different length'],
    ['涨了 50%', '涨了 50', 'a dropped percent sign is a different quantity'],
    ['共 1,024 条', '共 1024 条', 'a thousands separator is not silently equal'],
  ]
  for (const [intended, spoken, why] of numeric) {
    assert.notEqual(
      classifyVerbatimDivergence(intended, spoken), null,
      `${why}: ${intended} / ${spoken}`,
    )
  }
})

test('punctuation next to a digit stays significant, elsewhere it does not', () => {
  // The same dash: a range between digits, a typographic dash in prose.
  assert.notEqual(classifyVerbatimDivergence('3-5 天', '35 天'), null)
  assert.equal(classifyVerbatimDivergence('结果 — 完成', '结果 完成'), null)
  // Whitespace between the dash and the digit does not disarm the guard.
  assert.notEqual(classifyVerbatimDivergence('范围 - 3 到 5', '范围 3 到 5'), null)
})
