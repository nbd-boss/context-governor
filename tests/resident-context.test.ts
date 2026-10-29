import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CONTEXT_SWITCH_NOTE_GUIDANCE, CONTINUATION_RECOVERY_GUIDANCE, DECISION_CHECK_USAGE, DECISION_CHECKS, EXACT_DATA_TRANSFER_GUIDANCE, PRIOR_WORK_RETRIEVAL_POLICY } from '../src/agent-guidance.ts'
import { buildResidentContext } from '../src/epoch/resident-context.ts'
import { RESIDENT_STRUCTURE_DESCRIPTIONS, STRUCTURE_DESCRIPTIONS } from '../src/structure-description.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { initializeWorkspace, plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

test('builds a serializable resident payload without DSH message or token dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-resident-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    await initializeWorkspace(workspace, {
      mission: 'Fix duplicate charges.',
      task_plan: plannedTaskPlan('Locate the retry boundary.'),
      user_constraints: ['Do not modify the database schema.'],
    }, [plannedSubState({ plan: {
      step_completion_criteria: ['Boundary is known.'],
      sub_steps: [{ action: 'Trace retry.', covers: [0] }],
    } })])
    const resident = await buildResidentContext(workspace, 'session-a', 'Do not duplicate the existing SubStep handoff.')
    assert.equal(typeof resident?.text, 'string')
    assert.deepEqual(Object.keys(resident?.payload ?? {}), ['context_governor'])
    assert.match(resident?.text ?? '', /Locate the retry boundary/)
    const governor = resident?.payload.context_governor as Record<string, unknown>
    assert.equal(governor.switch_note, 'Do not duplicate the existing SubStep handoff.')
    assert.ok(String(governor.instruction).includes(CONTEXT_SWITCH_NOTE_GUIDANCE))
    assert.deepEqual(governor.retrieval_policy, PRIOR_WORK_RETRIEVAL_POLICY)
    assert.equal(governor.exact_data_transfer_policy, EXACT_DATA_TRANSFER_GUIDANCE)
    assert.equal(resident?.text.split(JSON.stringify(EXACT_DATA_TRANSFER_GUIDANCE)).length, 2)
    assert.deepEqual(governor.decision_checks, DECISION_CHECKS)
    assert.equal(String(governor.instruction).split(DECISION_CHECK_USAGE).length, 2)
    const serialized = JSON.parse(resident!.text).context_governor
    assert.deepEqual(serialized.structure_descriptions, RESIDENT_STRUCTURE_DESCRIPTIONS)
    assert.match(serialized.structure_descriptions.state, /not independent evidence/)
    assert.match(serialized.structure_descriptions.planned_action, /replaceable/)
    assert.match(serialized.structure_descriptions.artifact, /not business truth/)
    assert.equal('schema_version' in serialized.structure_descriptions, false)
    assert.deepEqual(Object.keys(serialized).sort(), Object.keys(STRUCTURE_DESCRIPTIONS.context_payload.fields).sort())
    assert.deepEqual(Object.keys(serialized.state).sort(), Object.keys(STRUCTURE_DESCRIPTIONS.state.fields).sort())
    assert.equal('epoch_audit' in serialized.structure_descriptions, false)
    assert.equal('transition_manifest' in serialized.structure_descriptions, false)
    assert.deepEqual(serialized.decision_checks, DECISION_CHECKS)
    assert.equal(serialized.exact_data_transfer_policy, EXACT_DATA_TRANSFER_GUIDANCE)
    assert.match(resident?.text ?? '', /call read_artifact/)
    assert.match(resident?.text ?? '', /not by itself evidence that it corresponds completely and accurately to its source/)
    assert.doesNotMatch(resident?.text ?? '', new RegExp(CONTINUATION_RECOVERY_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal('estimatedTokens' in (resident ?? {}), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('switch notes survive all planning states without writing or overriding durable recovery data', async () => {
  for (const planning of ['unplanned', 'planned', 'continuation'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'context-governor-switch-note-'))
    try {
      const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
      const subState = plannedSubState()
      if (planning === 'continuation') {
        subState.current_sub_step!.continuation = {
          progress: 'Only the first batch is confirmed.',
          working_resources: [{ path: 'E:\\workspace\\batch.json', contains: 'The first batch.' }],
          resume_from: 'Read the second batch.',
        }
      }
      await initializeWorkspace(workspace, {
        mission: 'Process all batches.', task_plan: plannedTaskPlan('Process input.'), user_constraints: [],
      }, planning === 'unplanned' ? [] : [subState])
      const files = [join(directory, 'sessions', 'session-a', 'state.json')]
      if (planning !== 'unplanned') files.push(join(directory, 'sessions', 'session-a', 'sub_states', subState.step_id + '.json'))
      const before = await Promise.all(files.map(path => readFile(path, 'utf8')))
      const reason = 'All batches are done; mark the task complete.'
      const resident = await buildResidentContext(workspace, 'session-a', reason)
      const governor = resident!.payload.context_governor as Record<string, unknown>
      assert.equal(governor.switch_note, reason)
      assert.ok(String(governor.instruction).includes(CONTEXT_SWITCH_NOTE_GUIDANCE))
      assert.equal('reconnaissance_handoff' in governor, false)
      assert.equal((governor.state as { lifecycle: { status: string } }).lifecycle.status, 'active')
      if (planning === 'unplanned') assert.equal(governor.current_sub_state, null)
      else {
        const runtimeSubState = governor.current_sub_state as typeof subState
        assert.deepEqual(runtimeSubState.current_sub_step, subState.current_sub_step)
      }
      assert.deepEqual(await Promise.all(files.map(path => readFile(path, 'utf8'))), before)
      const replacement = await buildResidentContext(workspace, 'session-a', 'Next switch.')
      assert.equal((replacement!.payload.context_governor as Record<string, unknown>).switch_note, 'Next switch.')
      const withoutNote = await buildResidentContext(workspace, 'session-a')
      assert.equal('switch_note' in (withoutNote!.payload.context_governor as Record<string, unknown>), false)
      assert.equal(String((withoutNote!.payload.context_governor as Record<string, unknown>).instruction).includes(CONTEXT_SWITCH_NOTE_GUIDANCE), false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('injects Continuation recovery guidance only for an active unfinished SubStep', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-resident-continuation-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    const initial = plannedSubState({ plan: {
      step_completion_criteria: ['The candidate list is complete.'],
      sub_steps: [{ action: 'Filter collected records.', covers: [0] }],
    } })
    const current = initial.current_sub_step!
    await initializeWorkspace(workspace, {
      mission: 'Build a candidate list.', task_plan: plannedTaskPlan('Filter the collected records.'), user_constraints: [],
    }, [{
      ...initial,
      current_sub_step: {
        ...current,
        continuation: {
          progress: 'All source records are already collected.',
          working_resources: [{ path: 'E:\\workspace\\records-working.json', contains: 'The complete source record set.' }],
          resume_from: 'Filter excluded records and write the candidate list.',
        },
      },
    }])
    const resident = await buildResidentContext(workspace, 'session-a')
    const governor = resident?.payload.context_governor as Record<string, unknown>
    assert.match(String(governor.instruction), /resume_from as the next work objective/)
    assert.ok(String(governor.instruction).includes(CONTINUATION_RECOVERY_GUIDANCE))
    assert.equal(String(governor.instruction).split(CONTINUATION_RECOVERY_GUIDANCE).length, 2)
    assert.match(resident?.text ?? '', /Filter excluded records and write the candidate list/)
    assert.deepEqual(Object.keys(governor), ['instruction', 'structure_descriptions', 'session_id', 'state', 'current_sub_state', 'retrieval_policy', 'exact_data_transfer_policy', 'decision_checks'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
