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
  deactivationRecord,
  releaseRecord,
} from '../src/voice/voice-ownership-log.mjs'
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
// ESS-974 replay: the superseded socket deactivates 5.53s after the newcomer
// won arbitration. The log alone must say which instanceId deactivated.
// ---------------------------------------------------------------------------

test('ESS-974 replay: deactivation names both instanceIds and the delay', () => {
  const clients = new ActiveVoiceClients()
  const records = []

  // Both sockets carry the identical label seen in production; only
  // instanceId can tell them apart.
  const makeClient = instanceId => {
    const client = {
      descriptor: {
        instanceId,
        type: 'web',
        label: 'watch-direct-gateway',
      },
      isAlive: () => true,
      deactivate(replacement) {
        records.push({
          event: 'voice_ownership.deactivated',
          ...deactivationRecord({
            descriptor: client.descriptor,
            replacement,
            // 5.53s after the claim, as measured in ESS-974.
            now: replacement.takeoverAt + 5_530,
            hadInput: true,
            hadOutput: true,
          }),
        })
      },
    }
    return client
  }

  const oldSocket = makeClient('inst_old_a1b2')
  const newSocket = makeClient('inst_new_c3d4')

  clients.activate('user_personal', oldSocket, { takeover: false })

  newSocket.takeoverId = 'vto_test'
  newSocket.takeoverAt = Date.now()
  const result = clients.activate('user_personal', newSocket, {
    takeover: true,
  })

  const claim = claimRecord({
    takeoverId: newSocket.takeoverId,
    takeover: true,
    result: { ...result, self: newSocket },
    incumbent: oldSocket,
    claimantDescriptor: newSocket.descriptor,
    enableInput: true,
    enableOutput: true,
  })

  // The claim side: who took over from whom.
  assert.equal(claim.granted, true)
  assert.equal(claim.reason, 'took_over')
  assert.equal(claim.claimant.instanceId, 'inst_new_c3d4')
  assert.equal(claim.incumbent.instanceId, 'inst_old_a1b2')
  assert.equal(claim.incumbentAlive, true)
  assert.equal(claim.evicted.instanceId, 'inst_old_a1b2')

  // The deactivate side: which instanceId went away, and how late.
  assert.equal(records.length, 1)
  const [deactivated] = records
  assert.equal(deactivated.evicted.instanceId, 'inst_old_a1b2')
  assert.equal(deactivated.replacedBy.instanceId, 'inst_new_c3d4')
  assert.equal(deactivated.elapsedSinceClaimMs, 5_530)
  // Correlates the two records without relying on label, which is identical.
  assert.equal(deactivated.takeoverId, claim.takeoverId)
  assert.notEqual(
    deactivated.evicted.instanceId,
    deactivated.replacedBy.instanceId,
  )
  assert.equal(deactivated.evicted.label, deactivated.replacedBy.label)
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
