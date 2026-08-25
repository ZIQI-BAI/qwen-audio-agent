function clean(value) {
  return String(value || '').trim()
}

function bounded(value, max = 300) {
  return clean(value).replace(/\s+/g, ' ').slice(0, max)
}

const SENSITIVE = /(?:system[_ -]?prompt|hidden[_ -]?context|api[_ -]?key|access[_ -]?token|authorization|cookie|secret|password|private[_ -]?key)/i

function safeText(value, max = 4_000) {
  const text = typeof value === 'string' ? value : ''
  if (!text || SENSITIVE.test(text)) return ''
  return text
    .replace(/<\/?(?:system|developer|hidden_context)\b[^>]*>/gi, '')
    .slice(0, max)
}

/** Project only explicit ACP output. It never synthesizes model reasoning. */
export function progressFromUpdate(update, state = {}) {
  const sourceSeq = Number(update?.seq ?? update?.sequence)
  if (Number.isFinite(sourceSeq)) {
    if (sourceSeq <= (state.sourceSeq ?? -1)) return null
    state.sourceSeq = sourceSeq
  }
  const kind = clean(update?.sessionUpdate)
  let category = ''
  let text = ''
  if (kind === 'agent_thought_chunk' || kind === 'reasoning_chunk') {
    category = 'reasoning'
    text = safeText(update?.content?.text)
  } else if (kind === 'agent_message_chunk') {
    category = 'answer'
    text = safeText(update?.content?.text)
  } else if (kind === 'plan') {
    category = 'progress'
    const entries = Array.isArray(update.entries) ? update.entries : []
    text = safeText(entries.find(entry => entry?.status === 'in_progress')?.content
      || entries.find(entry => entry?.status === 'pending')?.content)
  } else if (['tool_call', 'tool_call_update'].includes(kind)) {
    category = 'tool'
    text = safeText(update.title || update.name || update.status, 500)
  }
  if (!category || !text) return null
  state.seq = (state.seq ?? 0) + 1
  const fingerprint = `${category}:${text}`
  if (fingerprint === state.fingerprint) return null
  state.fingerprint = fingerprint
  return { category, seq: state.seq, text }
}

export function coordinatorKey(ownerId, protocol) {
  return `${protocol}:${encodeURIComponent(clean(ownerId) || 'personal')}:backend`
}

export function projectSessionKey(protocol, sessionId) {
  return `${protocol}:${clean(sessionId)}`
}

export function parseCoordinatorPayload(content) {
  let candidate = clean(content)
  for (let depth = 0; depth < 3 && candidate; depth += 1) {
    candidate = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
      || candidate
    try {
      const parsed = JSON.parse(candidate)
      if (typeof parsed === 'string') {
        candidate = clean(parsed)
        continue
      }
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      const start = candidate.indexOf('{')
      const end = candidate.lastIndexOf('}')
      if (start < 0 || end <= start) return null
      const objectCandidate = candidate.slice(start, end + 1)
      if (objectCandidate === candidate) return null
      candidate = objectCandidate
    }
  }
  return null
}

export function normalizeCoordinatorContent(content) {
  const text = clean(content)
  const parsed = parseCoordinatorPayload(text)
  if (!parsed) return text
  const inline = parsed?.presentation?.inline
  if (typeof inline === 'string') {
    parsed.presentation.inline = clean(inline)
      ? {
          title: 'Agent 结果',
          format: 'markdown',
          content: inline,
        }
      : null
  }
  return JSON.stringify(parsed)
}

export function coordinatorPresentation(content) {
  const presentation = parseCoordinatorPayload(content)?.presentation
  if (!presentation || typeof presentation !== 'object') return null
  return {
    speech: clean(presentation.speech),
    inline: presentation.inline && typeof presentation.inline === 'object'
      ? presentation.inline
      : null,
  }
}

export function sessionSummary(session) {
  return {
    session_id: clean(session?.sessionId),
    title: bounded(session?.title, 160),
    directory: clean(session?.cwd),
    updated_at: clean(session?.updatedAt),
  }
}

function categoryForTool(update) {
  const hint = [
    update?.name,
    update?.title,
    JSON.stringify(update?.rawInput || {}),
  ].join(' ').toLowerCase()
  if (/image|draw|canvas|图片|图像|绘图/.test(hint)) return 'image'
  if (/search|web|fetch|browser|搜索|查询/.test(hint)) return 'search'
  if (/read|glob|grep|list|读取|查找/.test(hint)) return 'read'
  if (/write|edit|patch|写入|修改/.test(hint)) return 'write'
  return 'run'
}

export function activityFromUpdate(update, known = new Map()) {
  if (update?.sessionUpdate === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : []
    const completed = entries.filter(entry => entry?.status === 'completed').length
    const current = entries.find(entry => entry?.status === 'in_progress')
      || entries.find(entry => entry?.status === 'pending')
    return {
      id: 'acp-plan',
      kind: 'plan',
      status: current ? 'running' : 'completed',
      detail: bounded(current?.content || ''),
      completed,
      total: entries.length,
    }
  }
  if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
    if (update?.sessionUpdate === 'agent_message_chunk') {
      return { id: null, kind: 'text', status: 'running' }
    }
    return null
  }
  const id = clean(update.toolCallId)
  const merged = {
    ...(known.get(id) || {}),
    ...update,
  }
  const activity = {
    id: id || null,
    kind: 'tool',
    tool: bounded(merged.name || merged.title, 100) || 'tool',
    label: bounded(
      merged.rawInput?.description
      || merged.title
      || '',
      160,
    ),
    status: merged.status || 'running',
    category: categoryForTool(merged),
    detail: bounded(
      merged.rawInput?.description
      || merged.rawInput?.query
      || merged.rawInput?.path
      || merged.rawInput?.command
      || '',
    ),
  }
  if (id && ['completed', 'failed'].includes(merged.status)) known.delete(id)
  else if (id) known.set(id, merged)
  return activity
}

export function nativeToolOutput(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      return nativeToolOutput(JSON.parse(value))
    } catch {
      return {}
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = nativeToolOutput(item)
      if (Object.keys(parsed).length) return parsed
    }
    return {}
  }
  if (typeof value !== 'object') return {}
  if (
    value.childSessionKey
    || value.sessionKey
    || value.sessionId
    || value.session_id
  ) return value
  const details = nativeToolOutput(value.details)
  if (Object.keys(details).length) return details
  for (const block of Array.isArray(value.content) ? value.content : []) {
    const parsed = nativeToolOutput(block?.text || block?.content || block)
    if (Object.keys(parsed).length) return parsed
  }
  return {}
}
