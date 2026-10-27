import assert from 'node:assert/strict'
import test from 'node:test'

import { advanceStep, advanceSubStep, planCurrentStep, recordContinuation, reviseSubStep } from '../src/epoch/epoch-projection.ts'
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
        { action: 'Trigger a timeout retry.', covers: [0] },
        { action: 'Trace key generation.', covers: [1] },
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
    completed: { summary: 'One retry creates two charges.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-4'] }], artifact_refs: [] },
  })
  assert.equal(projected.state.revision, 1)
  assert.equal(projected.sub_states[0]?.completed_sub_steps[0]?.action, 'Trigger a timeout retry.')
  assert.equal(projected.sub_states[0]?.current_sub_step?.sub_step_id, 'sub-step-000002')
  assert.equal(projected.sub_states[0]?.pending_sub_steps.length, 0)
})

test('moves Step ownership atomically while leaving the next Step unplanned', () => {
  const afterFirst = advanceSubStep(workspace(), {
    step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
    completed: { summary: 'The duplicate is reproduced.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-4'] }], artifact_refs: [] },
  })
  const projected = advanceStep(afterFirst, {
    step_id: 'step-000001',
    expected_sub_step_id: 'sub-step-000002',
    completed: { summary: 'The key owner is known.', criterion_evidence: [{ criterion_id: 'criterion-000002', source_events: ['event-5'] }], artifact_refs: [] },
    next_step: { step_id: 'step-000002' },
  })
  assert.deepEqual(projected.state.task_plan.steps.map(step => step.status), ['done', 'in_progress'])
  assert.equal(projected.sub_states.length, 1)
  assert.equal(projected.sub_states[0]?.current_sub_step, null)
  const planned = planCurrentStep(projected, { step_id: 'step-000002', plan: {
    step_completion_criteria: ['One retry chain shares one key.'],
    sub_steps: [{ inputs: ['Retry boundary.'], action: 'Pass one key through retry.', result: 'Stable retry key propagation.', covers: [0] }],
  } })
  assert.equal(planned.sub_states[1]?.current_sub_step?.sub_step_id, 'sub-step-000003')
  assert.equal(planned.sub_states[1]?.step_completion_criteria[0]?.criterion_id, 'criterion-000003')
})

test('a final-SubStep rejection points to the completion policy without advancing the Step', () => {
  const initial = advanceSubStep(workspace(), {
    step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
    completed: { summary: 'The duplicate is reproduced.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-4'] }], artifact_refs: [] },
  })
  const before = structuredClone(initial)
  assert.throws(() => advanceSubStep(initial, {
    step_id: 'step-000001', expected_sub_step_id: 'sub-step-000002',
    completed: { summary: 'The key owner is known.', criterion_evidence: [{ criterion_id: 'criterion-000002', source_events: ['event-5'] }], artifact_refs: [] },
  }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /at least one pending SubStep/)
    assert.match(error.message, /Before choosing advance_step or complete_task/)
    assert.match(error.message, /apply context_governor\.decision_checks\.before_completion/)
    assert.match(error.message, /if the promised result remains unmet, keep the Step active/)
    assert.doesNotMatch(error.message, /use advance_step at the Step boundary/)
    return true
  })
  assert.deepEqual(initial, before)
  assert.equal(initial.state.task_plan.steps[0]?.status, 'in_progress')
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
    completed: { summary: 'The duplicate is reproduced.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-4'] }], artifact_refs: [] },
  })
  assert.equal(completed.sub_states[0]?.current_sub_step?.continuation, null)
  assert.equal('continuation' in completed.sub_states[0]!.completed_sub_steps[0]!, false)
})


test('edits one pending SubStep while retaining other identities and rejects incomplete coverage', () => {
  const initial = workspace()
  const identity = { step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000001' }
  const criterion = initial.sub_states[0]!.step_completion_criteria[1]!.criterion_id
  const added = reviseSubStep(initial, { ...identity, change: {
    operation: 'add', inputs: ['Retry implementation.'], action: 'Confirm key ownership.', result: 'Verified key owner.', covers: [criterion],
  } })
  assert.equal(added.sub_states[0]?.pending_sub_steps[1]?.sub_step_id, 'sub-step-000003')
  const updated = reviseSubStep(added, { ...identity, change: {
    operation: 'update', sub_step_id: 'sub-step-000002', inputs: ['Retry implementation.'], action: 'Locate key creation.', result: 'Key location.', covers: [criterion],
  } })
  assert.equal(updated.sub_states[0]?.pending_sub_steps[0]?.sub_step_id, 'sub-step-000002')
  assert.deepEqual(updated.sub_states[0]?.current_sub_step, initial.sub_states[0]?.current_sub_step)
  assert.deepEqual(updated.sub_states[0]?.step_completion_criteria, initial.sub_states[0]?.step_completion_criteria)
  const deleted = reviseSubStep(updated, { ...identity, change: { operation: 'delete', sub_step_id: 'sub-step-000003' } })
  const restored = reviseSubStep(JSON.parse(JSON.stringify(deleted)), { ...identity, change: {
    operation: 'add', inputs: ['Key location.'], action: 'Confirm ownership.', result: 'Key owner.', covers: [criterion],
  } })
  assert.equal(restored.sub_states[0]?.pending_sub_steps[1]?.sub_step_id, 'sub-step-000004')
  assert.throws(() => reviseSubStep(initial, { ...identity, change: { operation: 'delete', sub_step_id: 'sub-step-000002' } }), /not covered/)
  assert.throws(() => reviseSubStep(initial, { ...identity, change: { operation: 'delete', sub_step_id: 'sub-step-000001' } }), /existing pending/)
  assert.throws(() => reviseSubStep(initial, { ...identity, change: { operation: 'delete', sub_step_id: 'sub-step-999999' } }), /existing pending/)
  assert.throws(() => reviseSubStep(initial, { ...identity, expected_current_sub_step_id: 'sub-step-999999', change: { operation: 'delete', sub_step_id: 'sub-step-000002' } }), /does not match/)
  assert.throws(() => reviseSubStep(initial, { ...identity, change: {
    operation: 'add', inputs: ['Input.'], action: 'Invalid work.', result: 'Result.', covers: ['criterion-999999'],
  } }), /unknown criterion_id/)
})
