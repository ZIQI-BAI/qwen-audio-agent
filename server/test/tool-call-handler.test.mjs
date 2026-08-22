import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { ToolCallHandler } from '../src/voice/tools/tool-call-handler.mjs'
import { FrontendNotesStore } from '../src/conversation/frontend-notes.mjs'
import { SessionPermissionPolicy } from '../src/voice/session-permission-policy.mjs'
import { TurnTranscripts } from '../src/voice/tools/turn-transcripts.mjs'

function harness({
  coordinator,
  manager = new TaskManager(),
  memoryStore = null,
  notesStore = null,
  onMemoryChanged = () => {},
  backendAvailability = null,
  respondPermission,
  permissionPolicy,
  onPermissionDeliveryFailed,
  clientContext = {},
  requestClientState,
  inputAssets,
  getTurnId = () => 'turn-one',
} = {}) {
  const outputs = []
  const ensuredResponses = []
  const transcripts = new TurnTranscripts({ waitMs: 5 })
  const frontend = {
    sendFunctionOutput: async (...args) => outputs.push(args),
    ensureResponse: async (...args) => ensuredResponses.push(args),
  }
  const handler = new ToolCallHandler({
    taskManager: manager,
    ownerId: 'owner',
    sessionId: 'voice',
    transcripts,
    getFrontend: () => frontend,
    getTurnId,
    getTurnGeneration: () => 1,
    coordinator: coordinator || {
      run: async () => ({ content: '完成', metadata: {} }),
    },
    backendAvailability,
    memoryService: memoryStore,
    notesStore,
    onMemoryChanged,
    respondPermission,
    permissionPolicy,
    onPermissionDeliveryFailed,
    getClientContext: () => clientContext,
    requestClientState,
    inputAssets,
    getConversationContext: () => [
      { role: 'user', content: '之前在改首页' },
    ],
  })
  return { outputs, ensuredResponses, manager, transcripts, handler }
}

