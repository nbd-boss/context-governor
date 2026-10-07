import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ContextStateStore } from '../src/state/state-store.ts'
import { plannedTaskPlan } from './test-fixtures.ts'

test('persists only target task-level State with stable Step IDs and revisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-state-'))
  try {
    const path = join(directory, 'state.json')
    const store = new ContextStateStore(path)
    const initial = await store.initialize({
      mission: 'Fix duplicate charges.',
      task_plan: plannedTaskPlan('Reproduce the bug.', 'Fix key propagation.'),
      user_constraints: ['Do not change the database schema.'],
    })
    assert.equal(initial.schema_version, 1)
    assert.equal(initial.revision, 1)
    assert.equal('current_sub_step' in initial, false)
    assert.deepEqual(initial.task_plan.steps.map(step => step.step_id), ['step-000001', 'step-000002'])
    const next = { ...initial, revision: 2 }
    await store.commit(next)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), next)
    await assert.rejects(() => store.commit(next), /revision must advance/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
