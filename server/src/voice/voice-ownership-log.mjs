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
  now = Date.now(),
  hadInput = false,
  hadOutput = false,
}) {
  return {
    takeoverId: replacement?.takeoverId || null,
    evicted: ownershipParty(descriptor),
    replacedBy: ownershipParty(replacement?.descriptor),
    // Gap between the newcomer winning arbitration and this socket actually
    // tearing down. ESS-974 observed 5.53s here with no way to attribute it.
    elapsedSinceClaimMs: replacement?.takeoverAt
      ? now - replacement.takeoverAt
      : null,
    hadInput,
    hadOutput,
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
