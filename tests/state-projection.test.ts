import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendDiscoveredConstraint,
  appendUserConstraint,
  createInitialState,
  revisePendingSteps,
} from '../src/state/state-contract.ts'
import { plannedTaskPlan } from './test-fixtures.ts'

function workingState() {
  return createInitialState({
    mission: 'Fix duplicate charges.',
    task_plan: plannedTaskPlan('Locate the retry boundary.', 'Implement the retry fix.', 'Run regression tests.'),
    user_constraints: [],
  })
}

test('revises only pending Steps while retaining their stable IDs', () => {
  const state = workingState()
  const revised = revisePendingSteps(state, {
    pending_steps: [
      { step_id: 'step-000003', inputs: ['Implemented fix.'], step: 'Run targeted and full regression tests.', result: 'Verified regression result.', covers: [2] },
      { inputs: ['Retry boundary.'], step: 'Document the retry boundary.', result: 'Documented retry fix.', covers: [1] },
    ],
  })
  assert.equal(revised.revision, 1)
  assert.deepEqual(revised.task_plan.steps, [
    { step_id: 'step-000001', step: 'Locate the retry boundary.', status: 'in_progress', covers: [0] },
    { step_id: 'step-000003', step: 'Run targeted and full regression tests.', status: 'pending', covers: [2] },
    { step_id: 'step-000004', step: 'Document the retry boundary.', status: 'pending', covers: [1] },
  ])
})

test('does not allow State-only plan revision to change done or active Steps', () => {
  const state = workingState()
  assert.throws(() => revisePendingSteps(state, {
    pending_steps: [{ step_id: 'step-000001', inputs: ['Boundary.'], step: 'Rename active work.', result: 'Renamed work.', covers: [0] }],
  }), /Only pending Step IDs/)
  assert.throws(() => revisePendingSteps(state, {
    pending_steps: [
      { step_id: 'step-000002', inputs: ['Boundary.'], step: 'Implement the retry fix.', result: 'Implemented fix.', covers: [1] },
      { step_id: 'step-000003', inputs: ['Fix.'], step: 'Run regression tests.', result: 'Verified tests.', covers: [2] },
    ],
  }), /substantive task-plan change/)
})

test('appends direct and discovered constraints without changing State revision before a boundary', () => {
  const user = appendUserConstraint(workingState(), { constraint: 'Do not modify the database schema.' })
  assert.deepEqual(user.user_constraints, ['Do not modify the database schema.'])
  const discovered = appendDiscoveredConstraint(user, {
    kind: 'external_contract',
    condition: 'The legacy gateway accepts only one idempotency key per retry chain.',
    required_behavior: 'Reuse the key across all attempts.',
    source_events: ['event-8'],
  })
  assert.equal(discovered.revision, 1)
  assert.equal(discovered.discovered_constraints.length, 1)
  assert.throws(() => appendUserConstraint(user, { constraint: 'Do not modify the database schema.' }), /already contains/)
})
