import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlannedTaskPlan, revisePendingTaskPlan } from '../src/planning/step-plan.ts'

const draft = {
  completion_criteria: ['The cause is known.', 'The fix is verified.'],
  steps: [
    { inputs: ['Failing behavior.'], step: 'Locate the cause.', result: 'Verified root cause.', covers: [0] },
    { inputs: ['Verified root cause.'], step: 'Implement and verify the fix.', result: 'Verified fix.', covers: [1] },
  ],
}

test('plans ordered Steps while persisting only stable task-level authority', () => {
  const plan = createPlannedTaskPlan(draft)
  assert.deepEqual(plan, {
    completion_criteria: draft.completion_criteria,
    steps: [
      { step_id: 'step-000001', step: 'Locate the cause.', status: 'in_progress', covers: [0] },
      { step_id: 'step-000002', step: 'Implement and verify the fix.', status: 'pending', covers: [1] },
    ],
  })
  assert.equal('inputs' in plan.steps[0]!, false)
  assert.equal('result' in plan.steps[0]!, false)
})

test('rejects incomplete coverage, invalid indexes, duplicates, and the old status input', () => {
  assert.throws(() => createPlannedTaskPlan({ ...draft, steps: [draft.steps[0]!] }), /completion_criteria\[1\] is not covered/)
  assert.throws(() => createPlannedTaskPlan({ ...draft, steps: [{ ...draft.steps[0]!, covers: [2] }, draft.steps[1]!] }), /valid completion-criteria index/)
  assert.throws(() => createPlannedTaskPlan({ ...draft, completion_criteria: ['Same.', 'Same.'] }), /must not contain duplicates/)
  assert.throws(() => createPlannedTaskPlan({
    ...draft,
    steps: [{ ...draft.steps[0]!, status: 'in_progress' }, draft.steps[1]!],
  } as never), /unexpected field: status/)
})

test('replans only Pending Steps while retaining IDs and complete task coverage', () => {
  const initial = createPlannedTaskPlan(draft)
  const revised = revisePendingTaskPlan(initial, [{
    step_id: 'step-000002',
    inputs: ['Verified root cause.'],
    step: 'Implement the fix.',
    result: 'Implemented fix.',
    covers: [1],
  }, {
    inputs: ['Implemented fix.'],
    step: 'Run final verification.',
    result: 'Verified final behavior.',
    covers: [1],
  }])
  assert.deepEqual(revised.steps.map(step => step.step_id), ['step-000001', 'step-000002', 'step-000003'])
  assert.equal(revised.steps[1]?.step, 'Implement the fix.')
  assert.throws(() => revisePendingTaskPlan(initial, []), /completion_criteria\[1\] is not covered/)
  assert.throws(() => revisePendingTaskPlan(initial, [{
    step_id: 'step-000001', inputs: ['Input.'], step: 'Rewrite active.', result: 'Changed active.', covers: [1],
  }]), /Only pending Step IDs/)
})
