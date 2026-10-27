import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDiscoveredConstraints, appendUserConstraint, createInitialState, reviseStateStep, validateContextState } from '../src/state/state-contract.ts'
import { plannedTaskPlan } from './test-fixtures.ts'

function workingState() {
  return createInitialState({
    mission: 'Fix duplicate charges.',
    task_plan: plannedTaskPlan('Locate the retry boundary.', 'Implement the retry fix.', 'Run regression tests.'),
    user_constraints: [],
  })
}

test('a State-level Step edit preserves the other Steps and leaves revision advancement to the writer', () => {
  const state = workingState()
  const revised = reviseStateStep(state, { change: {
    operation: 'update', step_id: 'step-000003', inputs: ['Implemented fix.'],
    step: 'Run targeted and full regression tests.', result: 'Verified regression result.', covers: [2],
  } })
  assert.equal(revised.revision, state.revision)
  assert.deepEqual(revised.task_plan.steps.slice(0, 2), state.task_plan.steps.slice(0, 2))
  assert.equal(revised.task_plan.steps[2]?.step, 'Run targeted and full regression tests.')
  assert.throws(() => reviseStateStep(state, { change: { operation: 'delete', step_id: 'step-000001' } }), /existing pending/)
})

test('appends direct and discovered constraints without changing the projected revision', () => {
  const user = appendUserConstraint(workingState(), { constraint: 'Do not modify the database schema.' })
  assert.deepEqual(user.user_constraints, ['Do not modify the database schema.'])
  const discovered = applyDiscoveredConstraints(user, [{
    kind: 'external_contract',
    condition: 'The legacy gateway accepts only one idempotency key per retry chain.',
    required_behavior: 'Reuse the key across all attempts.',
    source_events: ['event-8'],
    replaces: [],
  }])
  assert.equal(discovered.revision, 1)
  assert.equal(discovered.discovered_constraints.length, 1)
  assert.throws(() => appendUserConstraint(user, { constraint: 'Do not modify the database schema.' }), /already contains/)
})

const boundary = {
  kind: 'environment_limit' as const,
  condition: 'The source result exceeds the inline response limit.',
  required_behavior: 'Recover exact details through the documented History interface.',
  source_events: ['event-8'],
  replaces: [],
}

test('constraint replacements allocate fresh IDs while keeping only effective records and preserving the input', () => {
  const base = applyDiscoveredConstraints(workingState(), [boundary, { ...boundary, condition: 'The source interface requires bounded requests.' }])
  const before = structuredClone(base)
  const replacement = { ...boundary, required_behavior: 'History stores a truncated response; obtain exact details through a verified source path.', source_events: ['event-9'], replaces: ['constraint-000001'] }
  const next = applyDiscoveredConstraints(base, [replacement])
  assert.deepEqual(base, before)
  assert.equal(next.revision, base.revision)
  assert.equal(next.next_constraint_number, 4)
  assert.deepEqual(next.discovered_constraints.map(item => item.constraint_id), ['constraint-000002', 'constraint-000003'])
  assert.deepEqual(next.discovered_constraints[0], base.discovered_constraints[1])
  assert.equal('replaces' in next.discovered_constraints[1]!, false)
  const later = applyDiscoveredConstraints(next, [{ ...replacement, replaces: ['constraint-000003'] }])
  assert.deepEqual(later.discovered_constraints.map(item => item.constraint_id), ['constraint-000002', 'constraint-000004'])
  assert.equal(later.next_constraint_number, 5)
  assert.throws(() => applyDiscoveredConstraints(later, [{ ...replacement, replaces: ['constraint-000003'] }]), /active constraint/)
})

test('constraint batches resolve all replacement references against the pre-call effective set', () => {
  const base = applyDiscoveredConstraints(workingState(), [boundary])
  const next = applyDiscoveredConstraints(base, [
    { ...boundary, condition: 'The source response is already truncated.', required_behavior: 'Use another verified source.', replaces: ['constraint-000001'] },
    { ...boundary, condition: 'Only an inline response is available.', required_behavior: 'Keep requests bounded.', replaces: ['constraint-000001'] },
  ])
  assert.deepEqual(next.discovered_constraints.map(item => item.constraint_id), ['constraint-000002', 'constraint-000003'])
  assert.equal(next.next_constraint_number, 4)
  assert.throws(() => applyDiscoveredConstraints(base, [
    { ...boundary, required_behavior: 'Use another verified source.', replaces: ['constraint-000001'] },
    { ...boundary, replaces: ['constraint-000002'] },
  ]), /active constraint: constraint-000002/)
  assert.deepEqual(base.discovered_constraints.map(item => item.constraint_id), ['constraint-000001'])
  assert.equal(base.next_constraint_number, 2)
})

test('invalid constraint updates never change the source State or consume an ID', () => {
  const base = applyDiscoveredConstraints(workingState(), [boundary])
  const before = structuredClone(base)
  for (const changes of [
    [{ ...boundary, replaces: ['constraint-999999'] }],
    [{ ...boundary, replaces: ['constraint-000001', 'constraint-000001'] }],
    [{ ...boundary, replaces: ['constraint-000001'] }, { ...boundary, condition: ' ' }],
    [{ ...boundary, replaces: ['constraint-000001'], unexpected: true }],
    [boundary],
  ]) {
    assert.throws(() => applyDiscoveredConstraints(base, changes))
    assert.deepEqual(base, before)
  }
  assert.deepEqual(applyDiscoveredConstraints(base, []), base)
  assert.throws(() => validateContextState({ ...base, next_constraint_number: 1 }), /must exceed/)
  assert.throws(() => validateContextState({ ...base, next_constraint_number: undefined }), /positive safe integer/)
  assert.throws(() => validateContextState({ ...base, discovered_constraints: [...base.discovered_constraints, { ...base.discovered_constraints[0], condition: 'Another condition.' }] }), /duplicate constraint_id/)
})
