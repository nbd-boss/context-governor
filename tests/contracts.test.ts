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
      { action: 'Run the timeout retry test.', covers: [0] },
      { action: 'Trace key generation.', covers: [0] },
      { action: 'Confirm the retry boundary.', covers: [0] },
    ],
  } })
  const first = initial.current_sub_step!
  const second = initial.pending_sub_steps[0]!
  const subState = validateSubState({
    ...initial,
    completed_sub_steps: [{
      sub_step_id: first.sub_step_id,
      action: first.action,
      covers: first.covers,
      summary: 'The retry path creates two charges.',
      criterion_evidence: [{ criterion_id: first.covers[0]!, source_events: ['event-4'] }],
      artifact_refs: [{ artifact_id: 'artifact-000001', relation: 'produced' }],
    }],
    current_sub_step: { ...second, continuation: null },
    pending_sub_steps: initial.pending_sub_steps.slice(1),
  })
  assert.equal(subState.current_sub_step?.sub_step_id, second.sub_step_id)
  assert.throws(() => validateSubState({ ...subState, current_sub_step: { ...subState.current_sub_step!, sub_step_id: first.sub_step_id } }), /duplicate sub_step_id/)
  assert.throws(() => validateSubState({ ...subState, sub_state_id: 'sub-state-000001' }), /unexpected field: sub_state_id/)
  assert.throws(() => validateSubState({ ...subState, current_sub_step: { ...subState.current_sub_step!, completion_criteria: ['Duplicate.'] } }), /unexpected field: completion_criteria/)
})

test('requires completed SubStep evidence to exactly cover its Step criteria', () => {
  const initial = plannedSubState({ plan: {
    step_completion_criteria: ['The write succeeded.', 'The saved state was read back.'],
    sub_steps: [{ action: 'Write then verify.', covers: [0, 1] }],
  } })
  const current = initial.current_sub_step!
  const completed = {
    sub_step_id: current.sub_step_id,
    action: current.action,
    covers: current.covers,
    summary: 'The write and read-back are complete.',
    artifact_refs: [],
  }
  assert.throws(() => validateSubState({
    ...initial,
    completed_sub_steps: [{ ...completed, criterion_evidence: [{ criterion_id: current.covers[0]!, source_events: ['event-4'] }] }],
    current_sub_step: null,
  }), /missing evidence for criterion_id/)
  assert.throws(() => validateSubState({
    ...initial,
    completed_sub_steps: [{ ...completed, criterion_evidence: [
      { criterion_id: current.covers[0]!, source_events: ['event-4'] },
      { criterion_id: 'criterion-999999', source_events: ['event-5'] },
    ] }],
    current_sub_step: null,
  }), /does not belong to the completed SubStep/)
  const valid = validateSubState({
    ...initial,
    completed_sub_steps: [{ ...completed, criterion_evidence: [
      { criterion_id: current.covers[0]!, source_events: ['event-4'] },
      { criterion_id: current.covers[1]!, source_events: ['event-5'] },
    ] }],
    current_sub_step: null,
  })
  assert.equal(valid.completed_sub_steps[0]?.criterion_evidence.length, 2)
})

test('keeps unfinished recovery navigation only on the current SubStep', () => {
  const initial = plannedSubState({ plan: {
    step_completion_criteria: ['Every course announcement is collected.'],
    sub_steps: [{ action: 'Collect all course announcements.', covers: [0] }],
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
  const textOnly = validateSubState({
    ...subState,
    current_sub_step: { ...subState.current_sub_step!, continuation: { ...subState.current_sub_step!.continuation!, working_resources: [] } },
  })
  assert.deepEqual(textOnly.current_sub_step?.continuation?.working_resources, [])
  assert.throws(() => validateSubState({
    ...subState,
    current_sub_step: { ...subState.current_sub_step!, continuation: { ...subState.current_sub_step!.continuation!, working_resources: null } },
  }), /working_resources must be an array/)
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
      { action: 'Run the timeout retry test.', covers: [0] },
      { action: 'Trace key generation.', covers: [0] },
    ],
  } })
  const first = initial.current_sub_step!
  const subState = validateSubState({
    ...initial,
    completed_sub_steps: [{
      sub_step_id: first.sub_step_id, action: first.action, covers: first.covers,
      summary: 'The retry path creates two charges.', criterion_evidence: [{ criterion_id: first.covers[0]!, source_events: ['event-4'] }],
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
