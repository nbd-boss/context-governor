import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EpochDeltaBuffer } from '../src/epoch/epoch-delta-buffer.ts'
import { stampBoundaryRevision } from '../src/epoch/epoch-projection.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { createInitialState } from '../src/state/state-contract.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

async function seed(directory: string) {
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
  const base = { state, sub_states: await workspace.sub_states.readAll(), artifacts: [] }
  const deltas = new EpochDeltaBuffer()
  const projected = deltas.recordStep({
    sessionId: 'session-a', durable: base, expectedRevision: 0, reason: 'The root cause is confirmed.',
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
  return { workspace, base, target: stampBoundaryRevision(state, projected.projected) }
}

test('recovers an interrupted initial State and first SubState together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-initial-recovery-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    const state = createInitialState({
      mission: 'Fix duplicate charges.',
      task_plan: plannedTaskPlan('Reproduce the bug.'),
      user_constraints: [],
    })
    const target = {
      state,
      sub_states: [plannedSubState({ plan: {
        step_completion_criteria: ['Duplicate charges are observed.'],
        sub_steps: [{ action: 'Trigger timeout retry.', completion_criteria: ['Duplicate charges are observed.'], covers: [0] }],
      } })],
      artifacts: [],
    }
    await assert.rejects(
      () => workspace.transition.initialize(target, { before_install: file => {
        if (file.kind === 'state') throw new Error('interrupted initial State')
      } }),
      /interrupted initial State/,
    )
    const restarted = new SessionWorkspaceProvider(directory).forSession('session-a')
    assert.equal(await restarted.recover(), true)
    assert.equal((await restarted.state.read())?.revision, 1)
    assert.equal((await restarted.sub_states.read('step-000001'))?.current_sub_step?.sub_step_id, 'sub-step-000001')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('installs a full target snapshot with State last', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-transition-'))
  try {
    const { workspace, base, target } = await seed(directory)
    const order: string[] = []
    await workspace.transition.commit(base, target, { before_install: file => { order.push(file.relative_path) } })
    assert.deepEqual(order, [
      'sub_states/sub-state-000001.json',
      'sub_states/sub-state-000002.json',
      'state.json',
    ])
    workspace.state.invalidate()
    assert.equal((await workspace.state.read())?.revision, 2)
    assert.equal((await workspace.sub_states.read('step-000001'))?.current_sub_step, null)
    assert.equal((await workspace.sub_states.read('step-000002'))?.current_sub_step?.sub_step_id, 'sub-step-000002')
    await assert.rejects(() => stat(join(directory, 'sessions', 'session-a', 'transition', 'manifest.json')), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovers every interrupted install point without mixing old State and new SubState', async () => {
  for (const interruptAt of [1, 2, 3]) {
    const directory = await mkdtemp(join(tmpdir(), 'context-governor-recovery-'))
    try {
      const { workspace, base, target } = await seed(directory)
      let installCount = 0
      await assert.rejects(
        () => workspace.transition.commit(base, target, {
          before_install: () => {
            installCount += 1
            if (installCount === interruptAt) throw new Error(`simulated interruption ${String(interruptAt)}`)
          },
        }),
        /simulated interruption/,
      )
      const restarted = new SessionWorkspaceProvider(directory).forSession('session-a')
      assert.equal(await restarted.recover(), true)
      const recovered = await restarted.state.read()
      assert.equal(recovered?.revision, 2)
      assert.equal(recovered?.task_plan.steps[0]?.status, 'done')
      assert.equal(recovered?.task_plan.steps[1]?.status, 'in_progress')
      assert.equal((await restarted.sub_states.read('step-000001'))?.current_sub_step, null)
      assert.equal((await restarted.sub_states.read('step-000002'))?.current_sub_step?.sub_step_id, 'sub-step-000002')
      await assert.rejects(() => readFile(join(directory, 'sessions', 'session-a', 'transition', 'manifest.json'), 'utf8'), /ENOENT/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('cleans an interrupted manifest when the target State was already installed last', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-state-last-'))
  try {
    const { workspace, base, target } = await seed(directory)
    await assert.rejects(
      () => workspace.transition.commit(base, target, {
        after_install: file => {
          if (file.kind === 'state') throw new Error('interrupted after State install')
        },
      }),
      /interrupted after State install/,
    )
    const restarted = new SessionWorkspaceProvider(directory).forSession('session-a')
    assert.equal(await restarted.recover(), true)
    assert.equal((await restarted.state.read())?.revision, 2)
    await assert.rejects(() => readFile(join(directory, 'sessions', 'session-a', 'transition', 'manifest.json'), 'utf8'), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
