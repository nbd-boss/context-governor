import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EpochDeltaBuffer } from '../src/epoch/epoch-delta-buffer.ts'
import { stampBoundaryRevision } from '../src/epoch/epoch-projection.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

test('keeps State and SubState changes in memory until one boundary commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-delta-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    const state = await workspace.state.initialize({
      mission: 'Fix duplicate charges.',
      task_plan: plannedTaskPlan('Reproduce the bug.', 'Fix key propagation.'),
      user_constraints: [],
    })
    await workspace.sub_states.save(plannedSubState({ plan: {
      step_completion_criteria: ['Duplicate charges are observed.'],
      sub_steps: [{ action: 'Trigger timeout retry.', completion_criteria: ['Duplicate charges are observed.'], covers: [0] }],
    } }))
    const durable = { state, sub_states: await workspace.sub_states.readAll(), artifacts: [] }
    const buffer = new EpochDeltaBuffer()
    const snapshot = buffer.recordStep({
      sessionId: 'session-a', durable, expectedRevision: 0, reason: 'Reproduction is complete.',
      operation: {
        step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
        completed: { summary: 'One retry creates two charges.', source_events: ['event-4'], artifact_refs: [] },
        next_step: {
          step_id: 'step-000002',
          plan: {
            step_completion_criteria: ['One retry chain shares one key.'],
            sub_steps: [{ inputs: ['Retry boundary.'], action: 'Pass one key through retry.', result: 'Stable retry key propagation.', completion_criteria: ['One retry chain shares one key.'], covers: [0] }],
          },
        },
      },
    })
    assert.equal(snapshot.revision, 1)
    assert.equal((await workspace.state.read())?.revision, 1)
    assert.equal((await workspace.sub_states.read('step-000001'))?.current_sub_step?.sub_step_id, 'sub-step-000001')

    const target = stampBoundaryRevision(state, snapshot.projected)
    await workspace.transition.commit(durable, target)
    workspace.state.invalidate()
    assert.equal((await workspace.state.read())?.revision, 2)
    assert.equal((await workspace.sub_states.read('step-000001'))?.current_sub_step, null)
    assert.equal((await workspace.sub_states.read('step-000002'))?.current_sub_step?.sub_step_id, 'sub-step-000002')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('distinguishes State-only changes from completed SubStep progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-sub-step-progress-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    const state = await workspace.state.initialize({
      mission: 'Inventory course work.',
      task_plan: plannedTaskPlan('Collect assignments.'),
      user_constraints: [],
    })
    await workspace.sub_states.save(plannedSubState({ plan: {
      step_completion_criteria: ['Catalog is verified.'],
      sub_steps: [{ action: 'Collect the assignment catalog.', completion_criteria: ['Catalog is verified.'], covers: [0] }],
    } }))
    const durable = { state, sub_states: await workspace.sub_states.readAll(), artifacts: [] }
    const buffer = new EpochDeltaBuffer()
    const stateOnly = buffer.recordUserConstraint({
      sessionId: 'session-a', durable, expectedRevision: 0, reason: 'User requires JSON output.',
      operation: { constraint: 'Return JSON output.' },
    })
    assert.equal(stateOnly.revision, 1)
    assert.equal(stateOnly.projected.sub_states[0]?.completed_sub_steps.length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps only the latest Continuation in memory and persists it at the Epoch boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-continuation-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    const state = await workspace.state.initialize({
      mission: 'Inventory course work.',
      task_plan: plannedTaskPlan('Collect announcements.'),
      user_constraints: [],
    })
    await workspace.sub_states.save(plannedSubState({ plan: {
      step_completion_criteria: ['Every course is covered.'],
      sub_steps: [{ action: 'Collect announcements.', completion_criteria: ['Every course is covered.'], covers: [0] }],
    } }))
    const durable = { state, sub_states: await workspace.sub_states.readAll(), artifacts: [] }
    const buffer = new EpochDeltaBuffer()
    buffer.recordContinuation({
      sessionId: 'session-a', durable,
      operation: {
        progress: 'Courses 1 through 40 are saved.',
        working_resources: [{ path: 'E:\\workspace\\announcements-working.json', contains: 'Courses 1 through 40.' }],
        resume_from: 'Continue with course 41.',
      },
    })
    const latest = buffer.recordContinuation({
      sessionId: 'session-a', durable,
      operation: {
        progress: 'Courses 1 through 80 are saved.',
        working_resources: [{ path: 'E:\\workspace\\announcements-working.json', contains: 'Courses 1 through 80.' }],
        resume_from: 'Continue with course 81.',
      },
    })
    assert.equal(latest.revision, 2)
    assert.equal(latest.projected.sub_states[0]?.current_sub_step?.continuation?.resume_from, 'Continue with course 81.')
    assert.equal((await workspace.sub_states.read('step-000001'))?.current_sub_step?.continuation, null)

    await workspace.transition.commit(durable, stampBoundaryRevision(state, latest.projected))
    assert.equal((await workspace.sub_states.read('step-000001'))?.current_sub_step?.continuation?.resume_from, 'Continue with course 81.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('orders plan and constraint changes in one Epoch, then stamps State once at its boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-state-delta-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    const state = await workspace.state.initialize({
      mission: 'Fix duplicate charges.',
      task_plan: plannedTaskPlan('Locate the retry boundary.', 'Implement the retry fix.', 'Run regression tests.'),
      user_constraints: [],
    })
    await workspace.sub_states.save(plannedSubState({ plan: {
      step_completion_criteria: ['Boundary is known.'],
      sub_steps: [{ action: 'Trace retry.', completion_criteria: ['Boundary is known.'], covers: [0] }],
    } }))
    const durable = { state, sub_states: await workspace.sub_states.readAll(), artifacts: [] }
    const buffer = new EpochDeltaBuffer()
    const plan = buffer.recordPlanRevision({
      sessionId: 'session-a', durable, expectedRevision: 0, reason: 'Compatibility needs separate verification.',
      operation: { pending_steps: [
        { step_id: 'step-000002', inputs: ['Retry boundary.'], step: 'Implement the retry fix.', result: 'Implemented retry fix.', covers: [1] },
        { inputs: ['Implemented fix.', 'Legacy gateway.'], step: 'Verify legacy gateway compatibility.', result: 'Verified compatibility.', covers: [2] },
      ] },
    })
    assert.equal(plan.projected.state.revision, 1)
    assert.deepEqual(plan.projected.state.task_plan.steps.map(step => step.step_id), ['step-000001', 'step-000002', 'step-000004'])
    const constraint = buffer.recordDiscoveredConstraint({
      sessionId: 'session-a', durable, expectedRevision: 1, reason: 'Legacy gateway contract confirmed.',
      operation: {
        kind: 'external_contract',
        condition: 'Legacy gateway accepts one idempotency key per retry chain.',
        required_behavior: 'Reuse one key across all attempts.',
        source_events: ['event-8'],
      },
    })
    const user = buffer.recordUserConstraint({
      sessionId: 'session-a', durable, expectedRevision: 2, reason: 'User prohibited schema changes.',
      operation: { constraint: 'Do not modify the database schema.' },
    })
    assert.equal(constraint.projected.state.discovered_constraints.length, 1)
    assert.deepEqual(user.projected.state.user_constraints, ['Do not modify the database schema.'])
    assert.equal((await workspace.state.read())?.revision, 1)
    const target = stampBoundaryRevision(durable.state, user.projected)
    await workspace.transition.commit(durable, target)
    workspace.state.invalidate()
    const saved = await workspace.state.read()
    assert.equal(saved?.revision, 2)
    assert.equal(saved?.task_plan.steps.length, 3)
    assert.equal(saved?.discovered_constraints.length, 1)
    assert.deepEqual(saved?.user_constraints, ['Do not modify the database schema.'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps a replacement Pending plan in memory until the Epoch boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-pending-plan-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    const state = await workspace.state.initialize({
      mission: 'Inventory course work.', task_plan: plannedTaskPlan('Collect work.'), user_constraints: [],
    })
    const initial = plannedSubState({ plan: {
      step_completion_criteria: ['The scope is known.', 'Assignments are collected.'],
      sub_steps: [
        { action: 'Confirm the scope.', completion_criteria: ['The scope is verified.'], covers: [0] },
        { action: 'Collect assignments.', completion_criteria: ['Assignments are verified.'], covers: [1] },
      ],
    } })
    await workspace.sub_states.save(initial)
    const durable = { state, sub_states: await workspace.sub_states.readAll(), artifacts: [] }
    const criterion = initial.step_completion_criteria[1]!.criterion_id
    const buffer = new EpochDeltaBuffer()
    assert.throws(() => buffer.recordPendingSubStepPlan({
      sessionId: 'session-a', durable, expectedRevision: 1, reason: 'Stale attempt.',
      operation: {
        step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000001',
        pending_sub_steps: [{ inputs: ['Source records.'], action: 'Collect rows.', result: 'Complete row set.', completion_criteria: ['Rows exist.'], covers: [criterion] }],
      },
    }), /epoch revision mismatch/)
    const recorded = buffer.recordPendingSubStepPlan({
      sessionId: 'session-a', durable, expectedRevision: 0, reason: 'Separate collection from verification.',
      operation: {
        step_id: 'step-000001', expected_current_sub_step_id: 'sub-step-000001',
        pending_sub_steps: [
          { inputs: ['Assignment source.'], action: 'Collect assignment rows.', result: 'Complete assignment rows.', completion_criteria: ['All rows are present.'], covers: [criterion] },
          { inputs: ['Complete assignment rows.'], action: 'Verify assignment rows.', result: 'Verified assignment rows.', completion_criteria: ['All rows are verified.'], covers: [criterion] },
        ],
      },
    })
    assert.deepEqual((await workspace.sub_states.read('step-000001'))?.pending_sub_steps.map(item => item.sub_step_id), ['sub-step-000002'])
    assert.deepEqual(recorded.projected.sub_states[0]?.pending_sub_steps.map(item => item.sub_step_id), ['sub-step-000003', 'sub-step-000004'])
    assert.deepEqual(recorded.projected.sub_states[0]?.current_sub_step, initial.current_sub_step)
    await workspace.transition.commit(durable, stampBoundaryRevision(state, recorded.projected))
    assert.deepEqual((await workspace.sub_states.read('step-000001'))?.pending_sub_steps.map(item => item.sub_step_id), ['sub-step-000003', 'sub-step-000004'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
