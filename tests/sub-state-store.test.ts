import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
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

test('stores one authoritative SubState file for each started Step', async () => {
  await withStore(async (store, directory) => {
    const first = await store.save(plannedSubState({ plan: {
      step_completion_criteria: ['Duplicate charge is observed.'],
      sub_steps: [{ action: 'Reproduce the retry timeout.', completion_criteria: ['Duplicate charge is observed.'], covers: [0] }],
    } }))
    const second = await store.save(plannedSubState({
      step_id: 'step-000002', sub_state_id: 'sub-state-000002',
      used_criterion_ids: first.step_completion_criteria.map(item => item.criterion_id),
      used_sub_step_ids: [first.current_sub_step!.sub_step_id],
      plan: {
        step_completion_criteria: ['Key owner is known.'],
        sub_steps: [{ action: 'Trace key creation.', completion_criteria: ['Key owner is known.'], covers: [0] }],
      },
    }))
    assert.equal(first.sub_state_id, 'sub-state-000001')
    assert.equal(first.current_sub_step?.sub_step_id, 'sub-step-000001')
    assert.equal(second.sub_state_id, 'sub-state-000002')
    assert.equal(second.current_sub_step?.sub_step_id, 'sub-step-000002')
    assert.deepEqual(await readdir(directory), ['sub-state-000001.json', 'sub-state-000002.json'])
    assert.equal((await store.read('step-000002'))?.current_sub_step?.action, 'Trace key creation.')
  })
})

test('allows only the existing SubState to be replaced and keeps its Step owner immutable', async () => {
  await withStore(async store => {
    const initial = await store.save(plannedSubState({ plan: {
      step_completion_criteria: ['Duplicate charge is observed.'],
      sub_steps: [{ action: 'Reproduce the retry timeout.', completion_criteria: ['Duplicate charge is observed.'], covers: [0] }],
    } }))
    const completed = {
      ...initial,
      completed_sub_steps: [{
        sub_step_id: initial.current_sub_step!.sub_step_id,
        action: initial.current_sub_step!.action,
        completion_criteria: initial.current_sub_step!.completion_criteria,
        covers: initial.current_sub_step!.covers,
        summary: 'One retry creates two charges.',
        source_events: ['event-4'],
        artifact_refs: [],
      }],
      current_sub_step: null,
      pending_sub_steps: [],
    }
    assert.equal((await store.commit(completed)).current_sub_step, null)
    await assert.rejects(() => store.commit({ ...completed, step_id: 'step-000002' as never }), /step_id is immutable/)
  })
})
