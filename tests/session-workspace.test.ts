import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

test('two Sessions receive isolated State, SubState, and audit roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-workspace-'))
  try {
    const workspaces = new SessionWorkspaceProvider(directory)
    const first = workspaces.forSession('session-a')
    const second = workspaces.forSession('session-b')
    const state = await first.state.initialize({
      mission: 'First task.', task_plan: plannedTaskPlan('First step.'), user_constraints: [],
    })
    await first.sub_states.save(plannedSubState({ plan: {
      step_completion_criteria: ['First done.'],
      sub_steps: [{ action: 'Do first work.', completion_criteria: ['First done.'], covers: [0] }],
    } }))
    await first.audits.startEpoch({ sessionId: 'session-a', baselineEvent: 'event-2', residentTokens: 100 })
    assert.equal(await second.state.read(), undefined)
    assert.deepEqual(await second.sub_states.readAll(), [])
    assert.deepEqual(await second.audits.list('session-b'), [])
    assert.equal((await first.sub_states.readAll()).length, 1)
    assert.equal((await first.audits.list('session-a')).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
