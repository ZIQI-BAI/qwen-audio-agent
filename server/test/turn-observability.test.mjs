import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import {
  START_BLOCKED_LANE,
  START_BLOCKED_OWNER,
  TaskScheduler,
} from '../src/task/task-scheduler.mjs'
import { ActiveVoiceClients } from '../src/voice/active-voice-clients.mjs'
import {
  claimRecord,
  releaseRecord,
} from '../src/voice/voice-ownership-log.mjs'
import { VoiceOwnershipTracker } from '../src/voice/voice-ownership-tracker.mjs'
import { ToolCallHandler } from '../src/voice/tools/tool-call-handler.mjs'

const HOUR = 3_600_000

function recordingLogger() {
  const records = []
  const push = level => (event, fields = {}, message = '') => {
    records.push({ level, event, ...fields, ...(message ? { message } : {}) })
  }
  return {
    records,
    find: event => records.filter(record => record.event === event),
    trace: push('trace'),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    fatal: push('fatal'),
  }
}

// ---------------------------------------------------------------------------
// ESS-977 replay: one dead task owns coordinator:user_personal for 183 hours
// and every later task queues forever. The log alone must name the holder and
// how long it has held.
// ---------------------------------------------------------------------------

test('ESS-977 replay: blocked start names the lane holder and its age', () => {
  const logger = recordingLogger()
  const manager = new TaskManager({ logger, laneStuckWarnMs: HOUR })
  const lane = 'coordinator:user_personal'

  const stuck = manager.create({
    objective: '检查用户今天的日程安排和待办事项',
    ownerId: 'user_personal',
    laneKey: lane,
    laneLimit: 1,
    runner: () => new Promise(() => {}),
  })
  // Start it so it actually occupies the lane, then backdate its start to the
  // 183 hours observed in production. The runner never settles, so it holds
  // the lane exactly like the production task did.
  manager.drain()
  const held = manager.tasks.get(stuck.id)
  assert.equal(held.status, 'running')
  held.startedAt = Date.now() - 183 * HOUR

  manager.create({
    objective: '查询杭州当前的天气情况',
    ownerId: 'user_personal',
    laneKey: lane,
    laneLimit: 1,
    runner: async () => '晴',
  })
  manager.drain()

  const blocked = logger.find('task.start_blocked')
  assert.ok(blocked.length >= 1, '必须留下 task.start_blocked 记录')
  const record = blocked.at(-1)

  // Which constraint refused, verbatim and greppable.
  assert.equal(record.reason, START_BLOCKED_LANE)
  assert.equal(record.laneKey, lane)
  assert.equal(record.limit, 1)
  assert.equal(record.current, 1)

  // Who holds it, and for how long — the two facts ESS-977 had to reconstruct
  // from `curl /api/tasks` plus `ps` plus three source files.
  assert.equal(record.holders.length, 1)
  assert.equal(record.holders[0].taskId, stuck.id)
  assert.match(record.holders[0].objective, /日程安排/)
  assert.ok(
    record.holders[0].heldMs >= 183 * HOUR,
    `heldMs 应体现 183 小时，实际 ${record.holders[0].heldMs}`,
  )

  // A holder past the stuck threshold must escalate above info so it surfaces
  // without anyone knowing to look for it.
  assert.equal(record.level, 'warn')
  assert.match(record.message, /小时/)

  // The blocked task is greppable by its own turn/task identity too.
  assert.match(record.objective, /杭州/)
  assert.equal(record.kind, 'work')

  manager.stopLaneSnapshots()
})

test('repeated drains do not re-log an unchanged block at info', () => {
  const logger = recordingLogger()
  const manager = new TaskManager({ logger, laneStuckWarnMs: HOUR })
  const lane = 'coordinator:user_personal'
  manager.create({
    objective: 'holder',
    ownerId: 'u',
    laneKey: lane,
    runner: () => new Promise(() => {}),
  })
  manager.create({
    objective: 'waiter',
    ownerId: 'u',
    laneKey: lane,
    runner: async () => 'x',
  })

  manager.drain()
  manager.drain()
  manager.drain()

  const loud = logger.find('task.start_blocked')
    .filter(record => record.level !== 'debug')
  assert.equal(loud.length, 1, '状态未变时不得重复刷 info')
  const quiet = logger.find('task.start_blocked')
    .filter(record => record.level === 'debug')
  assert.ok(quiet.length >= 1, '重复的拒绝仍应留 debug 痕迹')

  manager.stopLaneSnapshots()
})

