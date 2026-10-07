import assert from 'node:assert/strict'
import test from 'node:test'

import { validateArtifact } from '../src/evidence/artifact-contract.ts'
import { createInitialState, deriveExecutionMode, validateContextState } from '../src/state/state-contract.ts'
import { validateSubState } from '../src/state/sub-state-contract.ts'
import { validateWorkspaceSnapshot } from '../src/workspace/workspace-validator.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

test('allocates stable Step IDs without putting current SubStep data in State', () => {
  const state = createInitialState({
    mission: 'Fix duplicate charges.',
    task_plan: plannedTaskPlan('Find the retry boundary.', 'Implement the fix.'),
    user_constraints: ['Do not change the database schema.'],
  })
  assert.deepEqual(state.task_plan.steps.map(step => step.step_id), ['step-000001', 'step-000002'])
  assert.equal('current_sub_step' in state, false)
  assert.equal(deriveExecutionMode(state), 'working')
  assert.throws(() => validateContextState({ ...state, current_sub_step: { sub_step_id: 'sub-step-1' } }), /unexpected field: current_sub_step/)
})

test('validates one planned SubState across completed, current, and pending regions', () => {
  const initial = plannedSubState({ plan: {
    step_completion_criteria: ['The retry boundary is known.'],
    sub_steps: [
      { action: 'Run the timeout retry test.', completion_criteria: ['The duplicate is reproduced.'], covers: [0] },
      { action: 'Trace key generation.', completion_criteria: ['Find the key creation call.'], covers: [0] },
      { action: 'Confirm the retry boundary.', completion_criteria: ['The boundary is verified.'], covers: [0] },
    ],
  } })
  const first = initial.current_sub_step!
  const second = initial.pending_sub_steps[0]!
  const subState = validateSubState({
    ...initial,
    completed_sub_steps: [{
      sub_step_id: first.sub_step_id,
      action: first.action,
      completion_criteria: first.completion_criteria,
      covers: first.covers,
      summary: 'The retry path creates two charges.',
      source_events: ['event-4'],
      artifact_refs: [{ artifact_id: 'artifact-000001', relation: 'produced' }],
    }],
    current_sub_step: { ...second, continuation: null },
    pending_sub_steps: initial.pending_sub_steps.slice(1),
  })
  assert.equal(subState.current_sub_step?.sub_step_id, second.sub_step_id)
  assert.throws(() => validateSubState({ ...subState, current_sub_step: { ...subState.current_sub_step!, sub_step_id: first.sub_step_id } }), /duplicate sub_step_id/)
})

test('keeps unfinished recovery navigation only on the current SubStep', () => {
  const initial = plannedSubState({ plan: {
    step_completion_criteria: ['Every course announcement is collected.'],
    sub_steps: [{ action: 'Collect all course announcements.', completion_criteria: ['Every course is covered.'], covers: [0] }],
  } })
  const subState = validateSubState({
    ...initial,
    current_sub_step: {
      ...initial.current_sub_step!,
      continuation: {
        progress: 'Courses 1 through 40 are saved.',
        working_resources: [{ path: 'E:\\workspace\\announcements-working.json', contains: 'Announcements for courses 1 through 40.' }],
        resume_from: 'Continue with course 41.',
      },
    },
  })
  assert.equal(subState.current_sub_step?.continuation?.resume_from, 'Continue with course 41.')
  assert.throws(() => validateSubState({
    ...subState,
    current_sub_step: { ...subState.current_sub_step!, continuation: { ...subState.current_sub_step!.continuation!, working_resources: [] } },
  }), /working_resources must contain at least one item/)
})

test('accepts only immutable Artifact metadata with an absolute structured Resource', () => {
  const artifact = validateArtifact({
    schema_version: 1,
    artifact_id: 'artifact-000001',
    contains: {
      kind: 'course_list', summary: 'Current course records.', coverage: 'Canvas snapshot.',
      key_facts: ['There are 12 courses.'], available_fields: ['course_code', 'title'],
    },
    resource: { path: 'E:\\context\\fixture\\courses.json', format: 'json', content_sha256: 'a'.repeat(64) },
  })
  assert.equal(artifact.resource.format, 'json')
  assert.throws(() => validateArtifact({ ...artifact, resource: { ...artifact.resource, path: 'relative.json' } }), /absolute Windows path/)
})

test('checks Step, SubState, and Artifact relationships as one Workspace snapshot', () => {
  const state = createInitialState({
    mission: 'Fix duplicate charges.',
    task_plan: plannedTaskPlan('Find the retry boundary.'),
    user_constraints: [],
  })
  const initial = plannedSubState({ plan: {
    step_completion_criteria: ['The retry boundary is known.'],
    sub_steps: [
      { action: 'Run the timeout retry test.', completion_criteria: ['The duplicate is reproduced.'], covers: [0] },
      { action: 'Trace key generation.', completion_criteria: ['Find the key creation call.'], covers: [0] },
    ],
  } })
  const first = initial.current_sub_step!
  const subState = validateSubState({
    ...initial,
    completed_sub_steps: [{
      sub_step_id: first.sub_step_id, action: first.action, completion_criteria: first.completion_criteria, covers: first.covers,
      summary: 'The retry path creates two charges.', source_events: ['event-4'],
      artifact_refs: [{ artifact_id: 'artifact-000001', relation: 'produced' }],
    }],
    current_sub_step: { ...initial.pending_sub_steps[0]!, continuation: null },
    pending_sub_steps: [],
  })
  const artifact = validateArtifact({
    schema_version: 1,
    artifact_id: 'artifact-000001',
    contains: { kind: 'test_result', summary: 'Retry evidence.', coverage: 'One timeout case.', key_facts: ['Two charges were created.'], available_fields: ['charge_id'] },
    resource: { path: 'E:\\context\\fixture\\retry.json', format: 'json', content_sha256: 'b'.repeat(64) },
  })
  assert.equal(validateWorkspaceSnapshot({ state, sub_states: [subState], artifacts: [artifact] }).artifacts.length, 1)
  assert.throws(() => validateWorkspaceSnapshot({ state, sub_states: [subState], artifacts: [] }), /Artifact reference does not exist/)
})
