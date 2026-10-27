import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SubStateStore } from '../src/state/sub-state-store.ts'
import { plannedSubState } from './test-fixtures.ts'

async function withStore(run: (store: SubStateStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-sub-state-'))
  try {
    await run(new SubStateStore(directory), directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('reads Step-owned SubState files in stable filename order', async () => {
  await withStore(async (store, directory) => {
    const first = plannedSubState({ plan: {
      step_completion_criteria: ['Duplicate charge is observed.'],
      sub_steps: [{ action: 'Reproduce the retry timeout.', covers: [0] }],
    } })
    const second = plannedSubState({
      step_id: 'step-000002',
      used_criterion_ids: first.step_completion_criteria.map(item => item.criterion_id),
      used_sub_step_ids: [first.current_sub_step!.sub_step_id],
      plan: {
        step_completion_criteria: ['Key owner is known.'],
        sub_steps: [{ action: 'Trace key creation.', covers: [0] }],
      },
    })
    await writeFile(join(directory, 'step-000002.json'), JSON.stringify(second), 'utf8')
    await writeFile(join(directory, 'step-000001.json'), JSON.stringify(first), 'utf8')
    assert.equal(first.step_id, 'step-000001')
    assert.equal(first.current_sub_step?.sub_step_id, 'sub-step-000001')
    assert.equal(second.step_id, 'step-000002')
    assert.equal(second.current_sub_step?.sub_step_id, 'sub-step-000002')
    assert.deepEqual(await readdir(directory), ['step-000001.json', 'step-000002.json'])
    assert.deepEqual(await store.readAll(), [first, second])
  })
})

test('returns no SubStates before their directory exists', async () => {
  await withStore(async (_store, directory) => {
    assert.deepEqual(await new SubStateStore(join(directory, 'not-created')).readAll(), [])
  })
})

test('rejects a SubState file whose name disagrees with its Step identity', async () => {
  await withStore(async (store, directory) => {
    await writeFile(join(directory, 'step-000002.json'), JSON.stringify(plannedSubState()))
    await assert.rejects(() => store.readAll(), /filename does not match step_id/)
  })
})
