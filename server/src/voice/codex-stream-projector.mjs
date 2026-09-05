const DEFAULT_MAX_CHARS = 120
const DEFAULT_WINDOW_MS = 350
const DEFAULT_MAX_PENDING = 3
const DEFAULT_MAX_FINISHED = 64

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
    maxFinished = DEFAULT_MAX_FINISHED,
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
    this.maxFinished = Math.max(1, maxFinished)
    this.streams = new Map()
    // Streams that already reached terminal. Their state is gone, so without
    // this ledger a late chunk for the same identity would silently open a
    // second stream and speak the same terminal answer again (ESS-1156).
    this.finished = new Map()
  }

  isFinished(identity) {
    return this.finished.has(keyOf(identity))
  }

  state(identity) {
    const key = keyOf(identity)
    let state = this.streams.get(key)
    if (!state) {
      state = {
        key, identity: { ...identity }, text: '', buffer: '', pending: [],
        sequence: 0, speaking: false, terminal: false, fallback: null,
        aborted: false, finished: false, timer: null,
        donePromise: null, resolveDone: null,
      }
      state.donePromise = new Promise(resolve => { state.resolveDone = resolve })
      this.streams.set(key, state)
    }
    return state
  }

  push(identity, chunk) {
    if (this.isFinished(identity)) return
    const state = this.state(identity)
    if (state.terminal) throw new Error('stream_already_terminal')
    if (state.fallback) return
    const text = String(chunk || '')
    if (!text) return
    state.text += text
    state.buffer += text
    this.flushReady(state)
  }

  fallback(identity, reason, chunk = '') {
    if (this.isFinished(identity)) return
    const state = this.state(identity)
    const text = String(chunk || '')
    state.text += text
    state.fallback ||= String(reason || 'projection_unavailable')
    state.buffer = ''
    state.pending = []
    if (state.timer) {
      this.clearTimer(state.timer)
      state.timer = null
    }
    this.onFallback({
      ...state.identity,
      streaming_fallback_reason: state.fallback,
      text: state.text,
    })
  }

  abort(identity, reason = 'task_cancelled') {
    const state = this.streams.get(keyOf(identity))
    if (!state) return false
    state.aborted = true
    state.terminal = true
    state.fallback ||= String(reason)
    state.buffer = ''
    state.pending = []
    if (state.timer) this.clearTimer(state.timer)
    state.timer = null
    this.finishIfDrained(state, { force: true })
    return true
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
        const outcome = await this.speak(text, { ...state.identity, sequence })
        if (state.aborted) break
        if (!outcome?.completed) {
          const reason = outcome?.status
            || outcome?.phase
            || (outcome?.cancelled ? 'cancelled' : '')
            || (outcome?.failed ? 'failed' : '')
            || 'speech_not_completed'
          throw new Error(reason)
        }
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
    const settled = this.finished.get(keyOf(identity))
    if (settled) return Promise.resolve(settled)
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

  finishIfDrained(state, { force = false } = {}) {
    if (state.finished) return
    if (!state.terminal || (!force && state.speaking) || state.pending.length) return
    state.finished = true
    const result = {
      ...state.identity,
      text: state.text,
      final_sequence: state.sequence - 1,
      streaming_fallback_reason: state.fallback,
      aborted: state.aborted,
    }
    this.finished.set(state.key, result)
    while (this.finished.size > this.maxFinished) {
      this.finished.delete(this.finished.keys().next().value)
    }
    this.onDone(result)
    state.resolveDone(result)
    this.streams.delete(state.key)
  }
}
