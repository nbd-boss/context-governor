import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import { validateJsonSchemaValue } from '../../deepseek-harness/packages/core/tools/src/json-schema.ts'
import { registerStateTools } from '../src/tools/state-tools.ts'
import { registerPlanCurrentStepTool } from '../src/tools/plan-current-step-tool.ts'
import { registerAdvanceTaskProgressTool } from '../src/tools/advance-task-progress-tool.ts'
import { registerCriteriaReplanTools } from '../src/tools/criteria-replan-tools.ts'
import { registerArtifactTools } from '../src/tools/artifact-tools.ts'
import { registerReviseSubstepTool } from '../src/tools/revise-substep-tool.ts'
import { registerStateDeltaTools } from '../src/tools/state-delta-tools.ts'
import { registerSwitchContextTool } from '../src/tools/switch-context-tool.ts'
import { registerRecordContinuationTool } from '../src/tools/record-continuation-tool.ts'
import type { EpochController } from '../src/epoch/epoch-controller.ts'
import { initializeWorkspace, plannedSubState } from './test-fixtures.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { WorkspaceMutations } from '../src/workspace/workspace-mutations.ts'
import { plannedTaskPlan } from './test-fixtures.ts'
import { CRITERIA_REPLAN_GUIDANCE, formatDecisionCheck, PENDING_PLAN_REVISION_GUIDANCE, PLANNING_CORE_GUIDANCE, STEP_PLANNING_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE, TASK_COMPLETION_CRITERIA_GUIDANCE } from '../src/agent-guidance.ts'

function collect(register: (context: Context) => void): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  register({ tools: { register: tool => { tools.push(tool) } } } as unknown as Context)
  return tools
}

const eventContext = {
  agent: { session: { id: 'session-a', snapshotEvents: () => [
    { seq: 4, type: 'user/message' }, { seq: 8, type: 'tool/result' }, { seq: 9, type: 'tool/result' },
  ] } },
  concludeTurn: () => {},
} as never

const firstPlan = {
  step_completion_criteria: ['The input is inspected.', 'The result is verified.'],
  sub_steps: [
    { inputs: ['Input.'], action: 'Inspect input.', result: 'Known input.', covers_criterion_indexes: [0] },
    { inputs: ['Known input.'], action: 'Verify result.', result: 'Verified result.', covers_criterion_indexes: [1] },
  ],
}

test('tool schemas require reason only for the Context switch audit', () => {
  const workspaces = new SessionWorkspaceProvider('unused')
  const mutations = new WorkspaceMutations(workspaces)
  const tools = [
    ...collect(ctx => registerPlanCurrentStepTool(ctx, mutations)),
    ...collect(ctx => registerAdvanceTaskProgressTool(ctx, {} as EpochController, mutations)),
    ...collect(ctx => registerArtifactTools(ctx, workspaces, mutations)),
    ...collect(ctx => registerStateDeltaTools(ctx, mutations)),
    ...collect(ctx => registerCriteriaReplanTools(ctx, mutations)),
  ]
  for (const tool of tools) {
    const properties = tool.parameters.properties as Record<string, unknown>
    assert.equal('reason' in properties, false, tool.name)
  }
  const switchTool = collect(ctx => registerSwitchContextTool(ctx, {} as EpochController, mutations))[0]!
  assert.equal('reason' in (switchTool.parameters.properties as Record<string, unknown>), true)
})

test('planning tools point to the shared evidence and action-state checks without copying them', () => {
  const workspaces = new SessionWorkspaceProvider('unused')
  const mutations = new WorkspaceMutations(workspaces)
  const tools = [
    ...collect(ctx => registerPlanCurrentStepTool(ctx, mutations)),
    ...collect(ctx => registerReviseSubstepTool(ctx, mutations)),
  ]
  for (const tool of tools) {
    assert.match(tool.description, /context_governor\.decision_checks\.before_scope_or_external_change/, tool.name)
    assert.equal(tool.description.split('context_governor.decision_checks.after_reconnaissance').length - 1, 1, tool.name)
    assert.doesNotMatch(tool.description, /For each external action, inspect the target system schema/, tool.name)
  }
  const progress = collect(ctx => registerAdvanceTaskProgressTool(ctx, {} as EpochController, mutations))[0]!
  assert.match(progress.description, /post-action update or reconciliation and its read-back as part of the same Step/)
  assert.doesNotMatch(progress.description, /normalize every parent completion criterion/)
})

