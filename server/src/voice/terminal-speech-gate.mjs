import { isVerbatimSpeech } from './terminal-speech-fidelity.mjs'

/**
 * Holds a task answer's downlink until the answer has been verified.
 *
 * A realtime model streams audio while it generates, so by the time its
 * transcript can be compared with the text it was asked to read, the listener
 * has already heard whatever it decided to say. Checking afterwards only labels
 * a delivery that already happened — ESS-1165 review rejected exactly that.
 *
 * The gate closes the window: every frame a listener would perceive (audio,
 * transcript, the response's audio.done) is buffered here instead of being
 * sent. On `settle` the utterance is compared with the expected text, and the
 * buffer is either released in order or dropped whole. A dropped utterance
 * never reached the client, so retrying it cannot duplicate the answer.
 */
export class TerminalSpeechGate {
  constructor({ send, log = {} } = {}) {
    if (typeof send !== 'function') throw new TypeError('send is required')
    this.send = send
    this.log = log
    this.gates = new Map()
  }

  /** Begin holding the downlink of `responseId`. Idempotent. */
  open(responseId, { expected, identity } = {}) {
    if (!responseId || this.gates.has(responseId)) return false
    this.gates.set(responseId, {
      responseId,
      identity: { ...identity },
      expected: String(expected || ''),
      frames: [],
      audioFrames: 0,
      verdict: null,
      spoken: '',
    })
    return true
  }

  isOpen(responseId) {
    return this.gates.has(responseId)
  }

  /**
   * Buffer one frame if its response is gated. Returns true when the frame was
   * held, so callers can fall through to their ordinary send otherwise.
   */
  hold(responseId, frame) {
    const gate = this.gates.get(responseId)
    if (!gate) return false
    gate.frames.push(frame)
    if (frame?.type === 'audio.delta') gate.audioFrames += 1
    return true
  }

  /**
   * Did this utterance carry audio?
   *
   * A transcript alone is not a delivery anyone heard, so callers use this to
   * keep a text-only response from counting as spoken (ESS-1168).
   */
  audible(responseId) {
    return (this.gates.get(responseId)?.audioFrames || 0) > 0
  }

  /** Compare what was said with what was asked, without releasing anything. */
  settle(responseId, { spoken } = {}) {
    const gate = this.gates.get(responseId)
    if (!gate) return null
    gate.spoken = String(spoken || '')
    gate.verdict = isVerbatimSpeech(gate.expected, gate.spoken)
    return gate.verdict
  }

  /** true / false once settled, null while the utterance is still open. */
  verdict(responseId) {
    return this.gates.get(responseId)?.verdict ?? null
  }

  divergence(responseId) {
    const gate = this.gates.get(responseId)
    if (!gate || gate.verdict !== false) return null
    return { expected: gate.expected, spoken: gate.spoken }
  }

  /** Flush the held frames in arrival order and stop gating the response. */
  release(responseId) {
    const gate = this.gates.get(responseId)
    if (!gate) return 0
    this.gates.delete(responseId)
    for (const frame of gate.frames) this.send(frame)
    return gate.frames.length
  }

  /**
   * Drop the held frames. Nothing was ever sent, so the client has no audio,
   * no transcript and no audio.done for this response to reconcile.
   */
  discard(responseId, reason = 'speech_not_verbatim') {
    const gate = this.gates.get(responseId)
    if (!gate) return 0
    this.gates.delete(responseId)
    this.log.warn?.('task.stream.speech_discarded', {
      ...gate.identity,
      responseId,
      reason,
      frames: gate.frames.length,
      expected: gate.expected,
      spoken: gate.spoken,
    })
    return gate.frames.length
  }

  /** Discard everything still held, e.g. when the socket goes away. */
  close(reason = 'socket_closed') {
    for (const responseId of [...this.gates.keys()]) {
      this.discard(responseId, reason)
    }
  }
}
