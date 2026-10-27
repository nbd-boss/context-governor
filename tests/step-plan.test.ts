import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlannedTaskPlan, replanTaskCriteria, reviseStep } from '../src/planning/step-plan.ts'

const draft = {
  completion_criteria: ['The cause is known.', 'The fix is verified.'],
  steps: [
    { inputs: ['Failing behavior.'], step: 'Locate the cause.', result: 'Verified root cause.', covers: [0] },
    { inputs: ['Verified root cause.'], step: 'Implement and verify the fix.', result: 'Verified fix.', covers: [1] },
  ],
}

test('plans ordered Steps and persists the next unused identity', () => {
  const plan = createPlannedTaskPlan(draft)
  assert.equal(plan.next_step_number, 3)
  assert.deepEqual(plan.steps, [
    { step_id: 'step-000001', step: 'Locate the cause.', status: 'in_progress', covers: [0] },
    { step_id: 'step-000002', step: 'Implement and verify the fix.', status: 'pending', covers: [1] },
  ])
  assert.equal('inputs' in plan.steps[0]!, false)
  assert.equal('result' in plan.steps[0]!, false)
})

test('rejects incomplete initial coverage, duplicates, and invalid draft fields', () => {
  assert.throws(() => createPlannedTaskPlan({ ...draft, steps: [draft.steps[0]!] }), /not covered/)
  assert.throws(() => createPlannedTaskPlan({ ...draft, steps: [{ ...draft.steps[0]!, covers: [2] }, draft.steps[1]!] }), /valid completion-criteria index/)
  assert.throws(() => createPlannedTaskPlan({ ...draft, completion_criteria: ['Same.', 'Same.'] }), /duplicates/)
  assert.throws(() => createPlannedTaskPlan({ ...draft, steps: [{ ...draft.steps[0]!, status: 'pending' }, draft.steps[1]!] } as never), /unexpected field/)
})

test('adds, updates, and deletes one Pending Step without rewriting unrelated work', () => {
  const initial = createPlannedTaskPlan(draft)
  const added = reviseStep(initial, { operation: 'add', inputs: ['Fix.'], step: 'Verify independently.', result: 'Verified fix.', covers: [1] })
  assert.equal(added.steps[2]?.step_id, 'step-000003')
  const updated = reviseStep(added, { operation: 'update', step_id: 'step-000002', ...draft.steps[1]!, step: 'Implement the fix.' })
  assert.equal(updated.steps[1]?.step_id, 'step-000002')
  assert.equal(updated.steps[1]?.step, 'Implement the fix.')
  assert.deepEqual(updated.steps[0], initial.steps[0])
  assert.deepEqual(updated.steps[2], added.steps[2])
  const deleted = reviseStep(updated, { operation: 'delete', step_id: 'step-000003' })
  assert.deepEqual(deleted.steps, updated.steps.slice(0, 2))
  const restored = reviseStep(JSON.parse(JSON.stringify(deleted)), { operation: 'add', inputs: ['Fix.'], step: 'Verify independently.', result: 'Verified fix.', covers: [1] })
  assert.equal(restored.steps[2]?.step_id, 'step-000004')
  assert.throws(() => reviseStep(restored, { operation: 'delete', step_id: 'step-000003' }), /existing pending/)
  assert.deepEqual(initial, createPlannedTaskPlan(draft))
})

test('protects active/done Steps, complete coverage, and operation-specific fields', () => {
  const initial = createPlannedTaskPlan(draft)
  assert.throws(() => reviseStep(initial, { operation: 'delete', step_id: 'step-000002' }), /not covered/)
  assert.throws(() => reviseStep(initial, { operation: 'delete', step_id: 'step-000001' }), /existing pending/)
  assert.throws(() => reviseStep(initial, { operation: 'update', step_id: 'step-999999', ...draft.steps[1]! }), /existing pending/)
  assert.throws(() => reviseStep(initial, { operation: 'update', step_id: 'step-000002', ...draft.steps[1]! }), /substantive/)
  assert.throws(() => reviseStep(initial, { operation: 'add', step_id: 'step-000003', ...draft.steps[1]! } as never), /unexpected field/)
  assert.throws(() => reviseStep(initial, { operation: 'delete', step_id: 'step-000002', step: 'Extra.' } as never), /unexpected field/)
  const done = { ...initial, steps: initial.steps.map(step => ({ ...step, status: 'done' as const })) }
  assert.throws(() => reviseStep(done, { operation: 'delete', step_id: 'step-000001' }), /existing pending/)
})

test('criteria changes reuse item edits and validate only the final covered plan', () => {
  const initial = createPlannedTaskPlan(draft)
  const corrected = replanTaskCriteria(initial, {
    supersede: [1], add: ['The corrected fix is verified.'],
    changes: [
      { operation: 'delete', step_id: 'step-000002' },
      { operation: 'add', inputs: ['New evidence.'], step: 'Verify the corrected fix.', result: 'Corrected fix.', covers: [2] },
    ],
  })
  assert.deepEqual(corrected.steps[0], initial.steps[0])
  assert.equal(corrected.steps[1]?.step_id, 'step-000003')
  assert.deepEqual(corrected.superseded_criteria, [1])
  assert.equal(corrected.completion_criteria[1], draft.completion_criteria[1])
  assert.throws(() => replanTaskCriteria(initial, { supersede: [1], add: ['New.'], changes: [] }), /superseded criterion|not covered/)
  assert.throws(() => replanTaskCriteria(initial, {
    supersede: [], add: ['New.'], changes: [{ operation: 'update', step_id: 'step-000001', ...draft.steps[0]!, covers: [0, 2] }],
  }), /existing pending/)
  assert.deepEqual(initial, createPlannedTaskPlan(draft))
})

test('a criteria-only change may leave the existing Pending plan intact', () => {
  const initial = createPlannedTaskPlan({ ...draft, steps: [{ ...draft.steps[0]!, covers: [0, 1] }, draft.steps[1]!] })
  const next = replanTaskCriteria(initial, { supersede: [0], add: [], changes: [] })
  assert.deepEqual(next.steps, initial.steps)
  assert.deepEqual(next.superseded_criteria, [0])
})
