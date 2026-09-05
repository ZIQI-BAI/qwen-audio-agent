const DEFAULT_MAX_TRACKED = 256
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 20_000

/**
 * Terminal delivery identity. A task may legitimately produce a second
 * terminal answer after a rerun, which bumps `streamGeneration`; the same task
 * and generation must never be delivered twice.
 */
export function terminalDeliveryKey(identity = {}) {
  return [
    identity.sessionId,
    identity.taskId ?? identity.requestId,
    Number.isInteger(identity.generation) ? identity.generation : 1,
  ].map(item => String(item ?? '')).join(':')
}

/**
 * Owns the invariant "a completed task's terminal answer reaches the user
 * exactly once" for one realtime connection.
 *
 * A finished task can reach the voice surface through two independent
 * channels: the streamed task projection (`CodexStreamProjector` →
 * `task.stream` text/audio segments) and the notification announcement
 * (`AnnouncementManager` → `frontend.injectResult`). `TaskManager#complete`
 * emits `task.completed` and `task.notification.pending` in the same tick, so
 * the announcement surface used to claim a task whose answer the projection
 * was still streaming and speak that very same answer a second time. Worse,
 * the announcement injects the whole result as a conversation item, after
 * which every remaining projector segment made the model re-speak the whole
 * answer instead of the segment (ESS-1156: weather 2×, knowledge 4×).
 *
 * The streamed channel therefore claims the notification synchronously, in
 * the same tick as `task.completed`, and keeps the claim alive until every
 * segment has drained. Deduplication is keyed on delivery identity, never on
 * the answer text: two runs may legitimately produce the same words.
 */
export class TaskTerminalDelivery {
  constructor({
    claim,
    release,
    markDelivered,
    renew = () => {},
    leaseRenewIntervalMs = DEFAULT_LEASE_RENEW_INTERVAL_MS,
    maxTracked = DEFAULT_MAX_TRACKED,
    setTimer = setInterval,
    clearTimer = clearInterval,
    log = {},
  } = {}) {
    if (typeof claim !== 'function') throw new TypeError('claim is required')
    if (typeof release !== 'function') throw new TypeError('release is required')
    if (typeof markDelivered !== 'function') {
      throw new TypeError('markDelivered is required')
    }
    this.claim = claim
    this.release = release
    this.markDelivered = markDelivered
    this.renew = renew
    this.leaseRenewIntervalMs = Math.max(1000, leaseRenewIntervalMs)
    this.maxTracked = Math.max(1, maxTracked)
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.log = log
    this.projected = new Set()
    this.streaming = new Map()
    this.closed = false
  }

  /**
   * Marks this terminal delivery identity as claimed by this connection.
   * Returns false when the same task and stream generation already produced a
   * terminal answer here, so the caller drops the repeat instead of replaying
   * the answer.
   */
  begin(identity) {
    const key = terminalDeliveryKey(identity)
    if (this.projected.has(key)) {
      this.log.warn?.('task.terminal_delivery_repeated', {
        ...identity,
        reason: 'already_projected',
      })
      return false
    }
    this.projected.add(key)
    while (this.projected.size > this.maxTracked) {
      const oldest = this.projected.values().next().value
      this.projected.delete(oldest)
    }
    return true
  }

  /**
   * Hands this task's notification to the streamed channel before any other
   * surface can take it, and keeps the claim's lease alive while the segments
   * drain — a long answer can stream for longer than the claim TTL, and an
   * expired claim would let the announcement surface speak the answer again.
   */
  claimStream(identity) {
    const key = terminalDeliveryKey(identity)
    if (this.closed || this.streaming.has(key)) return []
    const taskIds = this.claim([identity.taskId]).map(task => task.id)
    if (!taskIds.length) return []
    const timer = this.setTimer(
      () => this.renew(taskIds),
      this.leaseRenewIntervalMs,
    )
    timer.unref?.()
    this.streaming.set(key, { taskIds, timer })
    return taskIds
  }

  /**
   * Settles a streamed terminal delivery. `delivered` confirms the streamed
   * speech as the notification delivery; otherwise the claim goes back to
   * pending so the announcement surface can still deliver the result.
   */
  settle(identity, { delivered }) {
    const key = terminalDeliveryKey(identity)
    const entry = this.streaming.get(key)
    if (!entry) return []
    this.streaming.delete(key)
    this.clearTimer(entry.timer)
    if (delivered) this.markDelivered(entry.taskIds)
    else this.release(entry.taskIds)
    return entry.taskIds
  }

  /**
   * Releases every in-flight streamed claim. The socket is gone, so its
   * segments will never finish; the result must stay deliverable elsewhere.
   */
  close() {
    this.closed = true
    for (const entry of this.streaming.values()) {
      this.clearTimer(entry.timer)
      this.release(entry.taskIds)
    }
    this.streaming.clear()
    this.projected.clear()
  }
}