test('lane snapshot reports the longest holder even while nothing queues', () => {
  const scheduler = new TaskScheduler()
  const now = Date.now()
  scheduler.acquire({
    id: 'work_a',
    ownerId: 'u',
    kind: 'work',
    laneKey: 'coordinator:user_personal',
    startedAt: now - 183 * HOUR,
    objective: '检查用户今天的日程安排',
  })

  const [lane] = scheduler.laneSnapshot(now)
  assert.equal(lane.laneKey, 'coordinator:user_personal')
  assert.equal(lane.holders[0].taskId, 'work_a')
  assert.ok(lane.longestHeldMs >= 183 * HOUR)
})

test('owner concurrency refusal is distinguishable from lane refusal', () => {
  const scheduler = new TaskScheduler({ maxConcurrentPerOwner: 1 })
  scheduler.acquire({
    id: 'work_a', ownerId: 'u', laneKey: 'lane_a', startedAt: Date.now(),
  })
  const decision = scheduler.explain({ ownerId: 'u', laneKey: 'lane_b' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, START_BLOCKED_OWNER)
  assert.equal(decision.holders[0].taskId, 'work_a')
})

// ---------------------------------------------------------------------------
// ESS-974 replay: the connection that lost arbitration is still alive 5.53s
// later. The two boundaries below are both real production events on two
// different connections, and the test never hands a record builder the delay
// it expects to read back — it advances a clock between two production calls.
//
//   A. voice_ownership.claim            — newcomer wins arbitration
//   B. voice_ownership.superseded_closed — evicted connection finally closes
//
// The synchronous deactivate() callback in between is NOT a boundary:
// ActiveVoiceClients.activate() invokes it inline, so it can only ever measure
// in-process arbitration cost. Reporting that as the takeover delay is the
// defect ESS-992 was filed for.
// ---------------------------------------------------------------------------

function fakeClock(start = 1_770_000_000_000) {
  let current = start
  const now = () => current
  now.advance = ms => {
    current += ms
    return current
  }
  return now
}

/**
 * Mirrors realtime-gateway.mjs's three ownership call sites: claim() on
 * voice.activate, noteSupersede() from the voiceClient.deactivate callback,
 * and release() on websocket close.
 */
function voiceConnection({ clients, logger, now, instanceId, lingerWarnMs = 1_000 }) {
  const descriptor = { instanceId, type: 'web', label: 'watch-direct-gateway' }
  const tracker = new VoiceOwnershipTracker({
    clients,
    ownerId: 'user_personal',
    logger,
    now,
    lingerWarnMs,
  })
  const client = {
    descriptor,
    isAlive: () => true,
    deactivate: replacement => tracker.noteSupersede(descriptor, replacement, {
      hadInput: true,
      hadOutput: true,
    }),
  }
  return {
    descriptor,
    tracker,
    claim: (options = {}) => tracker.claim(client, descriptor, options),
    // ws.send()'s completion callback for the `voice.deactivated` frame.
    flushDeactivate: (error = null) =>
      tracker.noteDeactivateFlushed(descriptor, { error }),
    release: (reason = 'socket_closed') =>
      tracker.release(client, descriptor, { reason }),
  }
}

test('ESS-974 replay: a superseded connection lingering 5530ms is measured end to end', () => {
  const logger = recordingLogger()
  const clients = new ActiveVoiceClients()
  const now = fakeClock()
  // Both connections carry the identical production label; only instanceId
  // tells them apart.
  const round2 = voiceConnection({ clients, logger, now, instanceId: 'inst_old_a1b2' })
  const round3 = voiceConnection({ clients, logger, now, instanceId: 'inst_new_c3d4' })

  round2.claim({ takeover: false })
  now.advance(30_000)
  round3.claim({ takeover: true })

  // The deactivate frame is written out promptly...
  round2.flushDeactivate()
  // ...but the connection itself is only gone 5.53s later, as in ESS-974
  // (02:19:25.089 supersede → 02:19:30.617).
  now.advance(5_530)
  round2.release('socket_closed')

  const [, claim] = logger.find('voice_ownership.claim')
  assert.equal(claim.granted, true)
  assert.equal(claim.reason, 'took_over')
  assert.equal(claim.claimant.instanceId, 'inst_new_c3d4')
  assert.equal(claim.incumbent.instanceId, 'inst_old_a1b2')
  assert.equal(claim.evicted.instanceId, 'inst_old_a1b2')

  // The synchronous callback measures arbitration, and says so: it is 0 even
  // though the takeover took 5.53s to settle.
  const [deactivated] = logger.find('voice_ownership.deactivated')
  assert.equal(deactivated.arbitrationLatencyMs, 0)
  assert.equal('elapsedSinceClaimMs' in deactivated, false)

  // Boundary B: the interval is derived by production code from the two event
  // timestamps, not supplied by this test.
  // The frame left the server immediately, so the 5.53s is not a server-side
  // write stall — that is the split this record exists to make.
  const [flushed] = logger.find('voice_ownership.deactivate_flushed')
  assert.equal(flushed.delivered, true)
  assert.equal(flushed.flushLatencyMs, 0)
  assert.equal(flushed.takeoverId, logger.find('voice_ownership.claim').at(-1).takeoverId)

  const [settled] = logger.find('voice_ownership.superseded_released')
  assert.equal(settled.supersededLingerMs, 5_530)
  assert.equal(settled.releaseReason, 'socket_closed')
  assert.equal(settled.evicted.instanceId, 'inst_old_a1b2')
  assert.equal(settled.replacedBy.instanceId, 'inst_new_c3d4')
  assert.equal(settled.evicted.label, settled.replacedBy.label)
  // A stable correlation id joins boundary A to boundary B, without relying on
  // the label, which is identical on both sides.
  assert.equal(settled.takeoverId, claim.takeoverId)
  assert.equal(
    new Date(settled.releasedAt) - new Date(settled.claimedAt),
    5_530,
  )
  // Both numbers on one line, so nobody reads the arbitration cost as the delay.
  assert.equal(settled.arbitrationLatencyMs, 0)
  // A lingering superseded connection is the ESS-974 failure shape and must
  // surface without anyone knowing to grep for it.
  assert.equal(settled.level, 'warn')
  assert.match(settled.message, /5530 毫秒/)
})

test('a takeover whose loser closes at once is not confused with a late one', () => {
  const logger = recordingLogger()
  const clients = new ActiveVoiceClients()
  const now = fakeClock()
  const incumbent = voiceConnection({ clients, logger, now, instanceId: 'inst_a' })
  const claimant = voiceConnection({ clients, logger, now, instanceId: 'inst_b' })

  incumbent.claim({ takeover: false })
  claimant.claim({ takeover: true })
  // No clock advance: the loser tears down inside the same tick.
  incumbent.flushDeactivate()
  incumbent.release('socket_closed')

  const [settled] = logger.find('voice_ownership.superseded_released')
  assert.equal(settled.supersededLingerMs, 0)
  // Identical arbitration cost as the 5530ms case above — which is precisely
  // why arbitration cost cannot be the signal. Only the linger separates them.
  assert.equal(settled.arbitrationLatencyMs, 0)
  assert.equal(settled.level, 'info')
  assert.equal(settled.message, undefined)
})

test('a connection that wins the slot back does not report a stale linger', () => {
  const logger = recordingLogger()
  const clients = new ActiveVoiceClients()
  const now = fakeClock()
  const first = voiceConnection({ clients, logger, now, instanceId: 'inst_a' })
  const second = voiceConnection({ clients, logger, now, instanceId: 'inst_b' })

  first.claim({ takeover: false })
  second.claim({ takeover: true })
  now.advance(120_000)
  // The evicted connection takes the slot back instead of dying.
  first.claim({ takeover: true })
  now.advance(60_000)
  first.release('socket_closed')

  assert.equal(logger.find('voice_ownership.superseded_released').length, 0)
})

test('a window closed by mute says mute, not socket close', () => {
  const logger = recordingLogger()
  const clients = new ActiveVoiceClients()
  const now = fakeClock()
  const incumbent = voiceConnection({ clients, logger, now, instanceId: 'inst_a' })
  const claimant = voiceConnection({ clients, logger, now, instanceId: 'inst_b' })

  incumbent.claim({ takeover: false })
  claimant.claim({ takeover: true })
  now.advance(5_530)
  // The gateway releases on mute too. Reporting that as a socket close would
  // make an operator draw the wrong conclusion about the connection's life.
  incumbent.release('mute')
  now.advance(90_000)
  incumbent.release('socket_closed')

  const settled = logger.find('voice_ownership.superseded_released')
  assert.equal(settled.length, 1)
  assert.equal(settled[0].supersededLingerMs, 5_530)
  assert.equal(settled[0].releaseReason, 'mute')
  assert.equal('closedAt' in settled[0], false)
  // The release records themselves still name every hand-back.
  assert.deepEqual(
    logger.find('voice_ownership.released').map(record => record.reason),
    ['mute', 'socket_closed'],
  )
})

test('a deactivate frame that takes 5530ms to write out is attributed to the write', () => {
  const logger = recordingLogger()
  const clients = new ActiveVoiceClients()
  const now = fakeClock()
  const incumbent = voiceConnection({ clients, logger, now, instanceId: 'inst_a' })
  const claimant = voiceConnection({ clients, logger, now, instanceId: 'inst_b' })

  incumbent.claim({ takeover: false })
  claimant.claim({ takeover: true })
  // Backpressured socket: ws.send's completion callback only fires 5.53s later.
  now.advance(5_530)
  incumbent.flushDeactivate()

  const [flushed] = logger.find('voice_ownership.deactivate_flushed')
  assert.equal(flushed.flushLatencyMs, 5_530)
  assert.equal(flushed.delivered, true)
  assert.equal(flushed.level, 'warn')
  assert.equal(flushed.evicted.instanceId, 'inst_a')
  assert.equal(flushed.replacedBy.instanceId, 'inst_b')
  assert.equal(
    flushed.takeoverId,
    logger.find('voice_ownership.claim').at(-1).takeoverId,
  )
})

test('a deactivate frame that never goes out is recorded as undelivered', () => {
  const logger = recordingLogger()
  const clients = new ActiveVoiceClients()
  const now = fakeClock()
  const incumbent = voiceConnection({ clients, logger, now, instanceId: 'inst_a' })
  const claimant = voiceConnection({ clients, logger, now, instanceId: 'inst_b' })

  incumbent.claim({ takeover: false })
  claimant.claim({ takeover: true })
  incumbent.flushDeactivate(new Error('socket_not_open'))

  const [flushed] = logger.find('voice_ownership.deactivate_flushed')
  assert.equal(flushed.delivered, false)
  assert.equal(flushed.error, 'socket_not_open')
  assert.equal(flushed.level, 'warn')
})

test('the write completion is reported even after the connection is gone', () => {
  const logger = recordingLogger()
  const clients = new ActiveVoiceClients()
  const now = fakeClock()
  const incumbent = voiceConnection({ clients, logger, now, instanceId: 'inst_a' })
  const claimant = voiceConnection({ clients, logger, now, instanceId: 'inst_b' })

  incumbent.claim({ takeover: false })
  claimant.claim({ takeover: true })
  // release() closes the linger window; the pending write is tracked apart
  // from it, so a late completion still lands.
  incumbent.release('socket_closed')
  now.advance(400)
  incumbent.flushDeactivate()

  assert.equal(logger.find('voice_ownership.superseded_released').length, 1)
  const [flushed] = logger.find('voice_ownership.deactivate_flushed')
  assert.equal(flushed.flushLatencyMs, 400)
})

test('a refused claim is logged as refused, not as a silent no-op', () => {
  const clients = new ActiveVoiceClients()
  const incumbent = {
    descriptor: { instanceId: 'inst_live', type: 'web', label: 'w' },
    isAlive: () => true,
    deactivate() {},
  }
  const claimant = {
    descriptor: { instanceId: 'inst_new', type: 'web', label: 'w' },
    isAlive: () => true,
    deactivate() {},
  }
  clients.activate('u', incumbent)
  const result = clients.activate('u', claimant, { takeover: false })

  const record = claimRecord({
    takeoverId: 'vto_x',
    takeover: false,
    result: { ...result, self: claimant },
    incumbent,
    claimantDescriptor: claimant.descriptor,
  })
  assert.equal(record.granted, false)
  assert.equal(record.reason, 'refused_live_incumbent')
  assert.equal(record.incumbent.instanceId, 'inst_live')
  assert.equal(record.incumbentAlive, true)
  assert.equal(record.evicted, null)
})

test('a dead incumbent is reported as dead rather than as a refusal', () => {
  const clients = new ActiveVoiceClients()
  const dead = {
    descriptor: { instanceId: 'inst_dead', type: 'web', label: 'w' },
    isAlive: () => false,
    deactivate() {},
  }
  const claimant = {
    descriptor: { instanceId: 'inst_new', type: 'web', label: 'w' },
    isAlive: () => true,
    deactivate() {},
  }
  clients.activate('u', dead)
  const result = clients.activate('u', claimant, { takeover: false })

  const record = claimRecord({
    takeoverId: 'vto_y',
    takeover: false,
    result: { ...result, self: claimant },
    incumbent: dead,
    claimantDescriptor: claimant.descriptor,
  })
  assert.equal(record.granted, true)
  assert.equal(record.incumbentAlive, false)
  assert.equal(record.evicted.instanceId, 'inst_dead')
})

test('releasing a socket that was already superseded says so', () => {
  const record = releaseRecord({
    descriptor: { instanceId: 'inst_old', type: 'web', label: 'w' },
    wasOwner: false,
  })
  assert.equal(record.wasOwner, false)
  assert.equal(record.holder.instanceId, 'inst_old')
})

// ---------------------------------------------------------------------------
// Response branch coverage: which exit flushDeferredToolResponse took, and
// whether ensureResponse was actually called.
// ---------------------------------------------------------------------------

function handlerWithLogger(logger, frontend = {}) {
  return new ToolCallHandler({
    logger,
    taskManager: new TaskManager(),
    ownerId: 'u',
    sessionId: 'main',
    transcripts: { record() {} },
    getFrontend: () => frontend,
    getTurnId: () => 'turn_1',
    getTurnGeneration: () => 0,
  })
}

test('a suppressed deferred batch records why ensureResponse was skipped', async () => {
  const logger = recordingLogger()
  let ensured = 0
  const handler = handlerWithLogger(logger, {
    ensureResponse: async () => { ensured += 1 },
  })

  handler.beginDeferredToolResponse('resp_1', { turnId: 'turn_1' })
  await handler.completeDeferredToolResponse('resp_1')
  await handler.finishToolResponse('resp_1', { suppressResponse: true })

  const flushes = logger.find('tool_response.flush')
  const final = flushes.at(-1)
  assert.equal(final.outcome, 'skipped_suppressed')
  assert.equal(final.ensureResponseCalled, false)
  assert.equal(ensured, 0)
  assert.equal(final.turnId, 'turn_1')
})

test('an unsuppressed deferred batch records the ensureResponse call', async () => {
  const logger = recordingLogger()
  let ensured = 0
  const handler = handlerWithLogger(logger, {
    ensureResponse: async () => { ensured += 1 },
  })

  handler.beginDeferredToolResponse('resp_2', { turnId: 'turn_2' })
  await handler.completeDeferredToolResponse('resp_2')
  await handler.finishToolResponse('resp_2', { suppressResponse: false })

  const final = logger.find('tool_response.flush').at(-1)
  assert.equal(final.outcome, 'ensure_response')
  assert.equal(final.ensureResponseCalled, true)
  assert.equal(ensured, 1)
})

test('a response with no deferred batch is distinguished from a suppression', async () => {
  const logger = recordingLogger()
  const handler = handlerWithLogger(logger)

  // This is the ESS-977 path: suppressResponse was never consulted at all.
  await handler.finishToolResponse('resp_unknown', { suppressResponse: true })

  const record = logger.find('tool_response.flush').at(-1)
  assert.equal(record.outcome, 'no_deferred_batch')
  assert.equal(record.ensureResponseCalled, false)
  assert.notEqual(record.outcome, 'skipped_suppressed')
})
