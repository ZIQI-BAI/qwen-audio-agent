import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activityFromUpdate,
  progressFromUpdate,
} from '../src/agent/acp-backend-session-utils.mjs'

test('projects ordered reasoning, tool and answer deltas without leaking secrets', () => {
  const state = {}
  const project = update => progressFromUpdate(update, state)
  assert.deepEqual(project({ sessionUpdate: 'agent_thought_chunk', seq: 1,
    content: { type: 'text', text: 'Inspecting files' } }),
  { category: 'reasoning', seq: 1, text: 'Inspecting files' })
  assert.equal(project({ sessionUpdate: 'agent_thought_chunk', seq: 1,
    content: { type: 'text', text: 'duplicate' } }), null)
  assert.deepEqual(project({ sessionUpdate: 'tool_call', seq: 2,
    title: 'Run tests', rawInput: { token: 'never publish me' } }),
  { category: 'tool', seq: 2, text: 'Run tests' })
  assert.equal(project({ sessionUpdate: 'agent_message_chunk', seq: 3,
    content: { type: 'text', text: 'API_KEY=secret' } }), null)
  assert.deepEqual(project({ sessionUpdate: 'agent_message_chunk', seq: 4,
    content: { type: 'text', text: 'Done' } }),
  { category: 'answer', seq: 3, text: 'Done' })
})

test('projects an ACP plan into stable task progress', () => {
  assert.deepEqual(activityFromUpdate({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Inspect the project', status: 'completed' },
      { content: 'Implement the change', status: 'in_progress' },
      { content: 'Run tests', status: 'pending' },
    ],
  }), {
    id: 'acp-plan',
    kind: 'plan',
    status: 'running',
    detail: 'Implement the change',
    completed: 1,
    total: 3,
  })
})

test('keeps the ACP human-readable tool title separate from raw details', () => {
  assert.deepEqual(activityFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-1',
    name: 'shell',
    title: 'Run project tests',
    status: 'pending',
    rawInput: {
      command: 'npm test',
      description: '验证项目测试',
    },
  }), {
    id: 'tool-1',
    kind: 'tool',
    tool: 'shell',
    label: '验证项目测试',
    status: 'pending',
    category: 'run',
    detail: '验证项目测试',
  })
})
