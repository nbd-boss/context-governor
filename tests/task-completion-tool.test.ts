import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import { validateJsonSchemaValue } from '../../deepseek-harness/packages/core/tools/src/json-schema.ts'
import type { EpochController } from '../src/epoch/epoch-controller.ts'
import { registerAdvanceTaskProgressTool } from '../src/tools/advance-task-progress-tool.ts'
import { registerRecordContinuationTool } from '../src/tools/record-continuation-tool.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { WorkspaceMutations } from '../src/workspace/workspace-mutations.ts'
import { readDurableWorkspace } from '../src/workspace/workspace-snapshot.ts'
import { initializeWorkspace, plannedSubState } from './test-fixtures.ts'

function checks(outcome: 'met' | 'unmet' | 'unverified' = 'met') {
  return [
    { criterion_index: 0, outcome, source_events: ['event-8'] },
    { criterion_index: 1, outcome: 'met' as const, source_events: ['event-9'] },
  ]
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'governor-task-criteria-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaces = new SessionWorkspaceProvider(root, () => root)
  const workspace = workspaces.forSession('session-a')
  await initializeWorkspace(workspace, {
    mission: 'Archive all required documents without changing sources.', user_constraints: [],
    task_plan: {
      completion_criteria: ['All required documents are archived.', 'Source files are unchanged.'],
      steps: [{ inputs: ['Source documents.'], step: 'Archive and verify documents.', result: 'All verified archives.', covers: [0, 1] }],
    },
  }, [plannedSubState()])
  const mutations = new WorkspaceMutations(workspaces)
  const tools: ToolDefinition[] = []
  const ctx = { tools: { register: (tool: ToolDefinition) => { tools.push(tool) } } } as unknown as Context
  let completed = 0
  let concluded = 0
  const epochs = { complete: async () => { completed += 1 } } as unknown as EpochController
  registerAdvanceTaskProgressTool(ctx, epochs, mutations)
  registerRecordContinuationTool(ctx, workspaces, mutations)
  const exec = {
    agent: { session: { id: 'session-a', snapshotEvents: () => [
      { seq: 4, type: 'user/message' }, { seq: 8, type: 'tool/result' }, { seq: 9, type: 'tool/result' },
    ] } },
    concludeTurn: () => { concluded += 1 },
  } as never
  const args = (taskChecks: unknown = checks(), revision = 1) => ({
    expected_state_revision: revision,
    transition: {
      type: 'complete_task', step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
      completed: { summary: 'The final check is recorded.', criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-9'] }], artifact_refs: [] },
      task_criteria_check: taskChecks,
    },
  })
  return { root, workspaces, workspace, mutations, tool: tools[0]!, continuation: tools[1]!, exec, args, counts: () => ({ completed, concluded }) }
}

test('only the terminal branch requires task checks and each branch rejects unrelated fields', async t => {
  const run = await setup(t)
  const terminalChecks = checks()
  const base = run.args(terminalChecks)
  const { task_criteria_check, ...identity } = base.transition
  assert.deepEqual(task_criteria_check, terminalChecks)
  const validate = (transition: unknown) => validateJsonSchemaValue(run.tool.parameters, { ...base, transition }, '')
  assert.deepEqual(validate(base.transition), [])
  assert.notDeepEqual(validate(identity), [])
  assert.deepEqual(validate({ ...identity, type: 'advance_sub_step' }), [])
  assert.deepEqual(validate({ ...identity, type: 'advance_step', next_step: { step_id: 'step-000002' } }), [])
  assert.notDeepEqual(validate({ ...identity, type: 'advance_step' }), [])
  assert.notDeepEqual(validate({ ...base.transition, type: 'advance_sub_step' }), [])
  assert.notDeepEqual(validate({ ...base.transition, type: 'advance_step', next_step: { step_id: 'step-000002' } }), [])
  assert.notDeepEqual(validate({ ...base.transition, next_step: { step_id: 'step-000002' } }), [])
  assert.notDeepEqual(validate({ ...base.transition, task_criteria_check: [{ ...terminalChecks[0], outcome: 'pass' }] }), [])
  assert.notDeepEqual(validate({ ...base.transition, task_criteria_check: [{ ...terminalChecks[0], criterion_index: '0' }] }), [])
  const before = await readDurableWorkspace(run.workspaces, 'session-a')
  await assert.rejects(run.tool.execute({ ...base, transition: identity }, run.exec), /oneOf/)
  await assert.rejects(run.tool.execute({ ...base, transition: { ...base.transition, type: 'advance_sub_step' } }, run.exec), /oneOf/)
  assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
  assert.deepEqual(run.counts(), { completed: 0, concluded: 0 })
})

test('rejects missing, duplicate, unknown, and unsupported task evidence without committing any progress', async t => {
  const run = await setup(t)
  const before = await readDurableWorkspace(run.workspaces, 'session-a')
  for (const [value, pattern] of [
    [[], /missing effective criterion indexes: 0, 1/],
    [[checks()[0]], /missing effective criterion indexes: 1/],
    [[...checks(), checks()[0]], /duplicate criterion_index/],
    [[...checks(), { criterion_index: 2, outcome: 'met', source_events: ['event-8'] }], /effective task_plan.completion_criteria entry/],
    [[{ ...checks()[0], criterion_index: -1 }, checks()[1]], /effective task_plan.completion_criteria entry/],
    [[{ ...checks()[0], source_events: [] }, checks()[1]], /one or more event-N/],
    [[{ ...checks()[0], source_events: ['event-008'] }, checks()[1]], /one or more event-N/],
    [[{ ...checks()[0], source_events: ['event-999'] }, checks()[1]], /events not found.*event-999/],
  ] as const) {
    await assert.rejects(run.tool.execute(run.args(value), run.exec), pattern)
    assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
    assert.deepEqual(run.counts(), { completed: 0, concluded: 0 })
  }
})

test('a documented missing result rejects completion and retains saved partial progress until a corrected retry', async t => {
  const run = await setup(t)
  const resource = join(run.root, 'progress.json')
  await writeFile(resource, '{"archived":["alpha","beta"],"missing":["gamma"]}', 'utf8')
  const continuation = {
    progress: 'Two documents archived; the third has no source and remains unresolved.',
    working_resources: [{ path: resource, contains: 'Confirmed archives and the missing source.' }],
    resume_from: 'When the source is supplied, archive the remaining document and verify all outputs.',
  }
  await run.continuation.execute({ operation: 'save', ...continuation }, run.exec)
  const before = await readDurableWorkspace(run.workspaces, 'session-a')
  assert.equal(before.state.revision, 2)
  for (const outcome of ['unmet', 'unverified'] as const) {
    const input = run.args(checks(outcome), 2)
    input.transition.completed.summary = 'The missing source has been documented; the reporting work is complete.'
    await assert.rejects(run.tool.execute(input, run.exec), /Cannot complete task.*completion_criteria\[0\]/)
    assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
    assert.deepEqual(run.counts(), { completed: 0, concluded: 0 })
  }
  // New evidence must be judged by the Agent; the tool validates the explicit
  // declarations, not the business meaning of these scripted test events.
  const verified = checks().map(check => ({ ...check, source_events: ['event-9'] }))
  await run.tool.execute(run.args(verified, 2), run.exec)
  const after = await readDurableWorkspace(run.workspaces, 'session-a')
  assert.equal(after.state.revision, 3)
  assert.equal(after.state.lifecycle.status, 'completed')
  assert.equal(after.sub_states[0]!.current_sub_step, null)
  assert.equal(after.sub_states[0]!.completed_sub_steps.length, 1)
  assert.deepEqual(run.counts(), { completed: 1, concluded: 1 })
  assert.ok(!JSON.stringify(after).includes('task_criteria_check'))
  const restarted = new SessionWorkspaceProvider(run.root)
  assert.deepEqual(await readDurableWorkspace(restarted, 'session-a'), after)
})

test('terminal checks use current effective criteria and preserve original indexes after a replan', async t => {
  const run = await setup(t)
  await run.mutations.apply('session-a', 1, base => ({
    ...base,
    state: { ...base.state, task_plan: {
      ...base.state.task_plan,
      completion_criteria: [...base.state.task_plan.completion_criteria, 'The revised archive requirement is met.'],
      superseded_criteria: [0],
      steps: base.state.task_plan.steps.map(step => ({ ...step, covers: [1, 2] })),
    } },
  }))
  const before = await readDurableWorkspace(run.workspaces, 'session-a')
  await assert.rejects(run.tool.execute(run.args(checks(), 1), run.exec), /revision mismatch/)
  await assert.rejects(run.tool.execute(run.args(checks(), 2), run.exec), /effective task_plan.completion_criteria entry/)
  const revised = [checks()[1], { criterion_index: 2, outcome: 'met', source_events: ['event-9'] }]
  await assert.rejects(run.tool.execute(run.args([checks()[1]], 2), run.exec), /missing effective criterion indexes: 2/)
  assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
  await run.tool.execute(run.args(revised, 2), run.exec)
  assert.equal((await run.workspace.state.read())!.lifecycle.status, 'completed')
})

test('valid terminal checks do not bypass existing SubStep evidence or persistence failures', async t => {
  const run = await setup(t)
  const before = await readDurableWorkspace(run.workspaces, 'session-a')
  const missingLocalEvidence = run.args()
  missingLocalEvidence.transition.completed.criterion_evidence = []
  await assert.rejects(run.tool.execute(missingLocalEvidence, run.exec), /missing evidence for criterion_id/)
  run.workspace.transition.commit = async () => { throw new Error('simulated write failure') }
  await assert.rejects(run.tool.execute(run.args(), run.exec), /simulated write failure/)
  assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
  assert.deepEqual(run.counts(), { completed: 0, concluded: 0 })
})
