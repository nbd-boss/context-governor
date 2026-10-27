import assert from 'node:assert/strict'
import test from 'node:test'

import { ContextQuery } from '../src/epoch/context-query.ts'
import { createInitialState, validateContextState } from '../src/state/state-contract.ts'
import { validateSubState } from '../src/state/sub-state-contract.ts'
import { validateArtifact } from '../src/evidence/artifact-contract.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

test('uses State for Step navigation while exposing only the current SubState in detail', () => {
  const initial = createInitialState({
    mission: 'Fix duplicate charges.',
    task_plan: plannedTaskPlan('Reproduce the bug.', 'Fix key propagation.'),
    user_constraints: [],
  })
  const state = validateContextState({
    ...initial,
    task_plan: { ...initial.task_plan, steps: [
      { ...initial.task_plan.steps[0]!, status: 'done' },
      { ...initial.task_plan.steps[1]!, status: 'in_progress' },
    ] },
  })
  const first = plannedSubState({ plan: {
    step_completion_criteria: ['The duplicate is reproduced.'],
    sub_steps: [{ action: 'Trigger timeout.', covers: [0] }],
  } })
  const firstCurrent = first.current_sub_step!
  const done = validateSubState({
    ...first,
    completed_sub_steps: [{
      sub_step_id: firstCurrent.sub_step_id, action: firstCurrent.action,
      covers: firstCurrent.covers,
      summary: 'One retry creates two charges.', criterion_evidence: [{ criterion_id: firstCurrent.covers[0]!, source_events: ['event-4'] }], artifact_refs: [],
    }],
    current_sub_step: null,
  })
  const active = plannedSubState({
    step_id: 'step-000002',
    used_criterion_ids: first.step_completion_criteria.map(item => item.criterion_id),
    used_sub_step_ids: [firstCurrent.sub_step_id],
    plan: {
      step_completion_criteria: ['One retry chain shares one key.'],
      sub_steps: [{ action: 'Pass one key through retry.', covers: [0] }],
    },
  })
  const query = new ContextQuery({ state, sub_states: [done, active], artifacts: [] })
  assert.deepEqual(query.state().task_plan.steps.filter(step => step.status === 'done').map(step => step.step_id), ['step-000001'])
  assert.equal(query.currentSubState()?.step_id, 'step-000002')
  assert.equal(query.subState('step-000001')?.completed_sub_steps[0]?.summary, 'One retry creates two charges.')
})

test('lists a reused Artifact once per runtime view without changing durable references', () => {
  const state = createInitialState({ mission: 'Inspect courses.', task_plan: plannedTaskPlan('List courses.'), user_constraints: [] })
  const artifact = validateArtifact({
    schema_version: 1, artifact_id: 'artifact-000001',
    contains: { kind: 'course_list', summary: 'One course.', coverage: 'Fixture.', key_facts: ['CS101 exists.'], available_fields: ['course_code'] },
    resource: { path: 'E:\\context\\fixture\\courses.json', format: 'json', content_sha256: 'a'.repeat(64) },
  })
  const initial = plannedSubState({ plan: {
    step_completion_criteria: ['The course is available.', 'The course is reused.', 'The next action is selected.'],
    sub_steps: [
      { action: 'Read courses.', covers: [0] },
      { action: 'Use the course.', covers: [1] },
      { action: 'Select the next action.', covers: [2] },
    ],
  } })
  const first = initial.current_sub_step!
  const second = initial.pending_sub_steps[0]!
  const subState = validateSubState({
    ...initial,
    completed_sub_steps: [{
      sub_step_id: first.sub_step_id, action: first.action, covers: first.covers,
      summary: 'CS101 is available.', criterion_evidence: [{ criterion_id: first.covers[0]!, source_events: ['event-4'] }], artifact_refs: [{ artifact_id: 'artifact-000001', relation: 'produced' }],
    }, {
      sub_step_id: second.sub_step_id, action: second.action, covers: second.covers,
      summary: 'The course was reused.', criterion_evidence: [{ criterion_id: second.covers[0]!, source_events: ['event-8'] }], artifact_refs: [{ artifact_id: 'artifact-000001', relation: 'used' }],
    }],
    current_sub_step: { ...initial.pending_sub_steps[1]!, continuation: null },
    pending_sub_steps: [],
  })
  const snapshot = { state, sub_states: [subState], artifacts: [artifact] }
  const before = structuredClone(snapshot)
  const query = new ContextQuery(snapshot)
  const view = query.currentRuntimeSubState()!
  assert.deepEqual(view.artifact_catalog, [{ artifact_id: artifact.artifact_id, contains: artifact.contains }])
  assert.deepEqual(view.completed_sub_steps, subState.completed_sub_steps)
  assert.equal(JSON.stringify(view).split('CS101 exists.').length - 1, 1)
  assert.equal('resource' in view.artifact_catalog[0]!, false)
  assert.equal(JSON.stringify(view).includes(artifact.resource.path), false)
  assert.deepEqual(snapshot, before)
  assert.deepEqual(query.subState('step-000001'), subState)
  // Building another view or Epoch must not suppress its self-contained catalog.
  assert.deepEqual(query.runtimeSubState('step-000001'), view)
  assert.deepEqual(new ContextQuery(snapshot).currentRuntimeSubState(), view)
})
