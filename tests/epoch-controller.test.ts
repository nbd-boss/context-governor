import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import type { PreStepDecision } from '../../deepseek-harness/packages/core/agent/src/runtime-types.ts'
import { createUserMessage, type UserMessage } from '../../deepseek-harness/packages/llm/llm/src/index.ts'
import { estimateMessage } from '../../deepseek-harness/packages/llm/token-meter/src/estimate.ts'
import { CONTEXT_CLOSING_GUIDANCE } from '../src/agent-guidance.ts'
import { EpochController } from '../src/epoch/epoch-controller.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { initializeWorkspace, plannedSubState, plannedTaskPlan, storedConstraints } from './test-fixtures.ts'
import { WorkspaceMutations } from '../src/workspace/workspace-mutations.ts'
import { registerSwitchContextTool } from '../src/tools/switch-context-tool.ts'

function runtime(workspaces: SessionWorkspaceProvider) {
  const events: Array<{ seq: number; type: string; data: unknown }> = [{ seq: 0, type: 'system/message', data: {} }]
  const nodes = [0]
  const queued: UserMessage[] = []
  const agent = {
    session: {
      id: 'session-a',
      surface: { nodes },
      snapshotEvents: () => [...events],
      append(type: string, data: unknown, options: { surfaceOp: { op: string; startSeq?: number; endSeq?: number } }) {
        const seq = events.length
        events.push({ seq, type, data })
        if (options.surfaceOp.op === 'replace') {
          const start = nodes.indexOf(options.surfaceOp.startSeq!)
          const end = nodes.indexOf(options.surfaceOp.endSeq!)
          assert.ok(start >= 0 && end >= start)
          nodes.splice(start, end - start + 1, seq)
        } else nodes.push(seq)
      },
    },
    followup(message: UserMessage) { queued.push(message) },
    steer(message: UserMessage) { queued.push(message) },
  }
  type StepHook = (input: { agent: typeof agent }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
  type StatusHook = (input: { agent: typeof agent; status: string }) => void
  type StopHook = (input: { agent: typeof agent; turn: number }) => void
  let beforeStep!: StepHook
  let statusChanged!: StatusHook
  let turnStopping!: StopHook
  let tokens = 1000
  const context = {
    on(name: string, handler: unknown) {
      if (name === 'agent/pre-step') beforeStep = handler as StepHook
      if (name === 'agent/status') statusChanged = handler as StatusHook
      if (name === 'agent/turn-stopping') turnStopping = handler as StopHook
    },
    tokenMeter: { estimateMessage, measure: () => ({ totalTokens: tokens }) },
    sessionProjections: { stateOf: () => ({ contextWindow: 128000 }) },
  } as unknown as Context
  const controller = new EpochController(workspaces, 0.8)
  controller.install(context)
  return {
    agent, controller, events, queued,
    setTokens(value: number) { tokens = value },
    idle() { statusChanged({ agent, status: 'idle' }) },
    stop(kind: 'stop' | 'max-tokens' | 'tool-calls' = 'stop') {
      agent.session.append('assistant/message', {
        turn: 1,
        message: { content: kind === 'tool-calls' ? [{ type: 'tool-call', name: 'record_continuation' }] : [] },
        stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind } } }],
      }, { surfaceOp: { op: 'append' } })
      turnStopping({ agent, turn: 1 })
    },
    async step(messages: UserMessage[] = []) {
      const decision = await beforeStep({ agent }, async () => ({ kind: 'enter', messages }))
      if (decision.kind === 'enter') {
        for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: { op: 'append' } })
      }
      return decision
    },
    baseline() {
      const event = events.findLast(event => {
        if (event.type !== 'user/message') return false
        const message = event.data as UserMessage
        return message.content.some(block => block.type === 'text' && block.text.startsWith('{'))
      })!
      const message = event.data as UserMessage
      const text = message.content.find(block => block.type === 'text')!
      assert.equal(text.type, 'text')
      return JSON.parse(text.text).context_governor
    },
  }
}

