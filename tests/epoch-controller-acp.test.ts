import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { makeBridgeHarness, maxTokensResponse, textResponse, type BridgeHarness } from '../../deepseek-harness/packages/acp/acp/tests/harness.ts'
import { SessionId } from '../../deepseek-harness/packages/core/session/src/index.ts'
import { createUserMessage, ToolCallId, type StreamChunk } from '../../deepseek-harness/packages/llm/llm/src/index.ts'
import { defineContentToolFixture } from '../../deepseek-harness/packages/test-support/tool-testkit/src/index.ts'
import { CONTEXT_CLOSING_GUIDANCE } from '../src/agent-guidance.ts'
import { apply as applyGovernor } from '../src/index.ts'
import { EpochController } from '../src/epoch/epoch-controller.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { WorkspaceMutations } from '../src/workspace/workspace-mutations.ts'
import { registerRecordContinuationTool } from '../src/tools/record-continuation-tool.ts'
import { registerSwitchContextTool } from '../src/tools/switch-context-tool.ts'
import { enrichHistoryNavigation } from '../src/tools/history-tools.ts'
import { initializeWorkspace, plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

for (const failure of ['unfinished_handoff', 'context_overflow'] as const) {
  test(`reports ${failure} through real DSH ACP without idle followup loops`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'governor-acp-closing-'))
    let harness: BridgeHarness | undefined
    try {
      harness = await makeBridgeHarness({ script: [
        textResponse('Ready.'),
        ...(failure === 'unfinished_handoff'
          ? [textResponse('Done.'), textResponse('Still done.')]
          : [[{ type: 'finish' as const, reason: { kind: 'error' as const, failure: { message: 'Context window exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' as const } } }]]),
      ] })
      await harness.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
      const { sessionId } = await harness.client.newSession({ cwd: root, mcpServers: [] })
      const workspaces = new SessionWorkspaceProvider(root)
      const workspace = workspaces.forSession(sessionId)
      const original = await initializeWorkspace(workspace, {
        mission: 'Inspect input.', task_plan: plannedTaskPlan('Inspect source.'), user_constraints: [],
      })
      const controller = new EpochController(workspaces, 0.8)
      const projections = harness.ctx.sessionProjections
      const stateOf = projections.stateOf.bind(projections)
      projections.stateOf = ((session, key) => key === 'contextPressure' ? { contextWindow: 128000 } : stateOf(session, key)) as typeof projections.stateOf
      controller.install(harness.ctx)
      const prompt = () => harness!.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Continue the task.' }] })
      await prompt()
      const meter = harness.ctx.tokenMeter
      const measure = meter.measure.bind(meter)
      meter.measure = session => ({ ...measure(session), totalTokens: 103000 })
      await assert.rejects(prompt(), failure === 'unfinished_handoff' ? /handoff incomplete/ : /Context window exceeded/)
      assert.equal(harness.adapter.requests.length, failure === 'unfinished_handoff' ? 3 : 2)
      assert.equal(controller.requiresTransition(sessionId), true)
      assert.deepEqual(await workspace.state.read(), original)
    } finally {
      await harness?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('leaves repeated output truncation and resumption to the DSH caller without changing task progress', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-acp-truncation-'))
  let harness: BridgeHarness | undefined
  try {
    harness = await makeBridgeHarness({ script: [textResponse('Ready.'), maxTokensResponse('Partial output.'), maxTokensResponse('Another partial output.')] })
    await harness.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: root, mcpServers: [] })
    const workspaces = new SessionWorkspaceProvider(root)
    const workspace = workspaces.forSession(sessionId)
    const original = await initializeWorkspace(workspace, { mission: 'Inspect input.', task_plan: plannedTaskPlan('Inspect source.'), user_constraints: [] })
    const controller = new EpochController(workspaces, 0.8)
    const projections = harness.ctx.sessionProjections
    const stateOf = projections.stateOf.bind(projections)
    projections.stateOf = ((session, key) => key === 'contextPressure' ? { contextWindow: 128000 } : stateOf(session, key)) as typeof projections.stateOf
    controller.install(harness.ctx)
    const prompt = () => harness!.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Continue.' }] })
    await prompt()
    const meter = harness.ctx.tokenMeter
    const measure = meter.measure.bind(meter)
    meter.measure = session => ({ ...measure(session), totalTokens: 103000 })
    for (const calls of [2, 3]) {
      assert.equal((await prompt()).stopReason, 'max_tokens')
      assert.equal(harness.adapter.requests.length, calls)
      assert.deepEqual(await workspace.state.read(), original)
      assert.equal(harness.ctx.agents.get(SessionId(sessionId))!.inbox.nextTurn.length, 0)
      assert.equal(harness.ctx.agents.get(SessionId(sessionId))!.inbox.nextStep.length, 0)
    }
  } finally {
    await harness?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

function toolResponse(name: string, args: unknown): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(name), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

test('History navigation preserves a real DSH tool failure without copying its result content', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-acp-tool-error-'))
  let harness: BridgeHarness | undefined
  try {
    harness = await makeBridgeHarness({ script: [toolResponse('read_source', {}), textResponse('The source could not be read.')] })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'read_source', description: 'Offline source read failure.', parameters: {},
      async execute() { throw new Error('Source unavailable for this offline test.') },
    }))
    await harness.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: root, mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Read the source.' }] })
    const events = harness.ctx.sessions.get(SessionId(sessionId))!.snapshotEvents()
    const result = events.find(event => event.type === 'tool/result')!
    assert.equal(result.type, 'tool/result')
    if (result.type !== 'tool/result') throw new Error('Expected a DSH tool result')
    assert.equal(result.data.message.isError, true)
    const navigation = enrichHistoryNavigation([{ id: `event-${String(result.seq)}`, kind: 'tool_result' }], events)
    assert.equal(navigation[0]!.is_error, true)
    assert.equal(navigation[0]!.tool_name, 'read_source')
    assert.doesNotMatch(JSON.stringify(navigation), /Source unavailable/)
  } finally {
    await harness?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

for (const underPressure of [false, true]) {
  test(`wait_for_input ends only the current ACP turn${underPressure ? ' under context pressure' : ''} and permits later recovery`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'governor-acp-wait-'))
    let harness: BridgeHarness | undefined
    try {
      const script: StreamChunk[][] = [textResponse('Ready.')]
      harness = await makeBridgeHarness({ script })
      const workspaceDirectory = join(root, 'metadata')
      applyGovernor(harness.ctx, { enabled: true, workspaceDirectory, switchThresholdRatio: 0.8 })
      await harness.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
      const { sessionId } = await harness.client.newSession({ cwd: root, mcpServers: [] })
      const workspace = new SessionWorkspaceProvider(workspaceDirectory).forSession(sessionId)
      const original = await initializeWorkspace(workspace, {
        mission: 'Produce the required result.', task_plan: plannedTaskPlan('Produce the result.'), user_constraints: [],
      }, [plannedSubState()])
      const projections = harness.ctx.sessionProjections
      const stateOf = projections.stateOf.bind(projections)
      projections.stateOf = ((session, key) => key === 'contextPressure' ? { contextWindow: 128000 } : stateOf(session, key)) as typeof projections.stateOf
      const prompt = (text: string) => harness!.client.prompt({ sessionId, prompt: [{ type: 'text', text }] })
      await prompt('Begin.')
      if (underPressure) {
        const meter = harness.ctx.tokenMeter
        const measure = meter.measure.bind(meter)
        meter.measure = session => ({ ...measure(session), totalTokens: 103000 })
      }
      const continuation = {
        progress: 'Partial work is confirmed; the remaining source is missing.',
        working_resources: [],
        resume_from: 'Wait for the required source, then inspect it and finish the result.',
      }
      script.push(toolResponse('record_continuation', { operation: 'wait_for_input', ...continuation }))
      assert.equal((await prompt('Continue the task.')).stopReason, 'end_turn')
      assert.equal(harness.adapter.requests.length, 2)
      assert.deepEqual(await workspace.state.read(), { ...original, revision: 2 })
      assert.deepEqual((await workspace.sub_states.readAll())[0]!.current_sub_step!.continuation, continuation)
      const agent = harness.ctx.agents.get(SessionId(sessionId))!
      assert.equal(agent.inbox.nextTurn.length, 0)
      assert.equal(agent.inbox.nextStep.length, 0)
      const waitingAudits = await workspace.audits.list(sessionId)
      assert.equal(waitingAudits.length, 1)
      assert.equal(waitingAudits[0]!.completion, undefined)
      assert.equal(waitingAudits[0]!.switch, undefined)

      // The caller supplies the real prerequisite. Waiting must not disable
      // ordinary non-terminal saves or the subsequent Context switch.
      const resource = join(root, 'supplied-source.json')
      await writeFile(resource, '{"input":"supplied"}', 'utf8')
      const resumed = {
        progress: 'The required source has now been supplied.',
        working_resources: [{ path: resource, contains: 'The supplied source.' }],
        resume_from: 'Inspect the supplied source and finish the result.',
      }
      script.push(
        toolResponse('record_continuation', { operation: 'save', ...resumed }),
        toolResponse('switch_context', { expected_state_revision: 3, new_discovered_constraints: [], reason: 'Resume from the supplied source.' }),
        textResponse('The new Context is ready.'),
      )
      assert.equal((await prompt(`The required source is supplied at ${resource}. Continue.`)).stopReason, 'end_turn')
      assert.equal(harness.adapter.requests.length, 5)
      // This observer has its own cache, independent of the plugin's writer.
      workspace.state.invalidate()
      assert.deepEqual(await workspace.state.read(), { ...original, revision: 3 })
      assert.deepEqual((await workspace.sub_states.readAll())[0]!.current_sub_step!.continuation, resumed)
      const recoveredAudits = await workspace.audits.list(sessionId)
      assert.equal(recoveredAudits.length, 2)
      assert.ok(recoveredAudits[0]!.switch)
      assert.ok(recoveredAudits.every(audit => audit.completion === undefined))
    } finally {
      await harness?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const outcome of ['met', 'unmet'] as const) {
  test(`full plugin handles ${outcome} task-level checks through real DSH ACP`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'governor-acp-task-checks-'))
    let harness: BridgeHarness | undefined
    try {
      const resource = join(root, 'progress.json')
      await writeFile(resource, '{"partial":true}', 'utf8')
      const continuation = {
        progress: 'Partial progress is saved; a required result is still missing.',
        working_resources: [{ path: resource, contains: 'Confirmed partial work and unresolved result.' }],
        resume_from: 'Obtain the missing input before finishing and verifying the result.',
      }
      const script: StreamChunk[][] = [textResponse('Ready.')]
      harness = await makeBridgeHarness({ script })
      const workspaceDirectory = join(root, 'metadata')
      applyGovernor(harness.ctx, { enabled: true, workspaceDirectory, switchThresholdRatio: 0.8 })
      await harness.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
      const { sessionId } = await harness.client.newSession({ cwd: root, mcpServers: [] })
      const workspace = new SessionWorkspaceProvider(workspaceDirectory).forSession(sessionId)
      await initializeWorkspace(workspace, { mission: 'Produce a verified result.', task_plan: plannedTaskPlan('Produce the result.'), user_constraints: [] }, [plannedSubState()])
      const projections = harness.ctx.sessionProjections
      const stateOf = projections.stateOf.bind(projections)
      projections.stateOf = ((session, key) => key === 'contextPressure' ? { contextWindow: 128000 } : stateOf(session, key)) as typeof projections.stateOf
      const prompt = () => harness!.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Continue.' }] })
      await prompt()
      const session = harness.ctx.sessions.get(SessionId(sessionId))!
      const evidence = `event-${String(session.snapshotEvents().findLast(event => event.type === 'user/message')!.seq)}`
      script.push(toolResponse('advance_task_progress', {
        expected_state_revision: 1,
        transition: {
          type: 'complete_task', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
          completed: { summary: outcome === 'met' ? 'The required result is verified.' : 'The missing result has been documented.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: [evidence] }], artifact_refs: [] },
          task_criteria_check: [{ criterion_index: 0, outcome, source_events: [evidence] }],
        },
      }))
      if (outcome === 'unmet') script.push(toolResponse('record_continuation', { operation: 'save', ...continuation }), textResponse('A required result remains unresolved; progress is saved.'))
      assert.equal((await prompt()).stopReason, 'end_turn')
      const state = await workspace.state.read()
      const subState = (await workspace.sub_states.readAll())[0]!
      assert.equal(state!.revision, 2)
      assert.equal(state!.lifecycle.status, outcome === 'met' ? 'completed' : 'active')
      const audits = await workspace.audits.list(sessionId)
      if (outcome === 'met') {
        assert.equal(subState.current_sub_step, null)
        assert.ok(audits[0]!.completion)
        assert.equal(harness.adapter.requests.length, 2)
      } else {
        assert.deepEqual(subState.completed_sub_steps, [])
        assert.deepEqual(subState.current_sub_step!.continuation, continuation)
        assert.equal(audits[0]!.completion, undefined)
        assert.ok(JSON.stringify(session.snapshotEvents()).includes('Cannot complete task'))
        assert.equal(harness.adapter.requests.length, 4)
      }
    } finally {
      await harness?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const toolName of ['write', 'execute_script']) {
  test(`full plugin allows ${toolName} to save progress under pressure and hand off an incomplete SubStep`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'governor-acp-capability-handoff-'))
    let harness: BridgeHarness | undefined
    try {
      const resource = join(root, 'working.json')
      const continuation = { progress: 'First portion saved; the remaining input is unresolved.', working_resources: [{ path: resource, contains: 'First portion.' }], resume_from: 'Inspect the second portion.' }
      harness = await makeBridgeHarness({ script: [
        textResponse('Ready.'),
        toolResponse(toolName, {}),
        toolResponse('record_continuation', { operation: 'save', ...continuation }),
        toolResponse('switch_context', { expected_state_revision: 2, new_discovered_constraints: [], reason: 'Resume the incomplete SubStep from the saved portion.' }),
        textResponse('The new Context is ready.'),
      ] })
      const workspaceDirectory = join(root, 'metadata')
      applyGovernor(harness.ctx, { enabled: true, workspaceDirectory, switchThresholdRatio: 0.8 })
      harness.ctx.tools.register(defineContentToolFixture({
        name: toolName,
        description: 'Save already obtained partial progress in the workspace.',
        parameters: {},
        async execute() {
          await writeFile(resource, '{"partial":true}', 'utf8')
          return [{ type: 'text', text: 'Partial progress saved.' }]
        },
      }))
      await harness.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
      const { sessionId } = await harness.client.newSession({ cwd: root, mcpServers: [] })
      const workspace = new SessionWorkspaceProvider(workspaceDirectory).forSession(sessionId)
      const original = await initializeWorkspace(workspace, { mission: 'Inspect input.', task_plan: plannedTaskPlan('Inspect source.'), user_constraints: [] }, [plannedSubState()])
      const projections = harness.ctx.sessionProjections
      const stateOf = projections.stateOf.bind(projections)
      projections.stateOf = ((session, key) => key === 'contextPressure' ? { contextWindow: 128000 } : stateOf(session, key)) as typeof projections.stateOf
      const prompt = () => harness!.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Continue.' }] })
      await prompt()
      const meter = harness.ctx.tokenMeter
      const measure = meter.measure.bind(meter)
      meter.measure = session => ({ ...measure(session), totalTokens: 103000 })
      assert.equal((await prompt()).stopReason, 'end_turn')
      assert.equal(harness.adapter.requests.length, 5)
      assert.equal(await readFile(resource, 'utf8'), '{"partial":true}')
      const pressureTexts = harness.adapter.requests[1]!.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      assert.ok(pressureTexts.some(text => text.includes(CONTEXT_CLOSING_GUIDANCE)))
      const state = await workspace.state.read()
      assert.deepEqual(state, { ...original, revision: 2 })
      const subState = (await workspace.sub_states.readAll())[0]!
      assert.deepEqual(subState.completed_sub_steps, [])
      assert.deepEqual(subState.current_sub_step!.continuation, continuation)
      const audits = await workspace.audits.list(sessionId)
      assert.equal(audits.length, 2)
      assert.ok(audits[0]!.switch)
      // The new Epoch receives the saved handoff, not another closing prompt.
      const recoveredTexts = harness.adapter.requests[4]!.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      assert.ok(recoveredTexts.some(text => text.includes(continuation.resume_from)))
      const recovered = JSON.parse(recoveredTexts.find(text => text.startsWith('{') && text.includes('"context_governor"'))!).context_governor
      assert.equal(recovered.switch_note, 'Resume the incomplete SubStep from the saved portion.')
      assert.equal(recovered.switch_note, audits[0]!.switch!.reason)
      assert.deepEqual(recovered.current_sub_state.current_sub_step.continuation, continuation)
      assert.deepEqual(recovered.state, state)
      assert.ok(recoveredTexts.every(text => !text.includes(CONTEXT_CLOSING_GUIDANCE)))
      const messages = harness.ctx.sessions.get(SessionId(sessionId))!.snapshotEvents()
        .filter(event => event.type === 'user/message').map(event => event.data)
      assert.ok(messages.some(message => message.source.kind === 'context-governor'
        && message.source.form === 'snapshot'))
      assert.ok(messages.some(message => message.source.kind === 'context-governor'
        && message.source.form === undefined))
    } finally {
      await harness?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('preserves a successful Continuation after sticky max-tokens and allows the caller to resume the Context switch', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-acp-truncated-handoff-'))
  let harness: BridgeHarness | undefined
  try {
    const resource = join(root, 'working.json')
    await writeFile(resource, '{"partial":true}', 'utf8')
    const continuation = { progress: 'Partial input saved.', working_resources: [{ path: resource, contains: 'First portion.' }], resume_from: 'Inspect the second portion.' }
    harness = await makeBridgeHarness({ script: [
      textResponse('Ready.'), maxTokensResponse('Truncated reasoning.'), toolResponse('record_continuation', { operation: 'save', ...continuation }),
      toolResponse('switch_context', { expected_state_revision: 2, new_discovered_constraints: [], reason: 'Continue from the saved portion.' }),
      textResponse('The new Context is ready.'),
    ] })
    await harness.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: root, mcpServers: [] })
    const workspaces = new SessionWorkspaceProvider(join(root, 'metadata'), id => harness!.ctx.sessions.get(SessionId(id))?.header.cwd)
    const workspace = workspaces.forSession(sessionId)
    await initializeWorkspace(workspace, { mission: 'Inspect input.', task_plan: plannedTaskPlan('Inspect source.'), user_constraints: [] }, [plannedSubState()])
    const controller = new EpochController(workspaces, 0.8)
    const mutations = new WorkspaceMutations(workspaces)
    registerRecordContinuationTool(harness.ctx, workspaces, mutations)
    registerSwitchContextTool(harness.ctx, controller, mutations)
    const projections = harness.ctx.sessionProjections
    const stateOf = projections.stateOf.bind(projections)
    projections.stateOf = ((session, key) => key === 'contextPressure' ? { contextWindow: 128000 } : stateOf(session, key)) as typeof projections.stateOf
    controller.install(harness.ctx)
    // Simulate DSH-side steering after truncation. Governor must also leave
    // the subsequent tool call alone when DSH still reports sticky max-tokens.
    let steered = false
    harness.ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      if (turn === 2 && !steered) {
        steered = true
        agent.steer(createUserMessage({ content: [{ type: 'text', text: 'Save the partial progress.' }], source: { kind: 'user' } }))
      }
    })
    const prompt = () => harness!.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Continue.' }] })
    await prompt()
    const meter = harness.ctx.tokenMeter
    const measure = meter.measure.bind(meter)
    meter.measure = session => ({ ...measure(session), totalTokens: 103000 })
    assert.equal((await prompt()).stopReason, 'max_tokens')
    assert.equal(harness.adapter.requests.length, 3)
    assert.equal((await workspace.state.read())!.revision, 2)
    assert.equal((await workspace.state.read())!.lifecycle.status, 'active')
    assert.deepEqual((await workspace.sub_states.readAll())[0]!.current_sub_step!.continuation, continuation)
    assert.equal((await prompt()).stopReason, 'end_turn')
    assert.equal(harness.adapter.requests.length, 5)
    assert.equal(controller.requiresTransition(sessionId), false)
    assert.equal((await workspace.state.read())!.lifecycle.status, 'active')
    assert.equal((await workspace.audits.list(sessionId)).length, 2)
  } finally {
    await harness?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
