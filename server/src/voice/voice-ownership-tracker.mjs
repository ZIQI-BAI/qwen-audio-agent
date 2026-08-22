import { randomUUID } from 'node:crypto'
import {
  claimRecord,
  deactivationRecord,
  releaseRecord,
  supersedeSettledRecord,
} from './voice-ownership-log.mjs'

/**
 * One connection's view of voice-ownership arbitration, plus the logging that
 * makes a takeover reconstructable from the log alone.
 *
 * It exists as a unit — rather than inline in the gateway's websocket handler —
 * so the ESS-974 sequence can be replayed against the production call path
 * without standing up a websocket server. `now` is the only seam: a replay
 * advances the clock between two real calls instead of handing a record
 * builder the delay it expects to see (ESS-992).
 *
 * All trackers for one owner share the ActiveVoiceClients registry, so the
 * claimant's tracker and the evicted connection's tracker are different
 * objects — which is exactly why the claim carries a `takeoverId` the evicted
 * side can quote back.
 */
export class VoiceOwnershipTracker {
  constructor({ clients, ownerId, logger, now = Date.now, lingerWarnMs = 0 }) {
    this.clients = clients
    this.ownerId = ownerId
    this.logger = logger
    this.now = now
    this.lingerWarnMs = Math.max(0, Number(lingerWarnMs) || 0)
    // Set while this connection has lost the slot but has not yet torn down.
    this.superseded = null
  }

  /**
   * Boundary A. `takeoverAt` is stamped before activate() because activate()
   * evicts the incumbent synchronously: the evicted side reads this claim
   * during the call.
   */
  claim(client, descriptor, {
    takeover = false,
    enableInput = true,
    enableOutput = true,
  } = {}) {
    const incumbent = this.clients.active(this.ownerId)
    client.takeoverId = `vto_${randomUUID()}`
    client.takeoverAt = this.now()
    const result = this.clients.activate(this.ownerId, client, { takeover })
    // Winning the slot back closes any earlier eviction of this connection:
    // its later close belongs to this claim, not to the one it lost.
    if (result.granted) this.superseded = null
    this.logger.info('voice_ownership.claim', claimRecord({
      takeoverId: client.takeoverId,
      takeover,
      result: { ...result, self: client },
      incumbent,
      claimantDescriptor: descriptor,
      enableInput,
      enableOutput,
    }))
    return result
  }

  /**
   * Called from the evicted connection's deactivate() callback, i.e. inline
   * inside somebody else's claim(). Records the arbitration itself and opens
   * the window that release() closes.
   */
  noteSupersede(descriptor, replacement, { hadInput = false, hadOutput = false } = {}) {
    const record = deactivationRecord({
      descriptor,
      replacement,
      now: this.now(),
      hadInput,
      hadOutput,
    })
    this.logger.info('voice_ownership.deactivated', record)
    this.superseded = {
      takeoverId: record.takeoverId,
      claimedAt: replacement?.takeoverAt ?? null,
      replacedBy: record.replacedBy,
      arbitrationLatencyMs: record.arbitrationLatencyMs,
      hadInput,
      hadOutput,
    }
    return record
  }

  /**
   * Boundary B when this connection had been superseded. Idempotent: the
   * gateway releases on both mute and close, and only the first one after an
   * eviction closes the window.
   */
  release(client, descriptor) {
    const released = this.clients.release(this.ownerId, client)
    this.logger.info(
      'voice_ownership.released',
      releaseRecord({ descriptor, wasOwner: released }),
    )
    const superseded = this.superseded
    if (!superseded) return released
    this.superseded = null
    const record = supersedeSettledRecord({
      descriptor,
      superseded,
      closedAt: this.now(),
    })
    // A superseded connection that lingers is the ESS-974 failure shape, so it
    // must surface without anyone knowing to grep for it.
    const late = this.lingerWarnMs > 0
      && record.supersededLingerMs !== null
      && record.supersededLingerMs >= this.lingerWarnMs
    const emit = late ? this.logger.warn : this.logger.info
    emit.call(
      this.logger,
      'voice_ownership.superseded_closed',
      record,
      late
        ? `被替换的连接在失去所有权 ${record.supersededLingerMs} 毫秒后才关闭`
        : '',
    )
    return released
  }
}
