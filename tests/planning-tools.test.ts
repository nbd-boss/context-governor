import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import { validateJsonSchemaValue } from '../../deepseek-harness/packages/core/tools/src/json-schema.ts'

import { registerAdvanceTaskProgressTool } from '../src/tools/advance-task-progress-tool.ts'
import { EpochDeltaBuffer } from '../src/epoch/epoch-delta-buffer.ts'
import type { EpochController } from '../src/epoch/epoch-controller.ts'
import { registerReplacePendingSubStepPlanTool } from '../src/tools/replace-pending-sub-step-plan-tool.ts'
import type { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { SessionWorkspaceProvider as Workspaces } from '../src/workspace/session-workspace.ts'
import { registerStateDeltaTools } from '../src/tools/state-delta-tools.ts'
import { registerStateTools } from '../src/tools/state-tools.ts'
import { TASK_COMPLETION_CRITERIA_GUIDANCE } from '../src/agent-guidance.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

function collect(register: (context: Context) => void): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  register({ tools: { register: tool => { tools.push(tool) } } } as unknown as Context)
  return tools
}

test('initialization accepts one complete active Step plan and rejects the old current-only shape', () => {
  const tool = collect(context => registerStateTools(context, undefined as unknown as SessionWorkspaceProvider))[0]!
  const valid = {
    mission: 'Fix duplicate charges.',
    task_plan: plannedTaskPlan('Find the boundary.'),
    current_step_plan: {
      step_completion_criteria: ['The boundary is known.'],
      sub_steps: [{ inputs: ['Retry implementation.'], action: 'Trace retry.', result: 'Verified retry boundary.', completion_criteria: ['The boundary is verified.'], covers: [0] }],
    },
    user_constraints: [],
  }
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, valid, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, {
    ...valid,
    task_plan: [{ step: 'Find the boundary.', status: 'in_progress' }],
  }, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, {
    mission: valid.mission, task_plan: valid.task_plan,
    current_sub_step: { action: 'Trace retry.', completion_criteria: ['Done.'] }, user_constraints: [],
  }, ''), [])
  assert.match(tool.description, new RegExp(TASK_COMPLETION_CRITERIA_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('Pending Step replanning requires result-first fields and task-criterion coverage', () => {
  const tool = collect(context => registerStateDeltaTools(
    context,
    undefined as unknown as SessionWorkspaceProvider,
    new EpochDeltaBuffer(),
  )).find(candidate => candidate.name === 'revise_task_plan')!
  const valid = {
    reason: 'The verification boundary changed.',
    expected_epoch_revision: 1,
    pending_steps: [{
      step_id: 'step-000002',
      inputs: ['Implemented fix.'],
      step: 'Run complete verification.',
      result: 'Verified task behavior.',
      covers: [1],
    }],
  }
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, valid, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, {
    ...valid,
    pending_steps: [{ step_id: 'step-000002', step: 'Run complete verification.' }],
  }, ''), [])
})

test('initialization persists State and the complete active Step plan atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-planning-tool-'))
  try {
    const workspaces = new Workspaces(directory)
    const tool = collect(context => registerStateTools(context, workspaces))[0]!
    await tool.execute({
      mission: 'Fix duplicate charges.',
      task_plan: plannedTaskPlan('Find the boundary.'),
      current_step_plan: {
        step_completion_criteria: ['The duplicate is reproduced.', 'The boundary is known.'],
        sub_steps: [
          { inputs: ['Retry scenario.'], action: 'Reproduce the duplicate.', result: 'Reproduction evidence.', completion_criteria: ['The duplicate is reproduced.'], covers: [0] },
          { inputs: ['Retry implementation.'], action: 'Trace the boundary.', result: 'Verified retry boundary.', completion_criteria: ['The boundary is known.'], covers: [1] },
        ],
      },
      user_constraints: [],
    }, { agent: { session: { id: 'session-a' } } } as never)
    const workspace = workspaces.forSession('session-a')
    assert.equal((await workspace.state.read())?.revision, 1)
    const subState = await workspace.sub_states.read('step-000001')
    assert.equal(subState?.current_sub_step?.sub_step_id, 'sub-step-000001')
    assert.deepEqual(subState?.pending_sub_steps.map(item => item.sub_step_id), ['sub-step-000002'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('advance_task_progress gives every progress boundary one exclusive shape', () => {
  const tool = collect(context => registerAdvanceTaskProgressTool(
    context,
    undefined as unknown as SessionWorkspaceProvider,
    undefined as unknown as EpochController,
    new EpochDeltaBuffer(),
  ))[0]!
  const valid = {
    reason: 'The first unit is complete.', expected_epoch_revision: 0,
    transition: {
      type: 'advance_sub_step', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
      completed: { summary: 'Verified.', source_events: ['event-4'], artifact_refs: [] },
    },
  }
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, valid, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, {
    ...valid,
    transition: { ...valid.transition, next_current_sub_step: { action: 'Next.', completion_criteria: ['Done.'] } },
  }, ''), [])
  const boundary = {
    reason: 'The Step is complete.', expected_epoch_revision: 1,
    transition: {
      type: 'advance_step', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000002',
      completed: { summary: 'Verified.', source_events: ['event-5'], artifact_refs: [] },
      next_step: {
        step_id: 'step-000002',
        plan: {
          step_completion_criteria: ['The fix is verified.'],
          sub_steps: [{ inputs: ['Verified retry boundary.'], action: 'Implement the fix.', result: 'Verified retry fix.', completion_criteria: ['Tests pass.'], covers: [0] }],
        },
      },
    },
  }
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, boundary, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, {
    ...boundary, transition: { ...boundary.transition, next_step: undefined },
  }, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, {
    ...boundary, transition: { ...boundary.transition, next_step: null },
  }, ''), [])
  const completion = {
    reason: 'The entire task is complete.', expected_epoch_revision: 2,
    transition: {
      type: 'complete_task', step_id: 'step-000002', expected_sub_step_id: 'sub-step-000003',
      completed: { summary: 'All checks pass.', source_events: ['event-6'], artifact_refs: [] },
    },
  }
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, completion, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, {
    ...completion, transition: { ...completion.transition, next_step: boundary.transition.next_step },
  }, ''), [])
})

