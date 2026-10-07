import assert from 'node:assert/strict'
import test from 'node:test'

import { ContextQuery } from '../src/epoch/context-query.ts'
import { createInitialState, validateContextState } from '../src/state/state-contract.ts'
import { validateSubState } from '../src/state/sub-state-contract.ts'
import { validateArtifact } from '../src/evidence/artifact-contract.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

test('keeps completed Step navigation compact while exposing only the current SubState in detail', () => {
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
    sub_steps: [{ action: 'Trigger timeout.', completion_criteria: ['The duplicate is reproduced.'], covers: [0] }],
  } })
  const firstCurrent = first.current_sub_step!
  const done = validateSubState({
    ...first,
    completed_sub_steps: [{
      sub_step_id: firstCurrent.sub_step_id, action: firstCurrent.action,
      completion_criteria: firstCurrent.completion_criteria, covers: firstCurrent.covers,
      summary: 'One retry creates two charges.', source_events: ['event-4'], artifact_refs: [],
    }],
    current_sub_step: null,
  })
  const active = plannedSubState({
    step_id: 'step-000002', sub_state_id: 'sub-state-000002',
    used_criterion_ids: first.step_completion_criteria.map(item => item.criterion_id),
    used_sub_step_ids: [firstCurrent.sub_step_id],
    plan: {
      step_completion_criteria: ['One retry chain shares one key.'],
      sub_steps: [{ action: 'Pass one key through retry.', completion_criteria: ['One retry chain shares one key.'], covers: [0] }],
    },
  })
  const query = new ContextQuery({ state, sub_states: [done, active], artifacts: [] })
  assert.deepEqual(query.globalNavigation(), [{ step_id: 'step-000001', step: 'Reproduce the bug.', status: 'done' }])
  assert.equal(query.currentSubState()?.step_id, 'step-000002')
  assert.equal(query.subState('step-000001')?.completed_sub_steps[0]?.summary, 'One retry creates two charges.')
})

test('expands Artifact contains data without exposing the Resource in a runtime SubState', () => {
  const state = createInitialState({ mission: 'Inspect courses.', task_plan: plannedTaskPlan('List courses.'), user_constraints: [] })
  const artifact = validateArtifact({
    schema_version: 1, artifact_id: 'artifact-000001',
    contains: { kind: 'course_list', summary: 'One course.', coverage: 'Fixture.', key_facts: ['CS101 exists.'], available_fields: ['course_code'] },
    resource: { path: 'E:\\context\\fixture\\courses.json', format: 'json', content_sha256: 'a'.repeat(64) },
  })
  const initial = plannedSubState({ plan: {
    step_completion_criteria: ['The course is available.', 'The next action is selected.'],
    sub_steps: [
      { action: 'Read courses.', completion_criteria: ['The course is known.'], covers: [0] },
      { action: 'Use the course.', completion_criteria: ['Next action is selected.'], covers: [1] },
    ],
  } })
  const first = initial.current_sub_step!
  const subState = validateSubState({
    ...initial,
    completed_sub_steps: [{
      sub_step_id: first.sub_step_id, action: first.action, completion_criteria: first.completion_criteria, covers: first.covers,
      summary: 'CS101 is available.', source_events: ['event-4'], artifact_refs: [{ artifact_id: 'artifact-000001', relation: 'produced' }],
    }],
    current_sub_step: { ...initial.pending_sub_steps[0]!, continuation: null },
    pending_sub_steps: [],
  })
  const query = new ContextQuery({ state, sub_states: [subState], artifacts: [artifact] })
  const reference = query.currentRuntimeSubState()?.completed_sub_steps[0]?.artifact_refs[0]
  assert.deepEqual(reference?.contains.key_facts, ['CS101 exists.'])
  assert.equal('resource' in (reference ?? {}), false)
})