test('asks a capable client to enter sleep without creating another response', async () => {
  const states = []
  const kit = harness({
    clientContext: { states: ['sleeping'] },
    requestClientState: state => states.push(state),
  })

  await kit.handler.handle({
    call_id: 'call-hide',
    name: 'enter_sleep',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.deepEqual(states, ['sleeping'])
  assert.equal(kit.outputs[0][1].status, 'sleeping')
  assert.equal(kit.outputs[0][3].createResponse, false)
})

test('rejects sleep when the client did not advertise that state', async () => {
  const kit = harness()

  await kit.handler.handle({
    call_id: 'call-hide-unsupported',
    name: 'enter_sleep',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].error_code, 'unsupported_client_state')
})

async function permissionHarness({
  answer,
  authorizationId = 'auth-one',
  respondPermission,
  permissionPolicy,
  onPermissionDeliveryFailed,
}) {
  const manager = new TaskManager()
  let release
  const task = manager.create({
    objective: '执行等待授权的操作',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.permission.requested',
        permission: {
          id: authorizationId,
          status: 'pending',
          category: 'read',
          summary: '查看项目目录',
        },
      })
      return new Promise(resolve => { release = resolve })
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const kit = harness({
    manager,
    respondPermission,
    permissionPolicy,
    onPermissionDeliveryFailed,
  })
  kit.transcripts.record('turn-one', answer)
  return {
    ...kit,
    task,
    finish: async () => {
      release({ content: '完成' })
      await manager.wait(task.id)
    },
  }
}

test('submits one nonblocking coordinator work item with organized intent', async () => {
  let received
  const kit = harness({
    coordinator: {
      run: async input => {
        received = input
        return { content: '完成', metadata: {} }
      },
    },
  })
  kit.transcripts.record('turn-one', '继续改刚才那个页面')
  await kit.handler.handle({
    call_id: 'call-one',
    name: 'delegate_to_codex',
    arguments: JSON.stringify({ objective: '继续修改此前讨论的页面' }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].status, 'accepted')
  assert.match(
    kit.outputs[0][3].response.instructions,
    /如果此前已经说明正在处理.*直接结束本次响应/,
  )
  assert.match(
    kit.outputs[0][3].response.instructions,
    /accepted 或 duplicate 只代表任务已经提交/,
  )
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 1)
  await kit.manager.wait(kit.outputs[0][1].work_id)
  assert.equal(received.originalRequest, '继续改刚才那个页面')
  assert.equal(received.objective, '继续修改此前讨论的页面')
  assert.equal(received.conversationContext[0].content, '之前在改首页')
})

test('automatically carries current-turn attachments into spawned work', async () => {
  let received
  const kit = harness({
    coordinator: {
      run: async input => {
        received = input
        return { content: '完成', metadata: {} }
      },
    },
  })
  const image = {
    type: 'file',
    mime: 'image/png',
    filename: 'reference.png',
    url: 'data:image/png;base64,aGVsbG8=',
  }
  kit.transcripts.record('turn-one', '根据这张图生成皮肤')
  kit.transcripts.recordParts('turn-one', [image])
  await kit.handler.handle({
    call_id: 'call-image',
    name: 'delegate_to_codex',
    arguments: '{"objective":"根据参考图生成皮肤"}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  await kit.manager.wait(kit.outputs[0][1].work_id)
  assert.deepEqual(received.inputParts, [image])
})

test('resolves an earlier-turn input reference when the next turn delegates work', async () => {
  let received
  const historicalImage = {
    type: 'file',
    mime: 'image/png',
    filename: 'cat.png',
    url: 'data:image/png;base64,aGVsbG8=',
  }
  const kit = harness({
    inputAssets: {
      resolve: ({ ownerId, sessionId, refs }) => {
        assert.equal(ownerId, 'owner')
        assert.equal(sessionId, 'voice')
        assert.deepEqual(refs, ['input_1'])
        return [historicalImage]
      },
    },
    coordinator: {
      run: async input => {
        received = input
        return { content: '完成', metadata: {} }
      },
    },
  })
  kit.transcripts.record('turn-one', '分析刚才那张图片')

  await kit.handler.handle({
    call_id: 'call-historical-image',
    name: 'delegate_to_codex',
    arguments: JSON.stringify({
      objective: '分析用户此前提供的图片',
      input_refs: ['input_1'],
    }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  await kit.manager.wait(kit.outputs[0][1].work_id)
  assert.deepEqual(received.inputParts, [historicalImage])
})

test('asks for the attachment again when a referenced input has expired', async () => {
  const kit = harness({
    inputAssets: {
      resolve: () => { throw new Error('引用的输入已经失效') },
    },
  })
  kit.transcripts.record('turn-one', '分析刚才那张图片')

  await kit.handler.handle({
    call_id: 'call-expired-image',
    name: 'delegate_to_codex',
    arguments: JSON.stringify({
      objective: '分析用户此前提供的图片',
      input_refs: ['input_1'],
    }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].error_code, 'invalid_input_ref')
  assert.equal(kit.outputs[0][1].retryable, true)
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 0)
})

test('lets realtime avoid a repeated acknowledgement after speaking before delegation', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '给项目添加特殊食物')
  await kit.handler.handle({
    call_id: 'call-spoken-before-tool',
    name: 'delegate_to_codex',
    arguments: '{"objective":"给项目添加特殊食物"}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    hasAudio: true,
  })

  assert.equal(kit.outputs[0][1].status, 'accepted')
  assert.equal(kit.outputs[0][3].createResponse, undefined)
  assert.match(
    kit.outputs[0][3].response.instructions,
    /不要重复、改写或补充确认/,
  )
  await kit.manager.wait(kit.outputs[0][1].work_id)
})

test('deduplicates repeated tool calls from one realtime turn', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '执行一次')
  await kit.handler.handle({
    call_id: 'call-one',
    name: 'delegate_to_codex',
    arguments: '{"objective":"执行一次"}',
  })
  await kit.handler.handle({
    call_id: 'call-two',
    name: 'delegate_to_codex',
    arguments: '{"objective":"再执行一次"}',
  })
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 1)
  assert.equal(kit.outputs.at(-1)[1].status, 'duplicate')
  assert.equal(kit.outputs.at(-1)[3].createResponse, undefined)
  assert.match(
    kit.outputs.at(-1)[3].response.instructions,
    /不要再次调用工具/,
  )
})

test('rejects delegated work immediately when the backend is known to be down', async () => {
  const kit = harness({
    backendAvailability: {
      snapshot: () => ({ configured: true, ok: false, known: true }),
    },
  })
  kit.transcripts.record('turn-one', '帮我修改项目')
  await kit.handler.handle({
    call_id: 'call-offline',
    name: 'delegate_to_codex',
    arguments: '{"objective":"修改项目"}',
  })

  assert.equal(kit.outputs[0][1].error_code, 'backend_unavailable')
  assert.equal(kit.outputs[0][1].retryable, true)
  assert.match(kit.outputs[0][1].user_message, /当前未连接/)
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 0)
})

test('accepts optimistically before the first health probe and fails via the task', async () => {
  let probed = 0
  const kit = harness({
    backendAvailability: {
      snapshot: () => {
        probed += 1
        return { configured: true, ok: true, known: false }
      },
    },
    coordinator: {
      run: async () => {
        throw new Error('后台 Agent 未连接')
      },
    },
  })
  kit.transcripts.record('turn-one', '帮我修改项目')
  await kit.handler.handle({
    call_id: 'call-optimistic',
    name: 'delegate_to_codex',
    arguments: '{"objective":"修改项目"}',
  })

  // The receipt is optimistic; the dispatch failure surfaces on the task,
  // which the announcement path reports asynchronously.
  assert.equal(probed, 1)
  assert.equal(kit.outputs[0][1].status, 'accepted')
  await kit.manager.wait(kit.outputs[0][1].work_id)
  assert.equal(kit.manager.get(kit.outputs[0][1].work_id).status, 'failed')
})

test('hands out the acceptance receipt without waiting for the turn transcript', async () => {
  let received
  const kit = harness({
    coordinator: {
      run: async input => {
        received = input
        return { content: '完成', metadata: {} }
      },
    },
  })
  // No transcript is ever recorded: acceptance must not block on ASR and the
  // dispatch-time resolution falls back to the model-provided objective.
  await kit.handler.handle({
    call_id: 'call-no-transcript',
    name: 'delegate_to_codex',
    arguments: '{"objective":"整理会议纪要"}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].status, 'accepted')
  await kit.manager.wait(kit.outputs[0][1].work_id)
  assert.equal(received.originalRequest, '整理会议纪要')
  assert.equal(received.objective, '整理会议纪要')
})

test('keeps the verbatim request even when later turns evict the transcript', async () => {
  const requests = []
  let releaseFirst
  let currentTurn = 'turn-one'
  const kit = harness({
    getTurnId: () => currentTurn,
    coordinator: {
      run: async input => {
        requests.push(input.originalRequest)
        if (input.objective === '堆积任务') {
          return new Promise(resolve => {
            releaseFirst = () => resolve({ content: '完成', metadata: {} })
          })
        }
        return { content: '完成', metadata: {} }
      },
    },
  })
  // The first work blocks the owner FIFO lane so the second one queues.
  kit.transcripts.record('turn-one', '堆积任务')
  await kit.handler.handle({
    call_id: 'call-blocking',
    name: 'delegate_to_codex',
    arguments: '{"objective":"堆积任务"}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  kit.transcripts.record('turn-two', '把上周的周报发给老板')
  currentTurn = 'turn-two'
  await kit.handler.handle({
    call_id: 'call-queued',
    name: 'delegate_to_codex',
    arguments: '{"objective":"发送上周周报"}',
  }, { turnId: 'turn-two', turnGeneration: 1 })
  const queuedId = kit.outputs.at(-1)[1].work_id

  // While the lane is blocked, twenty-plus newer turns evict turn-two from
  // the transcript ring buffer. The pinned promise must retain the verbatim
  // request regardless.
  for (let index = 0; index < 25; index += 1) {
    kit.transcripts.record(`turn-filler-${index}`, `闲聊第 ${index} 句`)
  }
  releaseFirst()
  await kit.manager.wait(queuedId)

  assert.deepEqual(requests, ['堆积任务', '把上周的周报发给老板'])
})

test('explains that background work is unavailable without a configured backend', async () => {
  const kit = harness({
    backendAvailability: {
      snapshot: () => ({ configured: false, ok: false, known: true }),
    },
  })
  kit.transcripts.record('turn-one', '帮我修改项目')
  await kit.handler.handle({
    call_id: 'call-unconfigured',
    name: 'delegate_to_codex',
    arguments: '{"objective":"修改项目"}',
  })

  assert.equal(kit.outputs[0][1].error_code, 'backend_unavailable')
  assert.equal(kit.outputs[0][1].retryable, false)
  assert.match(kit.outputs[0][1].user_message, /未配置后台 Agent/)
  assert.match(
    kit.outputs[0][3].response.instructions,
    /未配置后台 Agent/,
  )
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 0)
})

test('does not turn a permission answer into a new background task', async () => {
  const kit = await permissionHarness({
    answer: '可以',
    respondPermission: async () => ({
      id: 'auth-one',
      workId: 'work-one',
      status: 'approved',
    }),
  })

  await kit.handler.handle({
    call_id: 'wrongly-delegated-permission-answer',
    name: 'delegate_to_codex',
    arguments: JSON.stringify({ objective: '可以' }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  const output = kit.outputs.at(-1)
  assert.equal(output[1].error_code, 'permission_decision_required')
  assert.equal(output[1].authorization_id, 'auth-one')
  assert.match(
    output[3].response.instructions,
    /respond_agent_permission/,
  )
  assert.equal(
    kit.manager.list({ ownerId: 'owner' }).filter(task => (
      task.objective === '可以'
    )).length,
    0,
  )
  await kit.finish()
})

test('deduplicates the same turn after a realtime handler reconnect', async () => {
  const manager = new TaskManager()
  let runs = 0
  const coordinator = {
    run: async () => {
      runs += 1
      return { content: '完成', metadata: {} }
    },
  }
  const first = harness({ coordinator, manager })
  first.transcripts.record('turn-one', '执行一次')
  await first.handler.handle({
    call_id: 'call-before-reconnect',
    name: 'delegate_to_codex',
    arguments: '{"objective":"执行一次"}',
  })

  const second = harness({ coordinator, manager })
  second.transcripts.record('turn-one', '执行一次')
  await second.handler.handle({
    call_id: 'call-after-reconnect',
    name: 'delegate_to_codex',
    arguments: '{"objective":"执行一次"}',
  })
  await manager.wait(first.outputs[0][1].work_id)
  assert.equal(manager.list({ ownerId: 'owner' }).length, 1)
  assert.equal(second.outputs[0][1].status, 'duplicate')
  assert.equal(runs, 1)
})

test('cancels the most recently submitted active work', async () => {
  const kit = harness()
  let release
  kit.handler.coordinator = {
    run: async (_input, { signal }) => new Promise((resolve, reject) => {
      release = resolve
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    }),
  }
  kit.transcripts.record('turn-one', '执行一次')
  await kit.handler.handle({
    call_id: 'call-one',
    name: 'delegate_to_codex',
    arguments: '{"objective":"执行一次"}',
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(kit.manager.list({ active: true }).length, 1)
  await kit.handler.handle({
    call_id: 'call-two',
    name: 'cancel_agent_task',
    arguments: '{}',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'cancelled')
  assert.deepEqual(kit.outputs.at(-1)[3], {})
  assert.equal(kit.manager.list({ active: true }).length, 0)
  assert.equal(kit.manager.list()[0].status, 'cancelled')
  release?.()
})

test('queries the latest work directly from the realtime task ledger', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '执行一次')
  await kit.handler.handle({
    call_id: 'call-submit',
    name: 'delegate_to_codex',
    arguments: '{"objective":"执行一次"}',
  })
  const workId = kit.outputs.at(-1)[1].work_id
  await kit.manager.wait(workId)

  await kit.handler.handle({
    call_id: 'call-status',
    name: 'get_agent_task_status',
    arguments: '{}',
  })

  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.equal(kit.outputs.at(-1)[1].work_id, workId)
  assert.equal(kit.outputs.at(-1)[1].work_status, 'completed')
  assert.equal(kit.outputs.at(-1)[1].result, '完成')
  assert.deepEqual(kit.outputs.at(-1)[2], {
    turnId: 'turn-one',
    taskId: workId,
    consumesTaskNotification: true,
  })
  assert.deepEqual(kit.outputs.at(-1)[3], {})
})

test('queues a hidden high-priority coordinator query for delegated work', async () => {
  const manager = new TaskManager()
  let releaseDelegation
  const delegated = manager.create({
    objective: '继续 Megatron-LM 项目',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async (_objective, { onEvent, signal }) => {
      onEvent({
        type: 'backend.delegated',
        delegation: {
          id: 'delegation-one',
          sessionId: 'session-target',
          title: 'Megatron-LM',
          directory: '/project',
        },
      })
      return new Promise((resolve, reject) => {
        releaseDelegation = resolve
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(delegated.id).status, 'delegated')

  let queried
  const kit = harness({
    manager,
    coordinator: {
      queryDelegatedWork: async (workId, question, options) => {
        queried = { workId, question, ownerId: options.ownerId }
        return { content: '正在检查模型目录。', metadata: {} }
      },
    },
  })
  kit.transcripts.record('turn-one', 'Megatron 那个已经查到了什么？')
  await kit.handler.handle({
    call_id: 'call-delegated-status',
    name: 'get_agent_task_status',
    arguments: JSON.stringify({ work_id: delegated.id }),
  })

  const output = kit.outputs.at(-1)[1]
  assert.equal(output.status, 'querying')
  assert.equal(output.work_id, delegated.id)
  assert.ok(output.query_work_id)
  const visible = manager.list({ ownerId: 'owner' })
  assert.equal(visible.some(task => task.id === output.query_work_id), false)
  const queryTask = await manager.wait(output.query_work_id)
  assert.equal(queryTask.status, 'completed')
  assert.equal(queryTask.result, '正在检查模型目录。')
  assert.deepEqual(queried, {
    workId: delegated.id,
    question: 'Megatron 那个已经查到了什么？',
    ownerId: 'owner',
  })

  releaseDelegation({ content: '最终完成' })
  await manager.wait(delegated.id)
})

test('relays a realtime semantic permission decision without evidence matching', async () => {
  const calls = []
  const answer = '你按刚才说的处理就成'
  const permissionPolicy = new SessionPermissionPolicy()
  const kit = await permissionHarness({
    answer,
    permissionPolicy,
    respondPermission: async (id, decision, options) => {
      calls.push({ id, decision, options })
      return {
        id,
        workId: 'work-one',
        status: 'approved',
      }
    },
  })
  await kit.handler.handle({
    call_id: 'permission-semantic-allow',
    name: 'respond_agent_permission',
    arguments: JSON.stringify({
      authorization_id: 'auth-one',
      decision: 'always',
    }),
  })

  // The receipt is issued before the fire-and-forget backend delivery lands.
  assert.equal(kit.outputs.at(-1)[1].status, 'submitted')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [{
    id: 'auth-one',
    decision: 'always',
    options: { ownerId: 'owner' },
  }])
  assert.match(
    kit.outputs.at(-1)[3].response.instructions,
    /已允许，后台继续执行/,
  )
  assert.equal(permissionPolicy.shouldAutoAllow('owner', 'voice'), true)
  await kit.finish()
})

test('confirms a rejected realtime permission exactly once', async () => {
  const answer = '不允许'
  const permissionPolicy = new SessionPermissionPolicy()
  permissionPolicy.applyDecision('owner', 'voice', 'always')
  const kit = await permissionHarness({
    answer,
    permissionPolicy,
    respondPermission: async id => ({
      id,
      workId: 'work-one',
      status: 'rejected',
    }),
  })
  await kit.handler.handle({
    call_id: 'permission-semantic-reject',
    name: 'respond_agent_permission',
    arguments: JSON.stringify({
      authorization_id: 'auth-one',
      decision: 'reject',
    }),
  })

  assert.equal(kit.outputs.at(-1)[1].status, 'submitted')
  assert.match(
    kit.outputs.at(-1)[3].response.instructions,
    /已拒绝/,
  )
  assert.equal(permissionPolicy.mode('owner', 'voice'), 'ask')
  await kit.finish()
})

test('rolls back the session policy when the permission delivery fails', async () => {
  const failures = []
  const permissionPolicy = new SessionPermissionPolicy()
  const kit = await permissionHarness({
    answer: '可以',
    permissionPolicy,
    respondPermission: async () => {
      throw new Error('backend unreachable')
    },
    onPermissionDeliveryFailed: event => failures.push(event),
  })
  await kit.handler.handle({
    call_id: 'permission-delivery-failed',
    name: 'respond_agent_permission',
    arguments: JSON.stringify({
      authorization_id: 'auth-one',
      decision: 'always',
    }),
  })

  // The spoken confirmation is receipt-based and always issued.
  assert.equal(kit.outputs.at(-1)[1].status, 'submitted')
  await new Promise(resolve => setImmediate(resolve))
  // Delivery failed: the local auto-allow rolls back and the gateway is told
  // so the pending permission can be re-announced.
  assert.equal(permissionPolicy.shouldAutoAllow('owner', 'voice'), false)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].authorizationId, 'auth-one')
  assert.equal(failures[0].decision, 'always')
  assert.match(failures[0].error, /backend unreachable/)
  await kit.finish()
})

test('auto-allows later permissions in the Gateway without publishing them', async () => {
  const permissionPolicy = new SessionPermissionPolicy()
  permissionPolicy.applyDecision('owner', 'voice', 'always')
  const approvals = []
  const kit = harness({
    permissionPolicy,
    respondPermission: async (id, decision, options) => {
      approvals.push({ id, decision, options })
      return { id, status: 'approved' }
    },
    coordinator: {
      run: async (_input, { onEvent }) => {
        onEvent({
          type: 'backend.permission.requested',
          permission: {
            id: 'auth-auto',
            status: 'pending',
            summary: 'List directory',
          },
        })
        return { content: '完成', metadata: {} }
      },
    },
  })
  const events = []
  kit.manager.subscribe(event => events.push(event))
  kit.transcripts.record('turn-one', '检查项目')

  await kit.handler.handle({
    call_id: 'auto-permission-work',
    name: 'delegate_to_codex',
    arguments: '{"objective":"检查项目"}',
  })
  await kit.manager.wait(kit.outputs[0][1].work_id)

  assert.deepEqual(approvals, [{
    id: 'auth-auto',
    decision: 'always',
    options: { ownerId: 'owner' },
  }])
  assert.equal(
    events.some(event => event.type === 'task.permission.requested'),
    false,
  )
})

test('accepts a semantic permission decision without an evidence field', async () => {
  const calls = []
  const kit = await permissionHarness({
    answer: '你按刚才说的做吧',
    respondPermission: async (id, decision) => {
      calls.push({ id, decision })
      return { id, workId: 'work-one', status: 'approved' }
    },
  })
  await kit.handler.handle({
    call_id: 'permission-without-evidence',
    name: 'respond_agent_permission',
    arguments: JSON.stringify({
      authorization_id: 'auth-one',
      decision: 'always',
    }),
  })

  // The verbatim delivery lands asynchronously behind the receipt.
  assert.equal(kit.outputs.at(-1)[1].status, 'submitted')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [{ id: 'auth-one', decision: 'always' }])
  await kit.finish()
})

test('rejects a permission id that is not pending on the current task', async () => {
  let called = false
  const answer = '照你说的来'
  const kit = await permissionHarness({
    answer,
    respondPermission: async () => {
      called = true
    },
  })
  await kit.handler.handle({
    call_id: 'permission-wrong-id',
    name: 'respond_agent_permission',
    arguments: JSON.stringify({
      authorization_id: 'auth-other',
      decision: 'always',
    }),
  })

  assert.equal(called, false)
  assert.equal(kit.outputs.at(-1)[1].error_code, 'permission_not_pending')
  await kit.finish()
})

test('reads both natural Markdown memory documents', async () => {
  const calls = []
  const memoryStore = {
    list: (ownerId, options) => {
      calls.push(['list', ownerId, options])
      return [{
        id: 'user_document',
        scope: 'user',
        content: '# USER\n\n- 称呼：船长',
        revision: 'rev-user',
        editable: true,
      }]
    },
  }
  const kit = harness({ memoryStore })

  await kit.handler.handle({
    call_id: 'memory-read',
    name: 'memory',
    arguments: '{"action":"read"}',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.deepEqual(calls[0], ['list', 'owner', undefined])
  assert.equal(kit.outputs.at(-1)[1].documents[0].revision, 'rev-user')
})

test('replaces one exact Markdown fragment', async () => {
  let call
  let changes = 0
  const kit = harness({
    memoryStore: {
      apply: (ownerId, changes) => {
        call = { ownerId, changes }
        return {
          changed: 3,
          documents: changes.map(change => ({ scope: change.document, revision: 'next' })),
        }
      },
    },
    onMemoryChanged: () => { changes += 1 },
  })

  await kit.handler.handle({
    call_id: 'memory-edit',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'replace',
      document: 'user',
      old_text: '- 称呼：老板',
      new_text: '- 称呼：船长',
    }),
  })

  assert.deepEqual(call, {
    ownerId: 'owner',
    changes: [{
      document: 'user',
      edits: [{ old_text: '- 称呼：老板', new_text: '- 称呼：船长' }],
      append: '',
    }],
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'updated')
  assert.equal(changes, 1)
})

test('appends one memory item', async () => {
  let call
  const kit = harness({
    memoryStore: {
      apply: (ownerId, changes) => {
        call = { ownerId, changes }
        return {
          changed: 2,
          documents: changes.map(change => ({ scope: change.document, revision: 'next' })),
        }
      },
    },
  })

  await kit.handler.handle({
    call_id: 'memory-cross-scope',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'append',
      document: 'user',
      content: '- 助手称呼用户：老大',
    }),
  })

  assert.equal(call.ownerId, 'owner')
  assert.equal(call.changes[0].document, 'user')
  assert.equal(call.changes[0].append, '- 助手称呼用户：老大')
  assert.equal(kit.outputs.at(-1)[1].status, 'updated')
  assert.equal(kit.outputs.at(-1)[1].documents.length, 1)
})

test('combines multiple memory writes from one model response into one follow-up', async () => {
  const kit = harness({
    memoryStore: {
      apply: (_ownerId, changes) => ({
        changed: 1,
        documents: changes.map(change => ({ scope: change.document })),
      }),
    },
  })
  const context = {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-memory-batch',
  }
  await Promise.all([
    ['memory-name', 'user', '- 助手称呼用户：船长'],
    ['memory-assistant-name', 'user', '- 当前用户称呼助手：小舟'],
    ['memory-hobby', 'memory', '- 喜欢打篮球'],
  ].map(async ([callId, scope, append]) => kit.handler.handle({
    call_id: callId,
    response_id: 'response-memory-batch',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'append',
      document: scope,
      content: append,
    }),
  }, context)))

  assert.equal(kit.outputs.length, 3)
  assert.ok(kit.outputs.every(output => output[3].createResponse === false))
  assert.equal(kit.ensuredResponses.length, 0)

  await kit.handler.finishToolResponse('response-memory-batch')
  assert.equal(kit.ensuredResponses.length, 1)
  assert.deepEqual(kit.ensuredResponses[0][0], {
    turnId: 'turn-one',
    turnGeneration: 1,
  })
})

test('returns the latest document when an exact edit no longer matches', async () => {
  const kit = harness({
    memoryStore: {
      apply: () => {
        const error = new Error('stale')
        error.code = 'edit_not_found'
        throw error
      },
      list: () => [{ scope: 'memory', content: '# MEMORY', revision: 'latest' }],
    },
  })
  await kit.handler.handle({
    call_id: 'memory-stale',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'replace',
      document: 'memory',
      old_text: '- 喜欢香蕉',
      new_text: '- 喜欢苹果',
    }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'edit_not_found')
  assert.equal(kit.outputs.at(-1)[1].documents[0].revision, 'latest')
})

test('rejects sensitive additions and incomplete atomic edits', async () => {
  const kit = harness({
    memoryStore: {
      apply: () => { throw new Error('must not write') },
    },
  })
  await kit.handler.handle({
    call_id: 'memory-secret',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'append',
      document: 'memory',
      content: '- API Key：sk-secret',
    }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'sensitive_memory')
  await kit.handler.handle({
    call_id: 'memory-no-scope',
    name: 'memory',
    arguments: '{"action":"replace","document":"user","old_text":"- 称呼：船长"}',
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'invalid_memory_edit')
})

test('notes: adds items to a named list and reports ambiguous removals', async () => {
  const notesStore = new FrontendNotesStore()
  const kit = harness({ notesStore })

  await kit.handler.handle({
    call_id: 'notes-add',
    name: 'notes',
    arguments: JSON.stringify({
      action: 'add',
      list: '购物清单',
      items: ['牛奶', '面包'],
    }),
  })
  const added = kit.outputs.at(-1)[1]
  assert.equal(added.status, 'ok')
  assert.deepEqual(added.added, ['牛奶', '面包'])

  await kit.handler.handle({
    call_id: 'notes-remove-fuzzy',
    name: 'notes',
    arguments: JSON.stringify({
      action: 'remove',
      list: '购物清单',
      items: ['面包'],
    }),
  })
  assert.deepEqual(kit.outputs.at(-1)[1].removed, ['面包'])

  await kit.handler.handle({
    call_id: 'notes-show',
    name: 'notes',
    arguments: JSON.stringify({ action: 'show', list: '购物清单' }),
  })
  assert.deepEqual(
    kit.outputs.at(-1)[1].items.map(item => item.text),
    ['牛奶'],
  )
})

test('notes: clears and drops a named list without re-parsing user wording', async () => {
  const notesStore = new FrontendNotesStore()
  const kit = harness({ notesStore })
  await kit.handler.handle({
    call_id: 'notes-seed',
    name: 'notes',
    arguments: JSON.stringify({ action: 'add', list: '购物清单', items: ['牛奶'] }),
  })

  await kit.handler.handle({
    call_id: 'notes-clear-ok',
    name: 'notes',
    arguments: JSON.stringify({ action: 'clear', list: '购物清单' }),
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.equal(kit.outputs.at(-1)[1].removed, 1)
  assert.equal(notesStore.show('owner', '购物清单').items.length, 0)

  await kit.handler.handle({
    call_id: 'notes-drop-ok',
    name: 'notes',
    arguments: JSON.stringify({ action: 'drop', list: '购物清单' }),
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.deepEqual(notesStore.lists('owner'), [])
})

test('notes: rejects secrets and missing arguments', async () => {
  const notesStore = new FrontendNotesStore()
  const kit = harness({ notesStore })

  await kit.handler.handle({
    call_id: 'notes-secret',
    name: 'notes',
    arguments: JSON.stringify({ action: 'add', list: '购物清单', items: ['我的密码是 12345'] }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'sensitive_notes')

  await kit.handler.handle({
    call_id: 'notes-no-list',
    name: 'notes',
    arguments: JSON.stringify({ action: 'show' }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'missing_notes_target')

  await kit.handler.handle({
    call_id: 'notes-no-items',
    name: 'notes',
    arguments: JSON.stringify({ action: 'add', list: '购物清单' }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'missing_notes_items')
})

test('notes: unavailable without a notes store', async () => {
  const kit = harness({})
  await kit.handler.handle({
    call_id: 'notes-unavailable',
    name: 'notes',
    arguments: JSON.stringify({ action: 'lists' }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'notes_unavailable')
})
