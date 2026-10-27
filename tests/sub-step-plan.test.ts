import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlannedSubState } from '../src/planning/sub-step-plan.ts'

const plan = {
  step_completion_criteria: ['The complete range is known.', 'Every item is filtered.'],
  sub_steps: [
    { inputs: ['Source records.'], action: 'Confirm the complete range.', result: 'The complete range.', covers: [0] },
    { inputs: ['The complete range.'], action: 'Filter every item.', result: 'The filtered item set.', covers: [1] },
  ],
}

test('allocates stable criteria and SubStep identities from one complete plan', () => {
  const state = createPlannedSubState({
    step_id: 'step-000001', plan,
    used_criterion_ids: [], used_sub_step_ids: [],
  })
  assert.deepEqual(state.step_completion_criteria.map(item => item.criterion_id), ['criterion-000001', 'criterion-000002'])
  assert.equal(state.current_sub_step?.sub_step_id, 'sub-step-000001')
  assert.deepEqual(state.pending_sub_steps.map(item => item.sub_step_id), ['sub-step-000002'])
  assert.deepEqual(state.pending_sub_steps[0]?.covers, ['criterion-000002'])
  assert.equal('inputs' in state.current_sub_step!, false)
  assert.equal('result' in state.current_sub_step!, false)
  assert.equal('completion_criteria' in state.current_sub_step!, false)
  assert.equal('sub_state_id' in state, false)
})

test('rejects missing, duplicate, and out-of-range coverage', () => {
  const build = (candidate: typeof plan) => createPlannedSubState({
    step_id: 'step-000001', plan: candidate,
    used_criterion_ids: [], used_sub_step_ids: [],
  })
  assert.throws(() => build({ ...plan, sub_steps: [plan.sub_steps[0]!] }), /not covered/)
  assert.throws(() => build({ ...plan, sub_steps: [{ ...plan.sub_steps[0]!, covers: [0, 0] }, plan.sub_steps[1]!] }), /duplicate criterion index/)
  assert.throws(() => build({ ...plan, sub_steps: [{ ...plan.sub_steps[0]!, covers: [2] }, plan.sub_steps[1]!] }), /valid completion-criteria index/)
})

test('uses stable IDs rather than action text as SubStep identity', () => {
  const state = createPlannedSubState({
    step_id: 'step-000001',
    plan: {
      step_completion_criteria: ['The first target is verified.', 'The second target is verified.'],
      sub_steps: [
        { inputs: ['First target.'], action: 'Verify the target.', result: 'First verified target.', covers: [0] },
        { inputs: ['Second target.'], action: 'Verify the target.', result: 'Second verified target.', covers: [1] },
      ],
    },
    used_criterion_ids: [],
    used_sub_step_ids: [],
  })
  assert.notEqual(state.current_sub_step?.sub_step_id, state.pending_sub_steps[0]?.sub_step_id)
})

test('requires explicit planning inputs and one result', () => {
  const build = (subStep: unknown) => createPlannedSubState({
    step_id: 'step-000001',
    plan: { step_completion_criteria: ['The result is verified.'], sub_steps: [subStep] } as never,
    used_criterion_ids: [],
    used_sub_step_ids: [],
  })
  assert.throws(() => build({ action: 'Do work.', result: 'A result.', covers: [0] }), /inputs must be an array/)
  assert.throws(() => build({ inputs: [], action: 'Do work.', result: 'A result.', covers: [0] }), /inputs must be a non-empty array/)
  assert.throws(() => build({ inputs: ['Input.'], action: 'Do work.', covers: [0] }), /result must be a non-empty string/)
})
