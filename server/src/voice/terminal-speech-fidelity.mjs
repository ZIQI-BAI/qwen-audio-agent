import {
  VERBATIM_SPEECH_CLOSE_TAG,
  VERBATIM_SPEECH_OPEN_TAG,
} from './frontend-tools.mjs'

// Differences that a listener cannot hear. Punctuation and whitespace are not
// spoken, and a transcript renders them inconsistently for the same audio, so
// comparing them would report fidelity failures nobody experienced.
//
// The set is an explicit allowlist. Sweeping up the ASCII punctuation ranges
// instead also swallows `+ = % ~ : .` and every dash, and then `10+2=12` and
// `10212`, or `-3°C` and `3°C`, compare equal — a wrong number would be
// released as verbatim. Mathematical, unit and currency symbols therefore stay
// significant, and so does anything sitting next to a digit.
const IGNORABLE = new Set([
  ...'。．.，、,；;：:！!？?…‥·',
  ...'「」『』《》〈〉（）()［］[]｛｝{}【】',
  ...'“”‘’"\'`«»',
  ...'—–‒―-−~',
])

const DIGIT = /\p{Nd}/u

/**
 * True when the nearest non-whitespace neighbour in direction `step` is a
 * digit. Even ignorable punctuation carries the value there: a dash is a sign
 * or a range, a colon a time, a period a decimal.
 */
function touchesDigit(source, index, step) {
  for (let at = index + step; at >= 0 && at < source.length; at += step) {
    const character = source[at]
    if (/\s/u.test(character)) continue
    return DIGIT.test(character)
  }
  return false
}

/**
 * Normalize one utterance for comparison against the text it was asked to read.
 */
export function normalizeSpokenText(value) {
  const source = String(value || '')
    .replaceAll(VERBATIM_SPEECH_OPEN_TAG, '')
    .replaceAll(VERBATIM_SPEECH_CLOSE_TAG, '')
    .normalize('NFKC')
  let normalized = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (/\s/u.test(character)) continue
    if (
      IGNORABLE.has(character)
      && !touchesDigit(source, index, -1)
      && !touchesDigit(source, index, 1)
    ) continue
    normalized += character
  }
  return normalized.toLowerCase()
}

/**
 * Did the realtime model actually read the text it was handed?
 *
 * A delegated task's final answer is authoritative content, so the gateway
 * cannot take "the model was asked to read it" as proof that it did. ESS-1157
 * captured both failure directions on the real model: the weather answer was
 * reworded into a second full answer, and the knowledge answer was replaced
 * outright by "正在查找，请稍候". Both are caught here, on the transcript, and
 * reported on the task stream so a run can be judged from its frames instead of
 * by ear.
 */
export function isVerbatimSpeech(expected, spoken) {
  const want = normalizeSpokenText(expected)
  if (!want) return true
  return normalizeSpokenText(spoken) === want
}

/**
 * Per-connection ledger of how a task answer was delivered, keyed by the same
 * delivery identity the terminal frame carries.
 *
 * Only utterances that actually reached the client are recorded. Attempts the
 * gate discarded never happened downstream, so they appear here as divergences
 * — evidence for the log — but never as a delivery.
 */
export class TerminalSpeechFidelity {
  constructor({ maxEntries = 64 } = {}) {
    this.maxEntries = Math.max(1, maxEntries)
    this.entries = new Map()
  }

  static key(identity = {}) {
    return `${identity.sessionId || ''}:${identity.taskId || ''}:${
      identity.generation ?? 1
    }`
  }

  entry(identity) {
    const key = TerminalSpeechFidelity.key(identity)
    const existing = this.entries.get(key)
    if (existing) return existing
    const created = {
      segments: 0, silent: 0, divergences: [], delivered: null, delivery: null,
    }
    this.entries.set(key, created)
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value)
    }
    return created
  }

  /**
   * Record one segment.
   *
   * The verdict is about *audible* delivery, not about transcript agreement:
   * a response that agreed with the text but carried no audio was never heard,
   * so it is not a delivery (ESS-1168). A divergence is recorded as evidence
   * only — it was dropped before playback and nobody heard it either.
   */
  record(identity, { expected, spoken, audible = true }) {
    const entry = this.entry(identity)
    if (!isVerbatimSpeech(expected, spoken)) {
      entry.divergences.push({ expected, spoken })
      return entry
    }
    if (!audible) {
      entry.silent += 1
      return entry
    }
    entry.segments += 1
    entry.delivered = entry.delivered !== false
    entry.delivery ||= 'verbatim'
    return entry
  }

  /** Record a segment delivered by deterministic synthesis instead. */
  recordSynthesized(identity) {
    const entry = this.entry(identity)
    entry.segments += 1
    entry.delivered = entry.delivered !== false
    entry.delivery = 'synthesized'
    return entry
  }

  /**
   * Record that nothing audible carried this answer — the reading could not be
   * trusted, or the provider produced no audio at all. The task notification
   * must not be marked delivered on the strength of it.
   */
  recordUndelivered(identity) {
    const entry = this.entry(identity)
    entry.delivered = false
    entry.delivery = null
    return entry
  }

  /**
   * Verdict for a delivery. `null` means nothing was spoken under this identity
   * — a fallback or a text-only delivery — which is not a fidelity failure.
   */
  take(identity) {
    const key = TerminalSpeechFidelity.key(identity)
    const entry = this.entries.get(key)
    this.entries.delete(key)
    return entry || null
  }
}
