/**
 * Record builders for voice-ownership transitions.
 *
 * Kept out of realtime-gateway.mjs so the ESS-974 supersede/deactivate
 * sequence can be replayed in a test without standing up a WebSocket server.
 */

/**
 * Identity of one side of an ownership transition.
 *
 * instanceId is the only field with real discriminating power: every deployed
 * client currently reports the same label ('watch-direct-gateway'), so a record
 * carrying label alone cannot tell two sockets apart — which is exactly why
 * ESS-974 could measure a 5.5s deactivate delay but not attribute it.
 */
export function ownershipParty(descriptor) {
  if (!descriptor) return null
  return {
    instanceId: descriptor.instanceId || null,
    type: descriptor.type || null,
    label: descriptor.label || null,
  }
}

export function claimRecord({
  takeoverId,
  takeover,
  result,
  incumbent,
  claimantDescriptor,
  enableInput,
  enableOutput,
}) {
  const contested = incumbent && incumbent !== result?.self
  return {
    takeoverId: takeoverId || null,
    takeover: Boolean(takeover),
    granted: Boolean(result?.granted),
    claimant: ownershipParty(claimantDescriptor),
    // Separates "no incumbent" from "incumbent refused us" from "incumbent was
    // already dead and skipped" — all three were indistinguishable before.
    incumbent: contested ? ownershipParty(incumbent.descriptor) : null,
    incumbentAlive: contested ? incumbent.isAlive?.() !== false : null,
    // activate() reports `previous` even when it refuses, so this must be
    // gated on granted — otherwise a refused claim would log an eviction that
    // never happened.
    evicted: result?.granted && result.previous
      ? ownershipParty(result.previous.descriptor)
      : null,
    reason: result?.granted
      ? (result.previous ? 'took_over' : 'claimed_free_slot')
      : 'refused_live_incumbent',
    enableInput: Boolean(enableInput),
    enableOutput: Boolean(enableOutput),
  }
}

export function deactivationRecord({
  descriptor,
  replacement,
  now,
  hadInput = false,
  hadOutput = false,
}) {
  return {
    takeoverId: replacement?.takeoverId || null,
    evicted: ownershipParty(descriptor),
    replacedBy: ownershipParty(replacement?.descriptor),
    // ActiveVoiceClients.activate() calls the loser's deactivate() inline
    // (active-voice-clients.mjs:21), so this is the in-process arbitration
    // cost and is ~0 by construction. It is NOT the ESS-974 takeover delay —
    // that one spans two connections and is measured by
    // supersedeSettledRecord() below. ESS-992 was filed because the two were
    // reported under one name.
    arbitrationLatencyMs: replacement?.takeoverAt
      ? now - replacement.takeoverAt
      : null,
    hadInput,
    hadOutput,
  }
}

/**
 * The `voice.deactivated` frame actually leaving this server.
 *
 * ActiveVoiceClients.activate() evicts inline, so the deactivate *callback*
 * can never be late. The deactivate *frame* can: ws.send()'s completion
 * callback only fires once the payload is written out, so a backpressured or
 * half-dead socket shows up here as seconds. This is the one deactivate-side
 * event that can legitimately carry the ESS-974 delay, and it splits the
 * question in two — a large `flushLatencyMs` puts the delay on this server, a
 * near-zero one puts it on the network or the client.
 *
 * It is a *write* completion, not a client receipt. Nothing server-side can
 * observe when the watch processed the frame.
 */
export function deactivateFlushedRecord({
  descriptor,
  superseded,
  flushedAt,
  error = null,
}) {
  const claimedAt = Number.isFinite(superseded?.claimedAt)
    ? superseded.claimedAt
    : null
  return {
    takeoverId: superseded?.takeoverId || null,
    evicted: ownershipParty(descriptor),
    replacedBy: superseded?.replacedBy || null,
    delivered: !error,
    error: error ? String(error.message || error) : null,
    flushedAt: new Date(flushedAt).toISOString(),
    flushLatencyMs: claimedAt === null ? null : flushedAt - claimedAt,
  }
}

/**
 * Closes the takeover out, on the evicted connection's own teardown.
 *
 * The two boundaries are both real production events, on two different
 * connections:
 *
 *   A. `voice_ownership.claim` stamps `takeoverAt` when the newcomer wins
 *      arbitration (realtime-gateway.mjs, before activate()).
 *   B. this record is written when the connection that lost the slot reaches
 *      release() — websocket close, an explicit mute, or the client dropping
 *      to text-only. `releaseReason` says which, because they are not the same
 *      claim about the socket's lifetime.
 *
 * B - A is `supersededLingerMs`: how long a superseded connection kept the
 * gateway's voice state alive after losing ownership. That is the window a
 * late `voice.deactivated` can arrive inside.
 */
export function supersedeSettledRecord({
  descriptor,
  superseded,
  releasedAt,
  releaseReason = 'unspecified',
}) {
  const claimedAt = Number.isFinite(superseded?.claimedAt)
    ? superseded.claimedAt
    : null
  return {
    // Same id as the claim record, so both ends of the window join on one grep.
    takeoverId: superseded?.takeoverId || null,
    evicted: ownershipParty(descriptor),
    replacedBy: superseded?.replacedBy || null,
    releaseReason,
    claimedAt: claimedAt === null ? null : new Date(claimedAt).toISOString(),
    releasedAt: new Date(releasedAt).toISOString(),
    supersededLingerMs: claimedAt === null ? null : releasedAt - claimedAt,
    // Carried along so one line shows both numbers: nobody can mistake the
    // synchronous arbitration cost for the cross-connection linger again.
    arbitrationLatencyMs: superseded?.arbitrationLatencyMs ?? null,
    hadInput: Boolean(superseded?.hadInput),
    hadOutput: Boolean(superseded?.hadOutput),
  }
}

export function releaseRecord({ descriptor, wasOwner }) {
  return {
    holder: ownershipParty(descriptor),
    // false means this socket was no longer the owner — it had already been
    // superseded, so the release is a no-op rather than a handover.
    wasOwner: Boolean(wasOwner),
  }
}
