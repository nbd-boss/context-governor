import assert from 'node:assert/strict'
import test from 'node:test'

import { advanceStep, advanceSubStep, recordContinuation, replacePendingSubStepPlan, stampBoundaryRevision } from '../src/epoch/epoch-projection.ts'
import { createInitialState } from '../src/state/state-contract.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

function workspace() {
  const state = createInitialState({
    mission: 'Fix duplicate charges.',
    task_plan: plannedTaskPlan('Reproduce the bug.', 'Fix key propagation.'),
    user_constraints: [],
  })
  return {
    state,
    sub_states: [plannedSubState({ plan: {
      step_completion_criteria: ['The duplicate is reproduced.', 'The key owner is known.'],
      sub_steps: [
        { action: 'Trigger a timeout retry.', completion_criteria: ['Two charges are observed.'], covers: [0] },
        { action: 'Trace key generation.', completion_criteria: ['Key owner is known.'], covers: [1] },
      ],
    } })],
    artifacts: [],
  }
}

test('moves the active SubStep into completed and activates the planned pending item', () => {
  const initial = workspace()
  const projected = advanceSubStep(initial, {
    step_id: 'step-000001',
    expected_sub_step_id: 'sub-step-000001',
    completed: { summary: 'One retry creates two charges.', source_events: ['event-4'], artifact_refs: [] },
  })
  assert.equal(projected.state.revision, 1)
  assert.equal(projected.sub_states[0]?.completed_sub_steps[0]?.action, 'Trigger a timeout retry.')
  assert.equal(projected.sub_states[0]?.current_sub_step?.sub_step_id, 'sub-step-000002')
  assert.equal(projected.sub_states[0]?.pending_sub_steps.length, 0)
})

test('moves Step ownership atomically and creates a complete plan for the next Step', () => {
  const afterFirst = advanceSubStep(workspace(), {
    step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
    completed: { summary: 'The duplicate is reproduced.', source_events: ['event-4'], artifact_refs: [] },
  })
  const projected = advanceStep(afterFirst, {
    step_id: 'step-000001',
    expected_sub_step_id: 'sub-step-000002',
    completed: { summary: 'The key owner is known.', source_events: ['event-5'], artifact_refs: [] },
    next_step: {
      step_id: 'step-000002',
      plan: {
        step_completion_criteria: ['One retry chain shares one key.'],
        sub_steps: [{ inputs: ['Retry boundary.'], action: 'Pass one key through retry.', result: 'Stable retry key propagation.', completion_criteria: ['The retry uses one key.'], covers: [0] }],
      },
    },
  })
  assert.deepEqual(projected.state.task_plan.steps.map(step => step.status), ['done', 'in_progress'])
  assert.equal(projected.sub_states.length, 2)
  assert.equal(projected.sub_states[0]?.current_sub_step, null)
  assert.equal(projected.sub_states[1]?.current_sub_step?.sub_step_id, 'sub-step-000003')
  assert.equal(projected.sub_states[1]?.step_completion_criteria[0]?.criterion_id, 'criterion-000003')
  assert.equal(stampBoundaryRevision(workspace().state, projected).state.revision, 2)
})

test('replaces current continuation and removes it when that SubStep completes', () => {
  const first = recordContinuation(workspace(), {
    progress: 'Courses 1 through 40 are saved.',
    working_resources: [{ path: 'E:\\workspace\\announcements-working.json', contains: 'Courses 1 through 40.' }],
    resume_from: 'Continue with course 41.',
  })
  const replaced = recordContinuation(first, {
    progress: 'Courses 1 through 80 are saved.',
    working_resources: [{ path: 'E:\\workspace\\announcements-working.json', contains: 'Courses 1 through 80.' }],
    resume_from: 'Continue with course 81.',
  })
  const completed = advanceSubStep(replaced, {
    step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
    completed: { summary: 'The duplicate is reproduced.', source_events: ['event-4'], artifact_refs: [] },
  })
  assert.equal(completed.sub_states[0]?.current_sub_step?.continuation, null)
  assert.equal('continuation' in completed.sub_states[0]!.completed_sub_steps[0]!, false)
})

test('replaces only pending work and assigns fresh identities', () => {
  const initial = workspace()
  const criterion = initial.sub_states[0]!.step_completion_criteria[1]!.criterion_id
  const projected = replacePendingSubStepPlan(initial, {
    step_id: 'step-000001',
    expected_current_sub_step_id: 'sub-step-000001',
    pending_sub_steps: [
      { inputs: ['Retry implementation.'], action: 'Locate key creation.', result: 'Key creation location.', completion_criteria: ['The creation call is known.'], covers: [criterion] },
      { inputs: ['Key creation location.'], action: 'Confirm key ownership.', result: 'Verified key owner.', completion_criteria: ['The owner is verified.'], covers: [criterion] },
    ],
  })
  assert.deepEqual(projected.sub_states[0]?.completed_sub_steps, initial.sub_states[0]?.completed_sub_steps)
  assert.deepEqual(projected.sub_states[0]?.current_sub_step, initial.sub_states[0]?.current_sub_step)
  assert.deepEqual(projected.sub_states[0]?.step_completion_criteria, initial.sub_states[0]?.step_completion_criteria)
  assert.deepEqual(projected.sub_states[0]?.pending_sub_steps.map(item => item.sub_step_id), ['sub-step-000003', 'sub-step-000004'])
  assert.equal('inputs' in projected.sub_states[0]!.pending_sub_steps[0]!, false)
  assert.equal('result' in projected.sub_states[0]!.pending_sub_steps[0]!, false)
  assert.throws(() => replacePendingSubStepPlan(initial, {
    step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-999999', pending_sub_steps: [],
  }), /does not match the current SubStep/)
  assert.throws(() => replacePendingSubStepPlan(initial, {
    step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000001',
    pending_sub_steps: [{ inputs: ['Input.'], action: 'Invalid work.', result: 'Invalid result.', completion_criteria: ['Invalid.'], covers: ['criterion-999999'] }],
  }), /unknown criterion_id/)
  assert.throws(() => replacePendingSubStepPlan(initial, {
    step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000001', pending_sub_steps: [],
  }), /not covered by any SubStep/)
})
