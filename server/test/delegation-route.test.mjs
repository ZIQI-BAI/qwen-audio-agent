import assert from 'node:assert/strict'
import test from 'node:test'
import { delegationRoute, transcriptLogFields } from '../src/voice/delegation-route.mjs'

test('keeps self-contained questions on the realtime model', () => {
  for (const input of ['解释一下递归', '一加一等于几', '写一首关于月亮的短诗']) {
    assert.deepEqual(delegationRoute(input), {
      decision: 'direct', reason: 'self_contained',
    })
  }
})

test('deterministically delegates current and personal-domain requests', () => {
  const cases = [
    ['北京今天天气怎么样', 'current_data'],
    ['查一下我的知识库', 'personal_domain'],
    ['问问我的个人助理明天安排', 'personal_domain'],
    ['搜索最新的项目资料', 'current_data'],
    ['打开 Obsidian 里的会议笔记', 'personal_domain'],
  ]
  for (const [input, reason] of cases) {
    assert.deepEqual(delegationRoute(input), { decision: 'delegate', reason })
  }
  assert.deepEqual(delegationRoute('总结它', { hasFiles: true }), {
    decision: 'delegate', reason: 'file',
  })
})

test('transcript logs retain correlation without plaintext', () => {
  const text = '查看我的知识库，账号 alice@example.com，令牌 sk-supersecret'
  const fields = transcriptLogFields(text, delegationRoute(text))
  assert.equal(fields.routeDecision, 'delegate')
  assert.equal(fields.routeReason, 'personal_domain')
  assert.equal(fields.intentFingerprint.length, 16)
  assert.equal(JSON.stringify(fields).includes('alice'), false)
  assert.equal(JSON.stringify(fields).includes('supersecret'), false)
})