test('audits a resident prefix above 6000 tokens and checks live Context pressure without rebuilding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-live-pressure-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const workspace = workspaces.forSession('session-a')
    await initializeWorkspace(workspace, { mission: 'M'.repeat(26000), task_plan: plannedTaskPlan('Inspect input.'), user_constraints: [] })
    let reads = 0
    const readAll = workspace.sub_states.readAll.bind(workspace.sub_states)
    workspace.sub_states.readAll = async () => { reads += 1; return readAll() }
    const run = runtime(workspaces)
    await run.step()
    assert.deepEqual(run.queued, [])
    const baselineMessage = run.events.findLast(event => event.type === 'user/message')!.data as UserMessage
    assert.equal(baselineMessage.source.kind, 'context-governor')
    assert.ok((await workspace.audits.list('session-a'))[0]!.resident_tokens > 6000)
    assert.equal(reads, 1)
    const ordinary = await run.step()
    assert.equal(ordinary.kind, 'enter')
    if (ordinary.kind === 'enter') assert.deepEqual(ordinary.messages, [])
    assert.equal(reads, 1)
    run.setTokens(102399)
    await run.step([createUserMessage({ content: [{ type: 'text', text: 'Next input.' }], source: { kind: 'user' } })])
    assert.equal(run.controller.requiresTransition('session-a'), true)
    assert.equal(reads, 1)
    const afterReminder = await run.step()
    assert.equal(afterReminder.kind, 'enter')
    if (afterReminder.kind === 'enter') assert.deepEqual(afterReminder.messages, [])
    run.idle()
    assert.equal(run.queued.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('allows one closing correction, stops an unresolved handoff, and resets after a successful switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-closing-stop-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const workspace = workspaces.forSession('session-a')
    const state = await initializeWorkspace(workspace, { mission: 'Inspect input.', task_plan: plannedTaskPlan('Inspect source.'), user_constraints: [] })
    const run = runtime(workspaces)
    await run.step()
    run.setTokens(103000)
    await run.step()
    run.stop('max-tokens')
    run.stop('tool-calls')
    assert.equal(run.queued.length, 0)
    run.stop()
    assert.equal(run.queued.length, 1)
    assert.equal(run.queued[0]!.source.kind, 'context-governor')
    assert.deepEqual(run.queued[0]!.content, [{ type: 'text', text: CONTEXT_CLOSING_GUIDANCE }])
    await run.step(run.queued.splice(0))
    run.stop('max-tokens')
    run.stop('tool-calls')
    assert.equal(run.queued.length, 0)
    assert.throws(() => run.stop(), /handoff incomplete/)
    run.idle()
    run.idle()
    assert.equal(run.queued.length, 0)
    assert.deepEqual(await workspace.state.read(), state)
    await run.controller.requestSwitch(run.agent, 'Resume from the saved inspection.', { stateChanged: false, subStepChanges: [] })
    run.stop()
    run.idle()
    assert.equal(run.queued.length, 1)
    await run.step(run.queued.splice(0))
    assert.equal(run.controller.requiresTransition('session-a'), false)
    await run.step()
    run.stop()
    assert.equal(run.queued.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('carries an unplanned Step handoff across a pressure-triggered switch without changing State', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-recon-handoff-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const workspace = workspaces.forSession('session-a')
    const state = await initializeWorkspace(workspace, { mission: 'Analyze input.', task_plan: plannedTaskPlan('Inspect source.'), user_constraints: [] })
    const run = runtime(workspaces)
    await run.step()
    run.setTokens(103000)
    await run.step()
    const reason = 'Source columns are confirmed in E:\\workspace\\recon.json; the final row is unresolved. Next inspect the boundary, then plan SubSteps.'
    await run.controller.requestSwitch(run.agent, reason, { stateChanged: false, subStepChanges: [] })
    run.idle()
    run.idle()
    assert.equal(run.queued.length, 1)
    await run.step(run.queued.splice(0))
    const baseline = run.baseline()
    assert.equal(baseline.switch_note, reason)
    assert.equal(baseline.current_sub_state, null)
    assert.deepEqual(baseline.state, state)
    assert.deepEqual(await workspace.state.read(), state)
    assert.deepEqual(await workspace.sub_states.readAll(), [])
    assert.equal(run.controller.requiresTransition('session-a'), false)
    assert.equal(run.agent.session.surface.nodes[0], 0)
    assert.ok(run.events.length > run.agent.session.surface.nodes.length)
    const audits = await workspace.audits.list('session-a')
    assert.equal(audits[0]!.switch!.reason, reason)
    assert.equal(audits.length, 2)
    // A later switch replaces this note instead of accumulating old handoffs.
    const nextReason = 'The boundary is confirmed in E:\\workspace\\recon.json. Next submit the Step plan.'
    await run.controller.requestSwitch(run.agent, nextReason, { stateChanged: false, subStepChanges: [] })
    await run.step()
    assert.equal(run.baseline().switch_note, nextReason)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a planned Step receives an auxiliary switch note without changing its SubStep Continuation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-planned-handoff-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const workspace = workspaces.forSession('session-a')
    const subState = plannedSubState()
    const continuation = { progress: 'First batch saved.', working_resources: [{ path: 'E:\\workspace\\batch.json', contains: 'First batch.' }], resume_from: 'Read the next batch.' }
    subState.current_sub_step!.continuation = continuation
    const state = await initializeWorkspace(workspace, { mission: 'Process input.', task_plan: plannedTaskPlan('Process batches.'), user_constraints: [] }, [subState])
    const run = runtime(workspaces)
    await run.step()
    await run.controller.requestSwitch(run.agent, 'Free Context for the next batch.', { stateChanged: false, subStepChanges: [] })
    await run.step()
    const baseline = run.baseline()
    assert.equal(baseline.switch_note, 'Free Context for the next batch.')
    assert.equal('reconnaissance_handoff' in baseline, false)
    assert.deepEqual(baseline.current_sub_state.current_sub_step.continuation, continuation)
    assert.deepEqual(await workspace.state.read(), state)
    assert.deepEqual(await workspace.sub_states.readAll(), [subState])
    const audits = await workspace.audits.list('session-a')
    assert.equal(audits[0]!.switch!.reason, baseline.switch_note)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a planned Step without a Continuation retains its switch note instead of losing recovery clues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-planned-note-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const workspace = workspaces.forSession('session-a')
    const subState = plannedSubState()
    const state = await initializeWorkspace(workspace, { mission: 'Process input.', task_plan: plannedTaskPlan('Process batches.'), user_constraints: [] }, [subState])
    const run = runtime(workspaces)
    await run.step()
    const reason = 'Source identified; use the confirmed bounded read next.'
    await run.controller.requestSwitch(run.agent, reason, { stateChanged: false, subStepChanges: [] })
    await run.step()
    const baseline = run.baseline()
    assert.equal(baseline.switch_note, reason)
    assert.equal(baseline.current_sub_state.current_sub_step.continuation, null)
    assert.deepEqual(await workspace.state.read(), state)
    assert.deepEqual(await workspace.sub_states.readAll(), [subState])
    assert.equal((await workspace.audits.list('session-a'))[0]!.switch!.reason, reason)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('closing-mode switch persists restrictions and injects them into the next Epoch baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-closing-constraint-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const workspace = workspaces.forSession('session-a')
    await initializeWorkspace(workspace, { mission: 'Process input.', task_plan: plannedTaskPlan('Inspect source.'), user_constraints: [] })
    const run = runtime(workspaces)
    await run.step()
    run.agent.session.append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: 'Access denied outside the authorized input scope.' }] } }, { surfaceOp: { op: 'append' } })
    const evidence = `event-${String(run.events.at(-1)!.seq)}`
    run.setTokens(103000)
    await run.step()
    assert.equal(run.controller.requiresTransition('session-a'), true)
    let tool!: ToolDefinition
    registerSwitchContextTool({ tools: { register: (value: ToolDefinition) => { tool = value } } } as unknown as Context, run.controller, new WorkspaceMutations(workspaces))
    const constraint = { kind: 'environment_limit' as const, condition: 'Only authorized inputs are accessible.', required_behavior: 'Use the authorized interface.', source_events: [evidence], replaces: [] }
    await tool.execute({ reason: 'Resume inspection through the authorized interface.', expected_state_revision: 1, new_discovered_constraints: [constraint] }, { agent: run.agent, concludeTurn: () => {} } as never)
    run.idle()
    run.setTokens(1000)
    await run.step(run.queued.splice(0))
    assert.equal(run.baseline().state.revision, 2)
    assert.deepEqual(run.baseline().state.discovered_constraints, storedConstraints([constraint]))
    assert.equal(run.controller.requiresTransition('session-a'), false)
    const audits = await workspace.audits.list('session-a')
    assert.equal(audits[0]!.switch!.state_changed, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
