import {
  VERBATIM_SPEECH_CLOSE_TAG,
  VERBATIM_SPEECH_OPEN_TAG,
} from './frontend-tools.mjs'

// Differences that a listener cannot hear. Punctuation and whitespace are not
// spoken, and a transcript renders them inconsistently for the same audio, so
// comparing them would report fidelity failures nobody experienced.
const IGNORED = new RegExp(
  '[\\s'
  + '\\u3000-\\u303f'   // CJK punctuation
  + '\\uff01-\\uff20'   // fullwidth punctuation
  + '\\uff3b-\\uff40'
  + '\\uff5b-\\uff65'
  + '\\u2010-\\u2027'   // dashes, quotes, ellipsis
  + '\\u2030-\\u205e'
  + '!-/:-@\\[-`{-~'    // ASCII punctuation
  + ']+',
  'gu',
)

/**
 * Normalize one utterance for comparison against the text it was asked to read.
 */
export function normalizeSpokenText(value) {
  return String(value || '')
    .replaceAll(VERBATIM_SPEECH_OPEN_TAG, '')
    .replaceAll(VERBATIM_SPEECH_CLOSE_TAG, '')
    .replace(IGNORED, '')
    .toLowerCase()
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
 * Per-connection ledger of terminal speech fidelity, keyed by the same delivery
 * identity the terminal frame carries.
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

  /** Record one spoken segment against the text it was asked to read. */
  record(identity, { expected, spoken }) {
    const key = TerminalSpeechFidelity.key(identity)
    const entry = this.entries.get(key)
      || { verbatim: true, segments: 0, divergences: [] }
    entry.segments += 1
    if (!isVerbatimSpeech(expected, spoken)) {
      entry.verbatim = false
      entry.divergences.push({ expected, spoken })
    }
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value)
    }
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
