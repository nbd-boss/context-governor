import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CONTINUATION_RECOVERY_GUIDANCE, PRIOR_WORK_RETRIEVAL_POLICY } from '../src/agent-guidance.ts'
import { buildResidentContext } from '../src/epoch/resident-context.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

test('builds a serializable resident payload without DSH message or token dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-resident-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    const state = await workspace.state.initialize({
      mission: 'Fix duplicate charges.',
      task_plan: plannedTaskPlan('Locate the retry boundary.'),
      user_constraints: ['Do not modify the database schema.'],
    })
    await workspace.sub_states.save(plannedSubState({ plan: {
      step_completion_criteria: ['Boundary is known.'],
      sub_steps: [{ action: 'Trace retry.', completion_criteria: ['Boundary is known.'], covers: [0] }],
    } }))
    const resident = await buildResidentContext(workspace, 'session-a')
    assert.equal(typeof resident?.text, 'string')
    assert.deepEqual(Object.keys(resident?.payload ?? {}), ['context_governor'])
    assert.match(resident?.text ?? '', /Locate the retry boundary/)
    const governor = resident?.payload.context_governor as Record<string, unknown>
    assert.deepEqual(governor.retrieval_policy, PRIOR_WORK_RETRIEVAL_POLICY)
    assert.match(resident?.text ?? '', /call read_artifact/)
    assert.doesNotMatch(resident?.text ?? '', new RegExp(CONTINUATION_RECOVERY_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal('estimatedTokens' in (resident ?? {}), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('injects Continuation recovery guidance only for an active unfinished SubStep', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-resident-continuation-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    await workspace.state.initialize({
      mission: 'Build a candidate list.', task_plan: plannedTaskPlan('Filter the collected records.'), user_constraints: [],
    })
    const initial = plannedSubState({ plan: {
      step_completion_criteria: ['The candidate list is complete.'],
      sub_steps: [{ action: 'Filter collected records.', completion_criteria: ['Only required records remain.'], covers: [0] }],
    } })
    const current = initial.current_sub_step!
    await workspace.sub_states.save({
      ...initial,
      current_sub_step: {
        ...current,
        continuation: {
          progress: 'All source records are already collected.',
          working_resources: [{ path: 'E:\\workspace\\records-working.json', contains: 'The complete source record set.' }],
          resume_from: 'Filter excluded records and write the candidate list.',
        },
      },
    })
    const resident = await buildResidentContext(workspace, 'session-a')
    const governor = resident?.payload.context_governor as Record<string, unknown>
    assert.match(String(governor.instruction), /resume_from as the next work objective/)
    assert.match(resident?.text ?? '', /Filter excluded records and write the candidate list/)
    assert.deepEqual(Object.keys(governor), ['instruction', 'session_id', 'state', 'global_step_navigation', 'current_sub_state', 'retrieval_policy'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