test('complete_task atomically closes the final SubStep, Step, lifecycle, and Epoch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-task-completion-'))
  try {
    const workspaces = new Workspaces(directory)
    const workspace = workspaces.forSession('session-a')
    await workspace.state.initialize({
      mission: 'Fix duplicate charges.',
      task_plan: plannedTaskPlan('Run regression tests.'),
      user_constraints: [],
    })
    await workspace.sub_states.save(plannedSubState({ plan: {
      step_completion_criteria: ['All payment tests pass.'],
      sub_steps: [{ action: 'Run payment tests.', completion_criteria: ['All payment tests pass.'], covers: [0] }],
    } }))
    let epochCompleted = false
    const epochs = {
      complete: async () => { epochCompleted = true },
    } as unknown as EpochController
    const deltas = new EpochDeltaBuffer()
    const tool = collect(context => registerAdvanceTaskProgressTool(context, workspaces, epochs, deltas))[0]!
    let turnConcluded = false
    const result = await tool.execute({
      reason: 'All acceptance checks pass.', expected_epoch_revision: 0,
      transition: {
        type: 'complete_task', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
        completed: { summary: 'All payment tests pass.', source_events: ['event-8'], artifact_refs: [] },
      },
    }, {
      agent: { session: { id: 'session-a', snapshotEvents: () => [{ seq: 8 }] } },
      concludeTurn: () => { turnConcluded = true },
    } as never) as { status: string; state: { lifecycle: { status: string } }; current_sub_state: unknown }

    const savedState = await workspace.state.read()
    const savedSubState = await workspace.sub_states.read('step-000001')
    assert.equal(result.status, 'completed')
    assert.equal(result.state.lifecycle.status, 'completed')
    assert.equal(result.current_sub_state, null)
    assert.equal(savedState?.task_plan.steps[0]?.status, 'done')
    assert.equal(savedState?.lifecycle.status, 'completed')
    assert.equal(savedSubState?.current_sub_step, null)
    assert.equal(savedSubState?.completed_sub_steps.length, 1)
    assert.equal(epochCompleted, true)
    assert.equal(turnConcluded, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Pending replanning requires identity, revision, reason, and a complete replacement list', () => {
  const tool = collect(context => registerReplacePendingSubStepPlanTool(
    context,
    undefined as unknown as SessionWorkspaceProvider,
    new EpochDeltaBuffer(),
  ))[0]!
  const valid = {
    reason: 'Split collection and verification.', expected_epoch_revision: 1,
    step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000001',
    pending_sub_steps: [{
      inputs: ['Source records.'], action: 'Collect rows.', result: 'Complete row set.', completion_criteria: ['All rows exist.'], covers: ['criterion-000002'],
    }],
  }
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, valid, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.parameters, { ...valid, reason: undefined }, ''), [])
  assert.match(tool.description, /never changes step_completion_criteria, completed_sub_steps, or current_sub_step/)
})

test('planning tool schemas require transient inputs and result', () => {
  const initialize = collect(context => registerStateTools(context, undefined as unknown as SessionWorkspaceProvider))[0]!
  const value = {
    mission: 'Fix duplicate charges.',
    task_plan: plannedTaskPlan('Find the boundary.'),
    current_step_plan: {
      step_completion_criteria: ['The boundary is known.'],
      sub_steps: [{ action: 'Trace retry.', completion_criteria: ['The boundary is verified.'], covers: [0] }],
    },
    user_constraints: [],
  }
  assert.notDeepEqual(validateJsonSchemaValue(initialize.parameters, value, ''), [])
})