test('planning, replanning, and completion tools reference one exact-data policy without copying it', () => {
  const workspaces = new SessionWorkspaceProvider('unused')
  const mutations = new WorkspaceMutations(workspaces)
  const tools = [
    ...collect(ctx => registerPlanCurrentStepTool(ctx, mutations)),
    ...collect(ctx => registerReviseSubstepTool(ctx, mutations)),
    ...collect(ctx => registerCriteriaReplanTools(ctx, mutations)),
    ...collect(ctx => registerAdvanceTaskProgressTool(ctx, {} as EpochController, mutations)),
  ]
  assert.deepEqual(tools.map(tool => tool.name), ['plan_current_step', 'revise_substep', 'replan_task_criteria', 'replan_step_criteria', 'advance_task_progress'])
  for (const tool of tools) {
    assert.equal(tool.description.split('context_governor.exact_data_transfer_policy').length, 2, tool.name)
    assert.doesNotMatch(tool.description, /make source correspondence explicit in the affected Step completion criteria/, tool.name)
    assert.doesNotMatch(tool.description, /A spot check supports only the sampled records/, tool.name)
  }
})

test('both criteria replan tools share the requirement-change boundary rather than treating obstacles as permission', () => {
  assert.match(CRITERIA_REPLAN_GUIDANCE, /faithfully expresses the authoritative requirement separately from whether that requirement is currently achievable/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /original criterion misinterpreted the requirement/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /requirement has been explicitly changed/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /compare the authoritative requirement, original criterion, and proposed criterion/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /encoded an unsupported factual assumption/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /identify the authoritative wording or direct source observation that justifies the correction or change/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /correct an Agent-inferred quantity or boundary without a changed user request/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /preserving the required outcomes and complete scope/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /source_events must support that corrected interpretation or authorized change/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /not merely describe an execution obstacle or a guessed evaluation expectation/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /Execution failure, missing resources, or capability limits do not authorize reducing required scope/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /Infeasibility alone does not establish that the original criterion misinterpreted the requirement/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /leave the work unresolved rather than infer permission to waive either obligation/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /Evidence that a requirement cannot currently be met is not evidence that it may be waived/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /retain that requirement as unmet/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /existing handoff when applicable/)
  assert.match(CRITERIA_REPLAN_GUIDANCE, /report the blocker rather than superseding the criterion/)
  const tools = collect(ctx => registerCriteriaReplanTools(ctx, new WorkspaceMutations(new SessionWorkspaceProvider('unused'))))
  assert.deepEqual(tools.map(tool => tool.name), ['replan_task_criteria', 'replan_step_criteria'])
  for (const tool of tools) {
    assert.equal(tool.description.split(`\n\n${CRITERIA_REPLAN_GUIDANCE}`).length, 2)
    assert.doesNotMatch(tool.description, /Use only when current-Session evidence changes/)
    assert.equal('reason' in (tool.parameters.properties as Record<string, unknown>), false)
  }
})

test('preserves Guidance list boundaries in initialization, Step revision, and SubStep planning descriptions', () => {
  const workspaces = new SessionWorkspaceProvider('unused')
  const mutations = new WorkspaceMutations(workspaces)
  const initialization = collect(ctx => registerStateTools(ctx, workspaces))[0]!
  const revision = collect(ctx => registerStateDeltaTools(ctx, mutations)).find(tool => tool.name === 'revise_step')!
  const planning = collect(ctx => registerPlanCurrentStepTool(ctx, mutations))[0]!
  for (const guidance of [TASK_COMPLETION_CRITERIA_GUIDANCE, PLANNING_CORE_GUIDANCE, STEP_PLANNING_GUIDANCE]) {
    assert.ok(initialization.description.includes(`\n\n${guidance}`))
  }
  assert.ok(initialization.description.includes(`\n\n${formatDecisionCheck('before_scope_or_external_change')}`))
  for (const guidance of [PENDING_PLAN_REVISION_GUIDANCE, PLANNING_CORE_GUIDANCE, STEP_PLANNING_GUIDANCE]) {
    assert.ok(revision.description.includes(`\n\n${guidance}`))
  }
  for (const guidance of [PLANNING_CORE_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE]) {
    assert.ok(planning.description.includes(`\n\n${guidance}`))
  }
})

