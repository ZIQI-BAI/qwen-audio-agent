import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptsPlaybackReceipt,
  confirmsTaskNotificationOnPlaybackStart,
  publicResponseDoneEvent,
  rejectUnsupportedRealtimeUpgrade,
  shouldSuppressDeferredToolResponse,
} from '../src/voice/realtime-gateway.mjs'
import { isResponseActivityEvent } from '../src/voice/response-lifecycle.mjs'

test('closes websocket upgrades outside the realtime endpoint', () => {
  let destroyed = false
  const socket = {
    destroy() {
      destroyed = true
    },
  }

  assert.equal(
    rejectUnsupportedRealtimeUpgrade(socket, '/unexpected'),
    true,
  )
  assert.equal(destroyed, true)
})

test('leaves the realtime websocket upgrade for the gateway handler', () => {
  let destroyed = false
  const socket = {
    destroy() {
      destroyed = true
    },
  }

  assert.equal(
    rejectUnsupportedRealtimeUpgrade(socket, '/api/realtime'),
    false,
  )
  assert.equal(destroyed, false)
})

test('confirms task notifications when client playback starts', () => {
  assert.equal(confirmsTaskNotificationOnPlaybackStart({
    origin: 'announcement',
  }), true)
  assert.equal(confirmsTaskNotificationOnPlaybackStart({
    origin: 'model',
    consumesTaskNotification: true,
  }), true)
  assert.equal(confirmsTaskNotificationOnPlaybackStart({
    origin: 'model',
  }), false)
})

test('accepts playback receipts only from the active output client for a known response', () => {
  assert.equal(acceptsPlaybackReceipt({
    outputEnabled: true,
    active: true,
    responseKnown: true,
  }), true)
  assert.equal(acceptsPlaybackReceipt({
    outputEnabled: true,
    active: false,
    responseKnown: true,
  }), false)
  assert.equal(acceptsPlaybackReceipt({
    outputEnabled: false,
    active: true,
    responseKnown: true,
  }), false)
  assert.equal(acceptsPlaybackReceipt({
    outputEnabled: true,
    active: true,
    responseKnown: false,
  }), false)
})

test('forwards validated response.done metadata with flat and compatible fields', () => {
  assert.deepEqual(publicResponseDoneEvent({
    responseId: 'response-1',
    status: 'completed',
    context: {
      origin: 'model',
      turnId: 'turn-1',
      turnGeneration: 3,
      taskId: 'task-1',
      hasFunctionCall: true,
    },
  }), {
    type: 'response.done',
    responseId: 'response-1',
    origin: 'model',
    status: 'completed',
    hasFunctionCall: true,
    turnId: 'turn-1',
    taskId: 'task-1',
    taskIds: ['task-1'],
    turnGeneration: 3,
    response: { id: 'response-1', status: 'completed' },
  })
  assert.equal(publicResponseDoneEvent({ responseId: '   ' }), null)
})

test('current-turn action promise does not suppress its tool result response', () => {
  const currentTurn = {
    responseTurnId: 'turn-1',
    currentTurnId: 'turn-1',
    currentTurnGeneration: 3,
  }
  assert.equal(shouldSuppressDeferredToolResponse({
    ...currentTurn,
    context: {
      origin: 'model',
      turnGeneration: 3,
      hasFunctionCall: true,
      hasAudio: true,
      assistantTranscript: '我正在查询',
    },
  }), false)
  assert.equal(shouldSuppressDeferredToolResponse({
    ...currentTurn,
    context: {
      origin: 'announcement',
      turnGeneration: 3,
      hasFunctionCall: true,
      hasAudio: true,
    },
  }), true)
  assert.equal(shouldSuppressDeferredToolResponse({
    ...currentTurn,
    responseTurnId: 'stale-turn',
    context: {
      origin: 'model',
      turnGeneration: 2,
      hasFunctionCall: true,
      hasAudio: true,
    },
  }), true)
})

test('recognizes response activity when response.created is omitted', () => {
  for (const event of [
    { type: 'response.created', response: { id: 'response-1' } },
    { type: 'response.output_audio.delta', response_id: 'response-1' },
    { type: 'response.output_audio_transcript.done', response_id: 'response-1' },
    { type: 'response.text.delta', response_id: 'response-1' },
    { type: 'response.function_call_arguments.done', response_id: 'response-1' },
    { type: 'response.done', response: { id: 'response-1' } },
  ]) {
    assert.equal(isResponseActivityEvent(event), true, event.type)
  }
  assert.equal(isResponseActivityEvent({ type: 'response.text.delta' }), false)
  assert.equal(isResponseActivityEvent({ type: 'session.updated' }), false)
})
