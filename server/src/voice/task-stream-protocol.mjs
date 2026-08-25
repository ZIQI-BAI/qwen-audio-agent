export const TASK_STREAM_PROTOCOL_VERSION = 1

const DEFAULT_PROGRESS_WINDOW_MS = 750

function streamKey(identity) {
  return `${identity.sessionId}:${identity.taskId}`
}

function normalizedIdentity(value = {}) {
  return {
    taskId: String(value.taskId || value.requestId || ''),
    requestId: String(value.requestId || value.taskId || ''),
    sessionId: String(value.sessionId || ''),
    generation: Number.isInteger(value.generation) ? value.generation : 1,
  }
}

/**
 * Connection-local projection of backend task activity onto the public WSS
 * stream contract. Text and audio have independent sequence spaces. A terminal
 * frame is emitted only after both the backend task and its response/audio
 * projection reach a terminal state.
 */
export class TaskStreamProtocol {
  constructor({
    send,
    log = {},
    now = Date.now,
    progressWindowMs = DEFAULT_PROGRESS_WINDOW_MS,
  } = {}) {
    if (typeof send !== 'function') throw new TypeError('send is required')
    this.send = send
    this.log = log
    this.now = now
    this.progressWindowMs = Math.max(0, progressWindowMs)
    this.streams = new Map()
    this.terminalGenerations = new Map()
    this.closed = false
  }

  state(value) {
    const identity = normalizedIdentity(value)
    const key = streamKey(identity)
    const terminalGeneration = this.terminalGenerations.get(key)
    if (terminalGeneration !== undefined && identity.generation <= terminalGeneration) {
      this.drop(
        identity.generation === terminalGeneration
          ? 'after_terminal' : 'stale_generation',
        identity,
        { terminalGeneration },
      )
      return null
    }
    const current = this.streams.get(key)
    if (current && identity.generation < current.identity.generation) {
      this.drop('stale_generation', identity, { activeGeneration: current.identity.generation })
      return null
    }
    if (current && identity.generation === current.identity.generation) return current
    if (current) this.drop('generation_replaced', current.identity, { nextGeneration: identity.generation })
    const startedAt = this.now()
    const state = {
      key, identity, startedAt, firstProgressAt: null, firstAnswerAt: null,
      sequences: { progress: 0, text: 0, audio: 0, terminal: 0 },
      lastProgress: '', lastProgressAt: -Infinity,
      taskTerminal: null, responseTerminal: false, terminalSent: false,
    }
    this.streams.set(key, state)
    return state
  }

  frame(state, category, payload = {}) {
    if (!state || this.closed || state.terminalSent) {
      if (state) this.drop(this.closed ? 'socket_closed' : 'after_terminal', state.identity, { category })
      return false
    }
    const seq = state.sequences[category]++
    const frame = {
      type: 'task.stream',
      protocolVersion: TASK_STREAM_PROTOCOL_VERSION,
      ...state.identity,
      category,
      seq,
      ...payload,
    }
    const accepted = this.send(frame) !== false
    if (!accepted) this.drop('socket_not_open', state.identity, { category, seq })
    return accepted
  }

  progress(identity, message, payload = {}) {
    const state = this.state(identity)
    if (!state) return false
    const text = String(message || '').trim()
    const now = this.now()
    if (text === state.lastProgress && now - state.lastProgressAt < this.progressWindowMs) {
      this.drop('progress_throttled', state.identity, { category: 'progress' })
      return false
    }
    state.lastProgress = text
    state.lastProgressAt = now
    if (state.firstProgressAt === null) {
      state.firstProgressAt = now
      this.log.info?.('task.stream.first_progress', this.metrics(state))
    }
    return this.frame(state, 'progress', { message: text, ...payload })
  }

  text(identity, delta) {
    const state = this.state(identity)
    if (!state) return false
    const text = String(delta || '')
    if (!text) return false
    if (state.firstAnswerAt === null) {
      state.firstAnswerAt = this.now()
      this.log.info?.('task.stream.first_answer', this.metrics(state))
    }
    return this.frame(state, 'text', { delta })
  }

  audio(identity, payload = {}) {
    return this.frame(this.state(identity), 'audio', payload)
  }

  taskDone(identity, status, payload = {}) {
    const state = this.state(identity)
    if (!state) return false
    state.taskTerminal = { status, ...payload }
    return this.finish(state)
  }

  responseDone(identity, payload = {}) {
    const state = this.state(identity)
    if (!state) return false
    state.responseTerminal = true
    state.responsePayload = payload
    return this.finish(state)
  }

  cancel(identity, reason = 'cancelled') {
    const state = this.state(identity)
    if (!state) return false
    state.taskTerminal = { status: 'cancelled', reason }
    state.responseTerminal = true
    return this.finish(state)
  }

  finish(state) {
    if (!state.taskTerminal || !state.responseTerminal || state.terminalSent) return false
    const sent = this.frame(state, 'terminal', {
      ...state.taskTerminal,
      ...(state.responsePayload || {}),
      metrics: this.metrics(state),
    })
    state.terminalSent = true
    this.terminalGenerations.set(state.key, state.identity.generation)
    this.log.info?.('task.stream.terminal', {
      ...state.identity, ...this.metrics(state), status: state.taskTerminal.status,
    })
    this.streams.delete(state.key)
    return sent
  }

  close(reason = 'socket_closed') {
    this.closed = true
    for (const state of this.streams.values()) {
      this.drop(reason, state.identity, { disconnectAtMs: this.now() - state.startedAt })
    }
    this.streams.clear()
    this.terminalGenerations.clear()
  }

  metrics(state) {
    const now = this.now()
    return {
      ttftMs: state.firstAnswerAt === null ? null : state.firstAnswerAt - state.startedAt,
      firstProgressMs: state.firstProgressAt === null
        ? null : state.firstProgressAt - state.startedAt,
      firstAnswerMs: state.firstAnswerAt === null
        ? null : state.firstAnswerAt - state.startedAt,
      totalMs: now - state.startedAt,
    }
  }

  drop(reason, identity, detail = {}) {
    this.log.warn?.('task.stream.frame_dropped', { ...identity, reason, ...detail })
  }
}
