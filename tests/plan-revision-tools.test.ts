import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import { validateJsonSchemaValue } from '../../deepseek-harness/packages/core/tools/src/json-schema.ts'
import { registerStateDeltaTools } from '../src/tools/state-delta-tools.ts'
import { registerReviseSubstepTool } from '../src/tools/revise-substep-tool.ts'
import { registerCriteriaReplanTools } from '../src/tools/criteria-replan-tools.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { WorkspaceMutations } from '../src/workspace/workspace-mutations.ts'
import { readDurableWorkspace } from '../src/workspace/workspace-snapshot.ts'
import { buildResidentContext } from '../src/epoch/resident-context.ts'
import { DECISION_CHECKS } from '../src/agent-guidance.ts'
import { initializeWorkspace, plannedSubState, plannedTaskPlan, storedConstraints } from './test-fixtures.ts'

function registered(workspaces: SessionWorkspaceProvider) {
  const tools = new Map<string, ToolDefinition>()
  const ctx = { tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } } } as unknown as Context
  const mutations = new WorkspaceMutations(workspaces)
  registerStateDeltaTools(ctx, mutations)
  registerReviseSubstepTool(ctx, mutations)
  registerCriteriaReplanTools(ctx, mutations)
  return tools
}

const exec = { agent: { session: { id: 'session-a', snapshotEvents: () => [{ seq: 8, type: 'tool/result' }] } } } as never

