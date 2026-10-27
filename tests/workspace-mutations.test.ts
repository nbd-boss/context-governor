import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { appendUserConstraint } from '../src/state/state-contract.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { WorkspaceMutations } from '../src/workspace/workspace-mutations.ts'
import { initializeWorkspace, plannedTaskPlan } from './test-fixtures.ts'

test('serializes immediate writes and reloads their durable revisions after a switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-mutations-'))
  try {
    const workspaces = new SessionWorkspaceProvider(root)
    await initializeWorkspace(workspaces.forSession('session-a'), {
      mission: 'Do one Step.', task_plan: plannedTaskPlan('First'), user_constraints: [],
    })
    const writer = new WorkspaceMutations(workspaces)
    const first = writer.apply('session-a', 1, base => ({ ...base, state: appendUserConstraint(base.state, { constraint: 'Keep API stable.' }) }))
    const stale = writer.apply('session-a', 1, base => ({ ...base, state: appendUserConstraint(base.state, { constraint: 'Keep tests.' }) }))
    assert.equal((await first).state.revision, 2)
    await assert.rejects(stale, /revision mismatch/)
    assert.equal((await workspaces.forSession('session-a').state.read())?.user_constraints[0], 'Keep API stable.')
    assert.equal((await writer.switchSnapshot('session-a', 2, [])).state.revision, 2)
    const restarted = new SessionWorkspaceProvider(root)
    assert.deepEqual((await restarted.forSession('session-a').state.read())?.user_constraints, ['Keep API stable.'])
    await assert.rejects(writer.apply('session-a', 2, base => base), /did not change/)
    assert.equal((await restarted.forSession('session-a').state.read())?.revision, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
