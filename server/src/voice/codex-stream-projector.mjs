const DEFAULT_MAX_CHARS = 120
const DEFAULT_WINDOW_MS = 350
const DEFAULT_MAX_PENDING = 3

function keyOf(value = {}) {
  return [value.requestId, value.turnId, value.taskId, value.generation]
    .map(item => String(item ?? ''))
    .join(':')
}

function sentenceBoundary(text) {
  const match = /[。！？!?；;.](?:[”’"']?)(?=\s|$|[\u4e00-\u9fff])/u.exec(text)
  return match ? match.index + match[0].length : -1
}

/**
 * Projects ordered ACP text chunks into bounded, serial speech segments.
 * The projector owns no provider state: callers supply `speak`, which makes it
 * independently testable and lets every realtime frontend retain its normal
 * response/audio framing.
 */
export class CodexStreamProjector {
  constructor({
    speak,
    onSegment = () => {},
    onDone = () => {},
    onFallback = () => {},
    maxChars = DEFAULT_MAX_CHARS,
    windowMs = DEFAULT_WINDOW_MS,
    maxPending = DEFAULT_MAX_PENDING,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (typeof speak !== 'function') throw new TypeError('speak is required')
    this.speak = speak
    this.onSegment = onSegment
    this.onDone = onDone
    this.onFallback = onFallback
    this.maxChars = Math.max(1, maxChars)
    this.windowMs = Math.max(1, windowMs)
    this.maxPending = Math.max(1, maxPending)
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.streams = new Map()
  }

  state(identity) {
    const key = keyOf(identity)
    let state = this.streams.get(key)
    if (!state) {
      state = {
        key, identity: { ...identity }, text: '', buffer: '', pending: [],
        sequence: 0, speaking: false, terminal: false, fallback: null,
        timer: null, donePromise: null, resolveDone: null,
      }
      state.donePromise = new Promise(resolve => { state.resolveDone = resolve })
      this.streams.set(key, state)
    }
    return state
  }

  push(identity, chunk) {
    const state = this.state(identity)
    if (state.terminal) throw new Error('stream_already_terminal')
    if (state.fallback) return
    const text = String(chunk || '')
    if (!text) return
    state.text += text
    state.buffer += text
    this.flushReady(state)
  }

  flushReady(state) {
    let boundary = sentenceBoundary(state.buffer)
    while (boundary > 0 || state.buffer.length >= this.maxChars) {
      const length = boundary > 0 ? boundary : this.maxChars
      this.enqueue(state, state.buffer.slice(0, length))
      state.buffer = state.buffer.slice(length)
      boundary = sentenceBoundary(state.buffer)
    }
    if (state.buffer && !state.timer) {
      state.timer = this.setTimer(() => {
        state.timer = null
        this.flushBuffer(state)
      }, this.windowMs)
      state.timer.unref?.()
    }
  }

  flushBuffer(state) {
    if (!state.buffer || state.fallback) return
    this.enqueue(state, state.buffer)
    state.buffer = ''
  }

  enqueue(state, text) {
    if (!text) return
    if (state.timer) {
      this.clearTimer(state.timer)
      state.timer = null
    }
    if (state.pending.length >= this.maxPending) {
      state.pending[state.pending.length - 1] += text
    } else {
      state.pending.push(text)
    }
    void this.drain(state)
  }

  async drain(state) {
    if (state.speaking || state.fallback) return
    state.speaking = true
    try {
      while (state.pending.length && !state.fallback) {
        const text = state.pending.shift()
        const sequence = state.sequence++
        this.onSegment({ ...state.identity, sequence, text })
        await this.speak(text, { ...state.identity, sequence })
      }
    } catch (error) {
      state.fallback = String(error?.message || error || 'projection_failed')
      state.pending = []
      this.onFallback({
        ...state.identity,
        streaming_fallback_reason: state.fallback,
        text: state.text,
      })
    } finally {
      state.speaking = false
      this.finishIfDrained(state)
    }
  }

  terminal(identity) {
    const state = this.state(identity)
    state.terminal = true
    if (state.timer) {
      this.clearTimer(state.timer)
      state.timer = null
    }
    this.flushBuffer(state)
    this.finishIfDrained(state)
    return state.donePromise
  }

  finishIfDrained(state) {
    if (!state.terminal || state.speaking || state.pending.length) return
    const result = {
      ...state.identity,
      text: state.text,
      final_sequence: state.sequence - 1,
      streaming_fallback_reason: state.fallback,
    }
    this.onDone(result)
    state.resolveDone(result)
    this.streams.delete(state.key)
  }
}
