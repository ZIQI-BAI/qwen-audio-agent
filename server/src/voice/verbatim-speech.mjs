/**
 * Verbatim speech verification for a task's authoritative final answer.
 *
 * ESS-1165: the terminal answer used to be rendered by asking the realtime
 * model to "say this naturally". A real DashScope realtime model does not
 * honour that as a text-to-speech instruction — it keeps behaving like a
 * conversation participant. Two failure modes were captured on the real chain:
 *
 *   weather   2 projected segments -> the model spoke the first one, then
 *             rewrote the second into a second complete answer (heard 2x)
 *   knowledge 4 projected segments -> the model ignored all four and spoke
 *             progress filler ("正在查找，请稍候") instead (answer heard 0x)
 *
 * Neither is a claim/idempotency problem, so ESS-1156's delivery ownership
 * could not catch them: the identity was claimed exactly once, and the words
 * that reached the ear were still wrong. Correctness of the final answer must
 * therefore never depend on what the model chooses to say. The gateway holds
 * the rendered audio, compares the model's own transcript against the
 * authoritative `resultMetadata.presentation.speech`, and only releases audio
 * that matches.
 */

// Punctuation, quoting and whitespace are rendering choices a TTS pass may
// legitimately normalise; they carry no meaning for "did it say the answer".
// Everything else — words, numbers, order — must match exactly.
const IGNORED_CHARACTERS = new RegExp(
  '[\\s\\p{P}\\p{S}]+',
  'gu',
)

export const VERBATIM_SPEECH_ATTEMPTS = 2

/**
 * Reduces a rendered utterance to the characters that decide whether the
 * answer was actually spoken. Case folding keeps latin fragments (unit names,
 * product names) from failing on capitalisation alone.
 */
export function normalizeSpeech(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(IGNORED_CHARACTERS, '')
    .toLowerCase()
}

/**
 * Classifies how a rendered utterance diverges from the text it was asked to
 * read. Returns `null` when the rendering is faithful.
 *
 * The classification is what makes a failure actionable in the logs and in the
 * downlink `streaming_fallback_reason`; the delivery decision itself only
 * needs "faithful or not".
 */
export function classifyVerbatimDivergence(intended, spoken) {
  const want = normalizeSpeech(intended)
  const got = normalizeSpeech(spoken)
  if (!want) return null
  if (!got) return 'speech_missing'
  if (got === want) return null
  // The model kept the answer but appended or prefixed its own words. This is
  // the weather failure: segment 2 came back as a whole restated answer.
  if (got.includes(want)) return 'speech_expanded'
  // The model stopped early, or read only part of what it was given.
  if (want.includes(got)) return 'speech_truncated'
  return 'speech_rewritten'
}

/**
 * Verdict for one rendering attempt. `ok` is the only thing the delivery path
 * branches on; the rest is evidence for the log and the downlink frame.
 */
export function verbatimVerdict(intended, spoken) {
  const reason = classifyVerbatimDivergence(intended, spoken)
  return {
    ok: reason === null,
    reason,
    intendedLength: normalizeSpeech(intended).length,
    spokenLength: normalizeSpeech(spoken).length,
  }
}