test('constraint recording uses the shared guidance and survives reload into the next resident Context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-constraint-handoff-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    await initializeWorkspace(workspaces.forSession('session-a'), {
      mission: 'Process the available inputs.', task_plan: plannedTaskPlan('Produce a verified result.'), user_constraints: [],
    })
    const before = await readDurableWorkspace(workspaces, 'session-a')
    const tool = registered(workspaces).get('record_discovered_constraint')!
    assert.match(tool.description, /context_governor\.decision_checks\.after_reconnaissance/)
    assert.match(tool.description, /condition states when and where it applies/)
    assert.doesNotMatch(tool.description, /A single failed or timed-out request/)
    const entry = {
      kind: 'environment_limit',
      condition: 'The current file tool is restricted to the assigned workspace.',
      required_behavior: 'Read inputs only through authorized paths or interfaces.',
      source_events: ['event-8'],
      replaces: [],
    }
    const args = { expected_state_revision: before.state.revision, ...entry }
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, args, ''), [])
    await assert.rejects(tool.execute({ ...args, source_events: ['event-8', 'event-999'] }, exec), error => {
      assert.match(String(error), /source_events: events not found in the current execution History: event-999/)
      assert.match(String(error), /Use existing event-N identifiers/)
      return true
    })
    assert.deepEqual(await readDurableWorkspace(workspaces, 'session-a'), before)
    const result = await tool.execute(args, exec) as { state_revision: number; state: unknown; current_sub_state: unknown }
    const expected = { ...before.state, revision: before.state.revision + 1, next_constraint_number: 2, discovered_constraints: storedConstraints([entry]) }
    assert.equal(result.state_revision, expected.revision)
    assert.deepEqual(result.state, expected)
    assert.equal(result.current_sub_state, null)

    const restarted = new SessionWorkspaceProvider(root)
    const durable = await readDurableWorkspace(restarted, 'session-a')
    assert.deepEqual(durable, { ...before, state: expected })
    const resident = await buildResidentContext(restarted.forSession('session-a'), 'session-a')
    const payload = resident!.payload.context_governor as Record<string, unknown>
    assert.deepEqual(payload.state, expected)
    assert.deepEqual(payload.decision_checks, DECISION_CHECKS)
    await assert.rejects(registered(restarted).get(tool.name)!.execute(args, exec), /revision mismatch/)
    assert.deepEqual(await readDurableWorkspace(restarted, 'session-a'), durable)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runtime constraints accept referenced specifications without requiring a tool result and preserve user-constraint rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-constraint-evidence-type-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    await initializeWorkspace(workspaces.forSession('session-a'), {
      mission: 'Process input.', task_plan: plannedTaskPlan('Produce result.'), user_constraints: [],
    })
    const tools = registered(workspaces)
    const tool = tools.get('record_discovered_constraint')!
    const events = [
      { seq: 8, type: 'tool/result' }, { seq: 10, type: 'assistant/message' },
      { seq: 11, type: 'step/end' }, { seq: 12, type: 'tool/call' }, { seq: 13, type: 'user/message' }, { seq: 14, type: 'system/message' },
    ]
    const context = { agent: { session: { id: 'session-a', snapshotEvents: () => events } } } as never
    const before = await readDurableWorkspace(workspaces, 'session-a')
    const entry = { kind: 'environment_limit' as const, condition: 'The input interface restricts accessible paths.', required_behavior: 'Use authorized paths.', replaces: [] }
    await assert.rejects(tool.execute({ expected_state_revision: 1, ...entry, source_events: ['event-13', 'event-999'] }, context), /events not found.*event-999/)
    assert.deepEqual(await readDurableWorkspace(workspaces, 'session-a'), before)
    const referenced = { ...entry, source_events: ['event-13'] }
    await tool.execute({ expected_state_revision: 1, ...referenced }, context)
    const state = await workspaces.forSession('session-a').state.read()
    assert.equal(state?.revision, 2)
    assert.deepEqual(state?.discovered_constraints, storedConstraints([referenced]))
    const systemReference = { ...entry, condition: 'The runtime provides a separate authorized interface.', source_events: ['event-14'] }
    await tool.execute({ expected_state_revision: 2, ...systemReference }, context)
    assert.deepEqual((await workspaces.forSession('session-a').state.read())?.discovered_constraints, storedConstraints([referenced, systemReference]))
    await tools.get('record_user_constraint')!.execute({ expected_state_revision: 3, constraint: 'Keep the public API.', source_event: 'event-13' }, context)
    assert.deepEqual((await workspaces.forSession('session-a').state.read())?.user_constraints, ['Keep the public API.'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('record_discovered_constraint replaces an active boundary and rejects retired IDs after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-replace-constraint-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    await initializeWorkspace(workspaces.forSession('session-a'), {
      mission: 'Process input.', task_plan: plannedTaskPlan('Produce result.'), user_constraints: [],
    }, [plannedSubState()])
    const tool = registered(workspaces).get('record_discovered_constraint')!
    const entry = { kind: 'external_contract' as const, condition: 'An earlier request timed out.', required_behavior: 'Treat its outcome as unresolved.', source_events: ['event-8'], replaces: [] }
    const { replaces: _replaces, ...missingReplaces } = entry
    assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, { expected_state_revision: 1, ...missingReplaces }, ''), [])
    assert.equal('constraint_id' in (tool.parameters.properties as Record<string, unknown>), false)
    await tool.execute({ expected_state_revision: 1, ...entry }, exec)
    const before = await readDurableWorkspace(workspaces, 'session-a')
    const replacement = { ...entry, required_behavior: 'A confirmed completion result is available; do not repeat the completed request.', replaces: ['constraint-000001'] }
    await assert.rejects(tool.execute({ expected_state_revision: 1, ...replacement }, exec), /revision mismatch/)
    await assert.rejects(tool.execute({ expected_state_revision: 2, ...replacement, source_events: ['event-999'] }, exec), /events not found/)
    assert.deepEqual(await readDurableWorkspace(workspaces, 'session-a'), before)
    const result = await tool.execute({ expected_state_revision: 2, ...replacement }, exec) as { state_revision: number }
    assert.equal(result.state_revision, 3)
    const restarted = new SessionWorkspaceProvider(root)
    const saved = await readDurableWorkspace(restarted, 'session-a')
    assert.deepEqual(saved.state.discovered_constraints, storedConstraints([replacement], 2))
    assert.equal(saved.state.next_constraint_number, 3)
    assert.deepEqual(saved.sub_states, before.sub_states)
    const reader = registered(restarted).get('record_discovered_constraint')!
    await assert.rejects(reader.execute({ expected_state_revision: 3, ...replacement }, exec), /active constraint/)
    await reader.execute({ expected_state_revision: 3, ...entry }, exec)
    assert.deepEqual((await restarted.forSession('session-a').state.read())?.discovered_constraints.map(item => item.constraint_id), ['constraint-000002', 'constraint-000003'])
    const resident = await buildResidentContext(restarted.forSession('session-a'), 'session-a')
    const state = (resident!.payload.context_governor as { state: { discovered_constraints: unknown[] } }).state
    assert.deepEqual(state.discovered_constraints, [...storedConstraints([replacement], 2), ...storedConstraints([entry], 3)])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Step and SubStep tools validate operation-specific fields and persist each edit independently', async () => {
  for (const level of ['step', 'substep'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'governor-single-edit-'))
    try {
      const workspaces = new SessionWorkspaceProvider(root)
      await initializeWorkspace(workspaces.forSession('session-a'), {
        mission: 'Produce two results.', task_plan: plannedTaskPlan('First', 'Second'), user_constraints: [],
      }, [plannedSubState({ plan: {
        step_completion_criteria: ['Input inspected.', 'Output verified.'],
        sub_steps: [{ action: 'Inspect input.', covers: [0] }, { action: 'Verify output.', covers: [1] }],
      } })])
      const tools = registered(workspaces)
      const tool = tools.get(level === 'step' ? 'revise_step' : 'revise_substep')!
      const identity = level === 'step' ? {} : { step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000001' }
      const idKey = level === 'step' ? 'step_id' : 'sub_step_id'
      const prefix = level === 'step' ? 'step' : 'sub-step'
      const draft = level === 'step'
        ? { inputs: ['Input.'], step: 'Verify independently.', result: 'Verified result.', covers: [1] }
        : { inputs: ['Input.'], action: 'Verify independently.', result: 'Verified result.', covers_criterion_ids: ['criterion-000002'] }
      const call = (revision: number, change: object) => ({ expected_state_revision: revision, ...identity, change })
      for (const change of [
        { operation: 'add', ...draft },
        { operation: 'update', [idKey]: `${prefix}-000002`, ...draft },
        { operation: 'delete', [idKey]: `${prefix}-000002` },
      ]) assert.deepEqual(validateJsonSchemaValue(tool.parameters, call(1, change), ''), [])
      for (const change of [
        { operation: 'add', [idKey]: `${prefix}-000003`, ...draft },
        { operation: 'update', ...draft },
        { operation: 'delete', [idKey]: `${prefix}-000002`, ...draft },
      ]) assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, call(1, change), ''), [])

      const before = await readDurableWorkspace(workspaces, 'session-a')
      await assert.rejects(tool.execute(call(1, { operation: 'delete', [idKey]: `${prefix}-000002` }), exec), /not covered/)
      assert.deepEqual(await readDurableWorkspace(workspaces, 'session-a'), before)
      await tool.execute(call(1, { operation: 'add', ...draft }), exec)
      const updateDraft = level === 'step' ? { ...draft, step: 'Verify by script.' } : { ...draft, action: 'Verify by script.' }
      const updated = await tool.execute(call(2, { operation: 'update', [idKey]: `${prefix}-000002`, ...updateDraft }), exec) as { state_revision: number }
      assert.equal(updated.state_revision, 3)
      await tool.execute(call(3, { operation: 'delete', [idKey]: `${prefix}-000003` }), exec)

      const restarted = new SessionWorkspaceProvider(root)
      const reader = registered(restarted).get(tool.name)!
      const added = await reader.execute(call(4, { operation: 'add', ...draft }), exec) as { state_revision: number }
      assert.equal(added.state_revision, 5)
      const durable = await readDurableWorkspace(restarted, 'session-a')
      const items = level === 'step' ? durable.state.task_plan.steps : durable.sub_states[0]!.pending_sub_steps
      assert.equal((items.at(-1)! as unknown as Record<string, unknown>)[idKey], `${prefix}-000004`)
      await assert.rejects(reader.execute(call(4, { operation: 'delete', [idKey]: `${prefix}-000002` }), exec), /revision mismatch/)
      await assert.rejects(reader.execute(call(5, { operation: 'delete', [idKey]: `${prefix}-000003` }), exec), /existing pending/)
      assert.deepEqual(await readDurableWorkspace(restarted, 'session-a'), durable)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test('criteria replans apply several shared edits but commit only one complete State revision', async () => {
  for (const level of ['step', 'substep'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'governor-criteria-edit-'))
    try {
      const workspaces = new SessionWorkspaceProvider(root)
      await initializeWorkspace(workspaces.forSession('session-a'), {
        mission: 'Produce two results.', task_plan: plannedTaskPlan('First', 'Second'), user_constraints: [],
      }, [plannedSubState({ plan: {
        step_completion_criteria: ['Input inspected.', 'Output verified.'],
        sub_steps: [{ action: 'Inspect input.', covers: [0] }, { action: 'Verify output.', covers: [1] }],
      } })])
      const tools = registered(workspaces)
      const tool = tools.get(level === 'step' ? 'replan_task_criteria' : 'replan_step_criteria')!
      const baseArgs = {
        expected_state_revision: 1, source_events: ['event-8'], add_criteria: ['Corrected result verified.'],
        ...(level === 'step' ? { supersede_criterion_indexes: [1] } : {
          step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000001', supersede_criterion_ids: ['criterion-000002'],
        }),
      }
      const removal = level === 'step'
        ? { operation: 'delete', step_id: 'step-000002' }
        : { operation: 'delete', sub_step_id: 'sub-step-000002' }
      const addition = level === 'step'
        ? { operation: 'add', inputs: ['Evidence.'], step: 'Produce corrected result.', result: 'Corrected result.', covers: [2] }
        : { operation: 'add', inputs: ['Evidence.'], action: 'Produce corrected result.', result: 'Corrected result.', covers_criterion_indexes: [2] }
      const before = await readDurableWorkspace(workspaces, 'session-a')
      await assert.rejects(tool.execute({ ...baseArgs, changes: [removal] }, exec), /not covered/)
      assert.deepEqual(await readDurableWorkspace(workspaces, 'session-a'), before)
      const args = { ...baseArgs, changes: [removal, addition] }
      assert.deepEqual(validateJsonSchemaValue(tool.parameters, args, ''), [])
      const result = await tool.execute(args, exec) as { state_revision: number }
      assert.equal(result.state_revision, 2)
      const durable = await readDurableWorkspace(workspaces, 'session-a')
      assert.equal(durable.state.revision, 2)
      if (level === 'substep') assert.deepEqual(durable.sub_states[0]!.current_sub_step, before.sub_states[0]!.current_sub_step)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})
