function limit(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// Why a task may not start yet. Emitted verbatim in `task.start_blocked` log
// records so an operator can grep one token instead of reading the scheduler.
export const START_ALLOWED = 'allowed'
export const START_BLOCKED_GLOBAL = 'global_concurrency'
export const START_BLOCKED_OWNER = 'owner_concurrency'
export const START_BLOCKED_LANE = 'lane_limit'

function describeHolder(task, now) {
  const startedAt = Number(task.startedAt) || null
  return {
    taskId: task.id,
    kind: task.kind || 'work',
    ownerId: task.ownerId,
    laneKey: task.laneKey || null,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    heldMs: startedAt ? now - startedAt : null,
    objective: String(task.objective || '').slice(0, 80),
  }
}

export class TaskScheduler {
  constructor({
    maxConcurrent = 4,
    maxConcurrentPerOwner = 2,
  } = {}) {
    this.maxConcurrent = limit(maxConcurrent, 4)
    this.maxConcurrentPerOwner = limit(maxConcurrentPerOwner, 2)
    this.active = new Map()
  }

  count(predicate) {
    let total = 0
    for (const task of this.active.values()) {
      if (predicate(task)) total += 1
    }
    return total
  }

  filter(predicate) {
    return [...this.active.values()].filter(predicate)
  }

  /**
   * Same decision as canStart(), but says which constraint refused and who is
   * currently holding the contended slot. ESS-977 burned 183 hours of queueing
   * because a bare `false` told nobody that one dead task owned the lane.
   */
  explain(task, now = Date.now()) {
    if (this.active.size >= this.maxConcurrent) {
      return {
        allowed: false,
        reason: START_BLOCKED_GLOBAL,
        current: this.active.size,
        limit: this.maxConcurrent,
        holders: this.filter(() => true).map(held => describeHolder(held, now)),
      }
    }
    const ownerHolders = this.filter(active => active.ownerId === task.ownerId)
    if (ownerHolders.length >= this.maxConcurrentPerOwner) {
      return {
        allowed: false,
        reason: START_BLOCKED_OWNER,
        ownerId: task.ownerId,
        current: ownerHolders.length,
        limit: this.maxConcurrentPerOwner,
        holders: ownerHolders.map(held => describeHolder(held, now)),
      }
    }
    if (!task.laneKey) return { allowed: true, reason: START_ALLOWED }
    const laneLimit = limit(task.laneLimit, 1)
    const laneHolders = this.filter(
      active => active.laneKey === task.laneKey,
    )
    if (laneHolders.length >= laneLimit) {
      return {
        allowed: false,
        reason: START_BLOCKED_LANE,
        laneKey: task.laneKey,
        current: laneHolders.length,
        limit: laneLimit,
        holders: laneHolders.map(held => describeHolder(held, now)),
      }
    }
    return { allowed: true, reason: START_ALLOWED }
  }

  canStart(task) {
    return this.explain(task).allowed
  }

  /** Point-in-time view of every occupied lane, for periodic health records. */
  laneSnapshot(now = Date.now()) {
    const lanes = new Map()
    for (const task of this.active.values()) {
      const key = task.laneKey || ''
      if (!key) continue
      if (!lanes.has(key)) lanes.set(key, [])
      lanes.get(key).push(describeHolder(task, now))
    }
    return [...lanes.entries()].map(([laneKey, holders]) => ({
      laneKey,
      holders,
      longestHeldMs: holders.reduce(
        (longest, holder) => Math.max(longest, holder.heldMs || 0),
        0,
      ),
    }))
  }

  acquire(task) {
    this.active.set(task.id, task)
  }

  release(task) {
    this.active.delete(task.id)
  }
}
