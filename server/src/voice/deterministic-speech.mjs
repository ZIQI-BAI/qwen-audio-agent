import { config } from '../core/config.mjs'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Read a RIFF/WAVE container and return its PCM payload plus format.
 *
 * Only the fields the downlink contract cares about are validated. A container
 * that is not mono 16-bit PCM is rejected rather than reinterpreted: silently
 * playing a wrong-rate buffer would be a worse failure than no audio.
 */
export function decodeWav(buffer) {
  if (buffer.length < 12
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('合成音频不是 WAVE 容器')
  }
  let offset = 12
  let format = null
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (chunkId === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      }
    } else if (chunkId === 'data') {
      if (!format) throw new Error('合成音频缺少 fmt 段')
      return { ...format, pcm: buffer.subarray(body, body + size) }
    }
    // Chunks are word aligned.
    offset = body + size + (size % 2)
  }
  throw new Error('合成音频缺少 data 段')
}

/**
 * Deterministic text-to-speech for a task's final answer.
 *
 * This is the terminal recovery path: when the realtime model will not read the
 * answer as written, the answer is synthesized instead of being re-generated,
 * so the audio is a function of the text and nothing else. It is only ever
 * reached after the gated realtime attempts have been discarded unheard, so it
 * cannot duplicate an answer the listener already got.
 */
export class DeterministicSpeech {
  constructor({
    apiKey = config.dashscopeApiKey,
    baseUrl = config.deterministicTtsBaseUrl,
    model = config.deterministicTtsModel,
    voice = config.deterministicTtsVoice,
    sampleRate,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = {},
  } = {}) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.model = model
    this.voice = voice
    this.sampleRate = sampleRate
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
    this.log = log
  }

  get available() {
    return Boolean(this.apiKey && this.baseUrl && this.model)
  }

  async request(url, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Synthesize `text` into the downlink's PCM contract.
   * Returns `{ pcm, sampleRate }`, or throws with a reportable reason.
   */
  async synthesize(text) {
    const content = String(text || '').trim()
    if (!content) throw new Error('没有需要合成的文本')
    if (!this.available) throw new Error('确定性 TTS 未配置')

    const response = await this.request(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: { text: content, voice: this.voice },
      }),
    })
    if (!response.ok) {
      throw new Error(`确定性 TTS 请求失败：HTTP ${response.status}`)
    }
    const payload = await response.json()
    const audioUrl = payload?.output?.audio?.url
    const inlineData = payload?.output?.audio?.data
    let buffer
    if (inlineData) {
      buffer = Buffer.from(inlineData, 'base64')
    } else if (audioUrl) {
      const audio = await this.request(audioUrl, { method: 'GET' })
      if (!audio.ok) {
        throw new Error(`确定性 TTS 音频下载失败：HTTP ${audio.status}`)
      }
      buffer = Buffer.from(await audio.arrayBuffer())
    } else {
      throw new Error('确定性 TTS 没有返回音频')
    }

    const wav = decodeWav(buffer)
    // PCM only, and mono only: the downlink frames one interleaved-free stream.
    if (wav.audioFormat !== 1 || wav.bitsPerSample !== 16 || wav.channels !== 1) {
      throw new Error(
        `确定性 TTS 音频格式不符：format=${wav.audioFormat} `
        + `channels=${wav.channels} bits=${wav.bitsPerSample}`,
      )
    }
    if (this.sampleRate && wav.sampleRate !== this.sampleRate) {
      // Resampling is out of scope: a mismatch is reported so the caller falls
      // back to a text-only delivery instead of playing the answer at the
      // wrong pitch.
      throw new Error(
        `确定性 TTS 采样率不符：${wav.sampleRate} != ${this.sampleRate}`,
      )
    }
    return { pcm: wav.pcm, sampleRate: wav.sampleRate }
  }
}

/** Split PCM into base64 frames of whole samples, as the downlink expects. */
export function pcmFrames(pcm, { frameBytes = 9600 } = {}) {
  const size = Math.max(2, frameBytes - (frameBytes % 2))
  const frames = []
  for (let offset = 0; offset < pcm.length; offset += size) {
    frames.push(pcm.subarray(offset, offset + size).toString('base64'))
  }
  return frames
}