test('initialization activates the first Step without inventing a SubState', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-plan-init-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const tool = collect(ctx => registerStateTools(ctx, workspaces))[0]!
    const input = { mission: 'Produce two results.', task_plan: plannedTaskPlan('First', 'Second'), user_constraints: [] }
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, input, ''), [])
    assert.equal('current_step_plan' in tool.parameters, false)
    const state = await tool.execute(input, eventContext) as { revision: number; task_plan: { steps: Array<{ status: string }> } }
    assert.equal(state.revision, 1)
    assert.equal(state.task_plan.steps[0]?.status, 'in_progress')
    assert.deepEqual(await workspaces.forSession('session-a').sub_states.readAll(), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('planning and SubStep progress persist immediately and reject stale revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-plan-progress-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const mutations = new WorkspaceMutations(workspaces)
    await collect(ctx => registerStateTools(ctx, workspaces))[0]!.execute({
      mission: 'Produce two results.', task_plan: plannedTaskPlan('First', 'Second'), user_constraints: [],
    }, eventContext)
    const plan = collect(ctx => registerPlanCurrentStepTool(ctx, mutations))[0]!
    await assert.rejects(plan.execute({ expected_state_revision: 0, step_id: 'step-000001', plan: firstPlan }, eventContext), /revision mismatch/)
    const planned = await plan.execute({ expected_state_revision: 1, step_id: 'step-000001', plan: firstPlan }, eventContext) as { state_revision: number }
    assert.equal(planned.state_revision, 2)
    assert.equal((await workspaces.forSession('session-a').sub_states.readAll()).find(item => item.step_id === 'step-000001')?.current_sub_step?.sub_step_id, 'sub-step-000001')
    await assert.rejects(plan.execute({ expected_state_revision: 2, step_id: 'step-000001', plan: firstPlan }, eventContext), /already has a SubState/)
    const progress = collect(ctx => registerAdvanceTaskProgressTool(ctx, {} as EpochController, mutations))[0]!
    const advanced = await progress.execute({
      expected_state_revision: 2,
      transition: { type: 'advance_sub_step', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
        completed: { summary: 'Input is known.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-8'] }], artifact_refs: [] } },
    }, eventContext) as { state_revision: number }
    assert.equal(advanced.state_revision, 3)
    const saved = (await workspaces.forSession('session-a').sub_states.readAll()).find(item => item.step_id === 'step-000001')
    assert.equal(saved?.completed_sub_steps.length, 1)
    assert.equal(saved?.current_sub_step?.sub_step_id, 'sub-step-000002')
    assert.equal((await workspaces.forSession('session-a').state.read())?.revision, 3)
    await assert.rejects(progress.execute({
      expected_state_revision: 2,
      transition: { type: 'advance_step', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000002', next_step: { step_id: 'step-000002' },
        completed: { summary: 'Verified.', criterion_evidence: [{ criterion_id: 'criterion-000002', source_events: ['event-9'] }], artifact_refs: [] } },
    }, eventContext), /revision mismatch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('advance_step persists the next Step as active but unplanned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-next-step-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const mutations = new WorkspaceMutations(workspaces)
    await collect(ctx => registerStateTools(ctx, workspaces))[0]!.execute({ mission: 'Two results.', task_plan: plannedTaskPlan('First', 'Second'), user_constraints: [] }, eventContext)
    await collect(ctx => registerPlanCurrentStepTool(ctx, mutations))[0]!.execute({
      expected_state_revision: 1, step_id: 'step-000001',
      plan: { step_completion_criteria: ['First result is verified.'], sub_steps: [
        { inputs: ['Input.'], action: 'Produce first.', result: 'First.', covers_criterion_indexes: [0] },
      ] },
    }, eventContext)
    const tool = collect(ctx => registerAdvanceTaskProgressTool(ctx, {} as EpochController, mutations))[0]!
    const result = await tool.execute({
      expected_state_revision: 2,
      transition: { type: 'advance_step', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001', next_step: { step_id: 'step-000002' },
        completed: { summary: 'First verified.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-8'] }], artifact_refs: [] } },
    }, eventContext) as { state_revision: number; current_sub_state: unknown }
    assert.equal(result.state_revision, 3)
    assert.equal(result.current_sub_state, null)
    const workspace = workspaces.forSession('session-a')
    assert.equal((await workspace.state.read())?.task_plan.steps[1]?.status, 'in_progress')
    assert.equal((await workspace.sub_states.readAll()).find(item => item.step_id === 'step-000002'), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects an unclaimed Artifact before ending a Step and allows a corrected retry and switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-step-artifact-handoff-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root, () => root)
    const workspace = workspaces.forSession('session-a')
    const originalSubState = plannedSubState()
    const originalState = await initializeWorkspace(workspace, {
      mission: 'Produce two results.', task_plan: plannedTaskPlan('First', 'Second'), user_constraints: [],
    }, [originalSubState])
    const resource = join(root, 'result.json')
    await writeFile(resource, JSON.stringify([{ value: 1 }]), 'utf8')
    const mutations = new WorkspaceMutations(workspaces)
    const { artifact } = await mutations.registerArtifact('session-a', 1, ['event-8', 'event-9'], known => workspace.artifact_service.register({
      contains: { kind: 'result', summary: 'Verified result.', coverage: 'First Step.', key_facts: ['The value is 1.'], available_fields: ['value'] },
      resource: { path: resource, format: 'json' },
    }, known))
    const tool = collect(ctx => registerAdvanceTaskProgressTool(ctx, {} as EpochController, mutations))[0]!
    const transition = {
      type: 'advance_step', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
      next_step: { step_id: 'step-000002' },
      completed: { summary: 'Verified result is available.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-8'] }], artifact_refs: [] as Array<{ artifact_id: string; relation: string }> },
    }
    await assert.rejects(tool.execute({ expected_state_revision: 1, transition }, eventContext), /ending the current Step; missing: artifact-000001 \(source_events: event-8, event-9\)/)
    assert.deepEqual(await workspace.state.read(), originalState)
    assert.deepEqual(await workspace.sub_states.readAll(), [originalSubState])
    assert.deepEqual(await workspace.artifacts.readAll(), [])
    transition.completed.artifact_refs = [{ artifact_id: artifact.artifact_id, relation: 'produced' }]
    await assert.rejects(tool.execute({ expected_state_revision: 1, transition }, eventContext), /artifact-000001; missing source_events: event-9/)
    assert.deepEqual(await workspace.state.read(), originalState)
    transition.completed.criterion_evidence[0]!.source_events.push('event-9')
    const result = await tool.execute({ expected_state_revision: 1, transition }, eventContext) as { state_revision: number }
    assert.equal(result.state_revision, 2)
    assert.equal((await workspace.state.read())!.task_plan.steps[1]!.status, 'in_progress')
    assert.equal((await workspace.artifacts.readAll())[0]!.artifact_id, artifact.artifact_id)
    assert.equal((await mutations.switchSnapshot('session-a', 2, [])).state.revision, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('criterion replan keeps completed references and commits criteria with pending coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-replan-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const mutations = new WorkspaceMutations(workspaces)
    await collect(ctx => registerStateTools(ctx, workspaces))[0]!.execute({ mission: 'Two results.', task_plan: plannedTaskPlan('First', 'Second'), user_constraints: [] }, eventContext)
    const tool = collect(ctx => registerCriteriaReplanTools(ctx, mutations)).find(item => item.name === 'replan_task_criteria')!
    const revised = await tool.execute({ source_events: ['event-8'], expected_state_revision: 1,
      supersede_criterion_indexes: [1], add_criteria: ['The corrected second result is verified.'],
      changes: [{ operation: 'update', step_id: 'step-000002', inputs: ['New rule.'], step: 'Corrected second', result: 'Corrected second result.', covers: [2] }],
    }, eventContext) as { state_revision: number }
    assert.equal(revised.state_revision, 2)
    const saved = (await workspaces.forSession('session-a').state.read())!.task_plan
    assert.equal(saved.completion_criteria[1], 'Second is complete.')
    assert.equal(saved.completion_criteria[2], 'The corrected second result is verified.')
    assert.deepEqual(saved.superseded_criteria, [1])
    assert.deepEqual(saved.steps[1]?.covers, [2])
    await assert.rejects(tool.execute({ source_events: ['event-8'], expected_state_revision: 2,
      supersede_criterion_indexes: [2], add_criteria: ['New goal.'], changes: [],
    }, eventContext), /superseded criterion/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pending SubStep replanning writes immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-pending-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const mutations = new WorkspaceMutations(workspaces)
    await collect(ctx => registerStateTools(ctx, workspaces))[0]!.execute({ mission: 'One result.', task_plan: plannedTaskPlan('First'), user_constraints: [] }, eventContext)
    await collect(ctx => registerPlanCurrentStepTool(ctx, mutations))[0]!.execute({ expected_state_revision: 1, step_id: 'step-000001', plan: firstPlan }, eventContext)
    const tool = collect(ctx => registerReviseSubstepTool(ctx, mutations))[0]!
    await tool.execute({ expected_state_revision: 2, step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000001',
      change: { operation: 'update', sub_step_id: 'sub-step-000002', inputs: ['Known input.'], action: 'Verify result by new route.', result: 'Verified.', covers_criterion_ids: ['criterion-000002'] },
    }, eventContext)
    assert.equal((await workspaces.forSession('session-a').sub_states.readAll()).find(item => item.step_id === 'step-000001')?.pending_sub_steps[0]?.action, 'Verify result by new route.')
    assert.equal((await workspaces.forSession('session-a').state.read())?.revision, 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Step criterion replan preserves completed evidence and updates pending work in one write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-step-replan-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const mutations = new WorkspaceMutations(workspaces)
    await collect(ctx => registerStateTools(ctx, workspaces))[0]!.execute({ mission: 'One result.', task_plan: plannedTaskPlan('First'), user_constraints: [] }, eventContext)
    await collect(ctx => registerPlanCurrentStepTool(ctx, mutations))[0]!.execute({ expected_state_revision: 1, step_id: 'step-000001', plan: firstPlan }, eventContext)
    await collect(ctx => registerAdvanceTaskProgressTool(ctx, {} as EpochController, mutations))[0]!.execute({
      expected_state_revision: 2,
      transition: { type: 'advance_sub_step', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
        completed: { summary: 'Input is known.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-8'] }], artifact_refs: [] } },
    }, eventContext)
    const before = (await workspaces.forSession('session-a').sub_states.readAll()).find(item => item.step_id === 'step-000001')!
    const tool = collect(ctx => registerCriteriaReplanTools(ctx, mutations)).find(item => item.name === 'replan_step_criteria')!
    await assert.rejects(tool.execute({
      source_events: ['event-9'], expected_state_revision: 3,
      step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000002',
      supersede_criterion_ids: ['criterion-000002'], add_criteria: ['Corrected result is verified.'], changes: [],
    }, eventContext), /not covered/)
    assert.equal((await workspaces.forSession('session-a').state.read())?.revision, 3)
    const result = await tool.execute({
      source_events: ['event-9'], expected_state_revision: 3,
      step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000002',
      supersede_criterion_ids: ['criterion-000002'], add_criteria: ['Corrected result is verified.'],
      changes: [{ operation: 'add', inputs: ['Evidence.'], action: 'Verify corrected result.', result: 'Corrected result.',
        covers_criterion_indexes: [2] }],
    }, eventContext) as { state_revision: number }
    assert.equal(result.state_revision, 4)
    const after = (await workspaces.forSession('session-a').sub_states.readAll()).find(item => item.step_id === 'step-000001')!
    assert.deepEqual(after.completed_sub_steps, before.completed_sub_steps)
    assert.deepEqual(after.current_sub_step, before.current_sub_step)
    assert.deepEqual(after.superseded_criterion_ids, ['criterion-000002'])
    assert.deepEqual(after.pending_sub_steps[0]?.covers, ['criterion-000003'])
    await assert.rejects(tool.execute({
      source_events: ['event-9'], expected_state_revision: 3,
      step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000002',
      supersede_criterion_ids: [], add_criteria: ['Another.'], changes: [],
    }, eventContext), /revision mismatch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch_context accepts an unplanned active Step and does not bump State revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-unplanned-switch-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    const mutations = new WorkspaceMutations(workspaces)
    await collect(ctx => registerStateTools(ctx, workspaces))[0]!.execute({ mission: 'One result.', task_plan: plannedTaskPlan('First'), user_constraints: [] }, eventContext)
    let switched = false
    let concluded = false
    const epochs = { requestSwitch: async () => { switched = true } } as unknown as EpochController
    const tool = collect(ctx => registerSwitchContextTool(ctx, epochs, mutations))[0]!
    const result = await tool.execute({ reason: 'Restart for fresh context.', expected_state_revision: 1, new_discovered_constraints: [] }, {
      agent: { session: { id: 'session-a' } }, concludeTurn: () => { concluded = true },
    } as never) as { state_revision: number }
    assert.equal(result.state_revision, 1)
    assert.equal((await workspaces.forSession('session-a').state.read())?.revision, 1)
    assert.deepEqual(await workspaces.forSession('session-a').sub_states.readAll(), [])
    assert.equal(switched, true)
    assert.equal(concluded, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Continuation and terminal completion each persist at their own successful call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-continuation-complete-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root, () => root)
    const mutations = new WorkspaceMutations(workspaces)
    await collect(ctx => registerStateTools(ctx, workspaces))[0]!.execute({ mission: 'One result.', task_plan: plannedTaskPlan('First'), user_constraints: [] }, eventContext)
    const continuationTool = collect(ctx => registerRecordContinuationTool(ctx, workspaces, mutations))[0]!
    assert.equal(continuationTool.name, 'record_continuation')
    await assert.rejects(continuationTool.execute({ operation: 'wait_for_input', progress: 'Some work.', working_resources: [], resume_from: 'Wait for the missing input.' }, eventContext), /current SubStep/)
    await collect(ctx => registerPlanCurrentStepTool(ctx, mutations))[0]!.execute({
      expected_state_revision: 1, step_id: 'step-000001', plan: {
        step_completion_criteria: ['Result verified.'], sub_steps: [{ inputs: ['Input.'], action: 'Produce result.', result: 'Result.', covers_criterion_indexes: [0] }],
      },
    }, eventContext)
    const resource = join(root, 'working.json')
    await writeFile(resource, '{"partial":true}', 'utf8')
    const recorded = await continuationTool.execute({
      operation: 'save', progress: 'The first portion is saved.', working_resources: [{ path: resource, contains: 'First portion.' }], resume_from: 'Verify the remaining portion.',
    }, eventContext) as { state_revision: number }
    assert.equal(recorded.state_revision, 3)
    assert.equal((await workspaces.forSession('session-a').sub_states.readAll()).find(item => item.step_id === 'step-000001')?.current_sub_step?.continuation?.resume_from, 'Verify the remaining portion.')
    let closed = false
    let auditReason = ''
    const epochs = { complete: async (_agent: unknown, reason: string) => { closed = true; auditReason = reason } } as unknown as EpochController
    const completion = await collect(ctx => registerAdvanceTaskProgressTool(ctx, epochs, mutations))[0]!.execute({
      expected_state_revision: 3,
      transition: { type: 'complete_task', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
        task_criteria_check: [{ criterion_index: 0, outcome: 'met', source_events: ['event-9'] }],
        completed: { summary: 'Result verified.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-9'] }], artifact_refs: [] } },
    }, eventContext) as { state_revision: number }
    assert.equal(completion.state_revision, 4)
    assert.equal((await workspaces.forSession('session-a').state.read())?.lifecycle.status, 'completed')
    assert.equal((await workspaces.forSession('session-a').sub_states.readAll()).find(item => item.step_id === 'step-000001')?.current_sub_step, null)
    assert.equal(closed, true)
    assert.equal(auditReason, 'Result verified.')
  } finally { await rm(root, { recursive: true, force: true }) }
})
