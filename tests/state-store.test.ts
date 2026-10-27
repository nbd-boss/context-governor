import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { initializeWorkspace, plannedTaskPlan } from './test-fixtures.ts'

test('reads transaction-written State and refreshes its cache after invalidation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-state-'))
  try {
    const path = join(directory, 'sessions', 'session-a', 'state.json')
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    assert.equal(await workspace.state.read(), undefined)
    const initial = await initializeWorkspace(workspace, {
      mission: 'Fix duplicate charges.',
      task_plan: plannedTaskPlan('Reproduce the bug.', 'Fix key propagation.'),
      user_constraints: ['Do not change the database schema.'],
    })
    assert.equal(initial.schema_version, 1)
    assert.equal(initial.revision, 1)
    assert.equal('current_sub_step' in initial, false)
    assert.deepEqual(initial.task_plan.steps.map(step => step.step_id), ['step-000001', 'step-000002'])
    const cached = (await workspace.state.read())!
    cached.user_constraints.push('Caller-only change.')
    assert.deepEqual((await workspace.state.read())?.user_constraints, initial.user_constraints)
    const next = { ...initial, revision: 2 }
    await workspace.transition.commit(
      { state: initial, sub_states: [], artifacts: [] },
      { state: next, sub_states: [], artifacts: [] },
    )
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), next)
    assert.equal((await workspace.state.read())?.revision, 1)
    workspace.state.invalidate()
    assert.equal((await workspace.state.read())?.revision, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
