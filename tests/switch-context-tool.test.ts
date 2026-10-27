import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import { validateJsonSchemaValue } from '../../deepseek-harness/packages/core/tools/src/json-schema.ts'
import type { EpochController } from '../src/epoch/epoch-controller.ts'
import { buildResidentContext } from '../src/epoch/resident-context.ts'
import { registerSwitchContextTool } from '../src/tools/switch-context-tool.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { WorkspaceMutations } from '../src/workspace/workspace-mutations.ts'
import { readDurableWorkspace } from '../src/workspace/workspace-snapshot.ts'
import { applyDiscoveredConstraints } from '../src/state/state-contract.ts'
import { initializeWorkspace, plannedSubState, plannedTaskPlan, storedConstraints } from './test-fixtures.ts'

const constraint = {
  kind: 'environment_limit' as const,
  condition: 'The file interface is restricted to the assigned workspace.',
  required_behavior: 'Do not retry inaccessible paths without evidence of changed permissions.',
  source_events: ['event-8'],
  replaces: [],
}

async function setup(root: string, planned = false) {
  const workspaces = new SessionWorkspaceProvider(root)
  const workspace = workspaces.forSession('session-a')
  await initializeWorkspace(workspace, {
    mission: 'Produce a verified result.', task_plan: plannedTaskPlan('Process inputs.'), user_constraints: [],
  }, planned ? [plannedSubState()] : [])
  const mutations = new WorkspaceMutations(workspaces)
  let switches = 0
  let concluded = 0
  const durableAtSwitch: unknown[] = []
  const epochs = { requestSwitch: async (_agent: unknown, _reason: string, changes: unknown) => {
    switches += 1
    durableAtSwitch.push({ snapshot: await readDurableWorkspace(workspaces, 'session-a'), changes })
  } } as unknown as EpochController
  let tool!: ToolDefinition
  registerSwitchContextTool({ tools: { register: (value: ToolDefinition) => { tool = value } } } as unknown as Context, epochs, mutations)
  const exec = {
    agent: { session: { id: 'session-a', snapshotEvents: () => [
      { seq: 8, type: 'tool/result' }, { seq: 9, type: 'tool/result' },
      { seq: 10, type: 'assistant/message' }, { seq: 11, type: 'step/end' }, { seq: 12, type: 'tool/call' },
      { seq: 13, type: 'user/message' }, { seq: 14, type: 'system/message' },
    ] } },
    concludeTurn: () => { concluded += 1 },
  } as never
  return { workspaces, workspace, mutations, tool, exec, durableAtSwitch, counts: () => ({ switches, concluded }) }
}

test('switch schema requires an explicit list and shares the constraint contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-switch-schema-'))
  try {
    const run = await setup(root)
    const base = { expected_state_revision: 1, reason: 'Continue in a new Epoch.' }
    assert.notDeepEqual(validateJsonSchemaValue(run.tool.parameters, base, ''), [])
    assert.deepEqual(validateJsonSchemaValue(run.tool.parameters, { ...base, new_discovered_constraints: [] }, ''), [])
    assert.deepEqual(validateJsonSchemaValue(run.tool.parameters, { ...base, new_discovered_constraints: [constraint] }, ''), [])
    assert.notDeepEqual(validateJsonSchemaValue(run.tool.parameters, { ...base, new_discovered_constraints: [{ ...constraint, kind: 'unknown' }] }, ''), [])
    await assert.rejects(run.tool.execute(base, run.exec), /missing required property "new_discovered_constraints"/)
    assert.deepEqual(run.counts(), { switches: 0, concluded: 0 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('persists all handoff constraints in one revision before switching planned or unplanned Steps', async () => {
  for (const planned of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'governor-switch-constraints-'))
    try {
      const run = await setup(root, planned)
      const before = await readDurableWorkspace(run.workspaces, 'session-a')
      const constraints = [constraint, { ...constraint, kind: 'retry_safety' as const, condition: 'A timed-out write has an unresolved outcome.', required_behavior: 'Read back its outcome before repeating the write.', source_events: ['event-9'] }]
      const result = await run.tool.execute({ expected_state_revision: 1, reason: 'Continue.', new_discovered_constraints: constraints }, run.exec)
      assert.deepEqual(result, { status: 'switched', state_revision: 2 })
      const expected = { ...before, state: { ...before.state, revision: 2, next_constraint_number: 3, discovered_constraints: storedConstraints(constraints) } }
      assert.deepEqual(run.durableAtSwitch, [{ snapshot: expected, changes: { stateChanged: true, subStepChanges: [] } }])
      assert.deepEqual(run.counts(), { switches: 1, concluded: 1 })
      const restarted = new SessionWorkspaceProvider(root)
      assert.deepEqual(await readDurableWorkspace(restarted, 'session-a'), expected)
      const resident = await buildResidentContext(restarted.forSession('session-a'), 'session-a')
      assert.deepEqual((resident!.payload.context_governor as { state: unknown }).state, expected.state)
      // Empty handoff does not invoke the writer, even when State already has constraints.
      run.workspace.transition.commit = async () => { throw new Error('unexpected write') }
      const empty = await run.tool.execute({ expected_state_revision: 2, reason: 'Continue again.', new_discovered_constraints: [] }, run.exec)
      assert.deepEqual(empty, { status: 'switched', state_revision: 2 })
      assert.deepEqual(run.counts(), { switches: 2, concluded: 2 })
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test('rejects invalid batches, unknown evidence, stale revisions, and duplicates without partial writes or switching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-switch-invalid-'))
  try {
    const run = await setup(root)
    const before = await readDurableWorkspace(run.workspaces, 'session-a')
    const base = { expected_state_revision: 1, reason: 'Continue.' }
    for (const [constraints, pattern] of [
      [[constraint, { ...constraint, condition: 'Another boundary.', required_behavior: ' ' }], /required_behavior/],
      [[constraint, { ...constraint, condition: 'Another boundary.', source_events: ['event-999'] }], /new_discovered_constraints\[1\]\.source_events: events not found in the current execution History: event-999/],
      [[{ ...constraint, source_events: ['event-008'] }], /event-N/],
      [[constraint, constraint], /duplicate/],
    ] as const) {
      await assert.rejects(run.tool.execute({ ...base, new_discovered_constraints: constraints }, run.exec), pattern)
      assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
      assert.deepEqual(run.counts(), { switches: 0, concluded: 0 })
    }
    await assert.rejects(run.tool.execute({ ...base, expected_state_revision: 0, new_discovered_constraints: [constraint] }, run.exec), /revision mismatch/)
    await run.tool.execute({ ...base, new_discovered_constraints: [constraint] }, run.exec)
    const saved = await readDurableWorkspace(run.workspaces, 'session-a')
    await assert.rejects(run.tool.execute({ ...base, expected_state_revision: 2, new_discovered_constraints: [constraint] }, run.exec), /duplicate/)
    assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), saved)
    assert.deepEqual(run.counts(), { switches: 1, concluded: 1 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failed persistence prevents the switch and retains the prior State', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-switch-write-failure-'))
  try {
    const run = await setup(root)
    const before = await readDurableWorkspace(run.workspaces, 'session-a')
    run.workspace.transition.commit = async () => { throw new Error('simulated write failure') }
    await assert.rejects(run.tool.execute({ expected_state_revision: 1, reason: 'Continue.', new_discovered_constraints: [constraint] }, run.exec), /simulated write failure/)
    assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
    assert.deepEqual(run.counts(), { switches: 0, concluded: 0 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch handoff accepts referenced specifications without tool results while rejecting missing references atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-switch-evidence-type-'))
  try {
    const run = await setup(root)
    const before = await readDurableWorkspace(run.workspaces, 'session-a')
    const base = { expected_state_revision: 1, reason: 'Continue.' }
    const references = [
      { ...constraint, source_events: ['event-13'] },
      { ...constraint, condition: 'A separate runtime input boundary.', source_events: ['event-14'] },
    ]
    await assert.rejects(run.tool.execute({
      ...base, new_discovered_constraints: [references[0], { ...references[1], source_events: ['event-999'] }],
    }, run.exec), /new_discovered_constraints\[1\]\.source_events: events not found.*event-999/)
    assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
    assert.deepEqual(run.counts(), { switches: 0, concluded: 0 })
    await run.tool.execute({ ...base, new_discovered_constraints: references }, run.exec)
    assert.deepEqual((await run.workspace.state.read())?.discovered_constraints, storedConstraints(references))
    assert.equal((await run.workspace.state.read())?.revision, 2)
    assert.deepEqual(run.counts(), { switches: 1, concluded: 1 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unclaimed Artifacts prevent both constraint persistence and the Context switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-switch-pending-artifact-'))
  try {
    const run = await setup(root)
    const before = await readDurableWorkspace(run.workspaces, 'session-a')
    await run.mutations.registerArtifact('session-a', 1, ['event-8'], async () => ({
      schema_version: 1, artifact_id: 'artifact-000001',
      contains: { kind: 'records', summary: 'Verified input.', coverage: 'All input.', key_facts: ['One record.'], available_fields: ['value'] },
      resource: { path: 'E:\\workspace\\input.json', format: 'json', content_sha256: 'a'.repeat(64) },
    }))
    await assert.rejects(run.tool.execute({ expected_state_revision: 1, reason: 'Continue.', new_discovered_constraints: [constraint] }, run.exec), /Every registered Artifact/)
    assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
    assert.deepEqual(run.counts(), { switches: 0, concluded: 0 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('recovers an interrupted handoff transaction before requesting the switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-switch-recovery-'))
  try {
    const run = await setup(root)
    const commit = run.workspace.transition.commit.bind(run.workspace.transition)
    run.workspace.transition.commit = (base, target) => commit(base, target, {
      before_install: () => { throw new Error('interrupted handoff install') },
    })
    const result = await run.tool.execute({ expected_state_revision: 1, reason: 'Continue.', new_discovered_constraints: [constraint] }, run.exec)
    assert.deepEqual(result, { status: 'switched', state_revision: 2 })
    const restarted = new SessionWorkspaceProvider(root)
    assert.deepEqual((await restarted.forSession('session-a').state.read())?.discovered_constraints, storedConstraints([constraint]))
    assert.deepEqual(run.counts(), { switches: 1, concluded: 1 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch atomically replaces active constraints with independent additions and reloads only the effective set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'governor-switch-replacement-'))
  try {
    const run = await setup(root, true)
    const independent = { ...constraint, condition: 'Another independently confirmed boundary.' }
    await run.mutations.apply('session-a', 1, base => ({ ...base, state: applyDiscoveredConstraints(base.state, [constraint, independent]) }))
    const before = await readDurableWorkspace(run.workspaces, 'session-a')
    const replacement = { ...constraint, required_behavior: 'A supported authorized path is now available; use that path.', source_events: ['event-9'], replaces: ['constraint-000001'] }
    const addition = { ...constraint, condition: 'A third independently confirmed boundary.' }
    const args = { expected_state_revision: 2, reason: 'Continue with corrected constraints.', new_discovered_constraints: [replacement, addition] }
    await assert.rejects(run.tool.execute({ ...args, new_discovered_constraints: [replacement, { ...addition, replaces: ['constraint-999999'] }] }, run.exec), /active constraint/)
    assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
    assert.deepEqual(run.counts(), { switches: 0, concluded: 0 })
    const commit = run.workspace.transition.commit.bind(run.workspace.transition)
    run.workspace.transition.commit = async () => { throw new Error('simulated replacement write failure') }
    await assert.rejects(run.tool.execute(args, run.exec), /simulated replacement write failure/)
    assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
    assert.deepEqual(run.counts(), { switches: 0, concluded: 0 })
    run.workspace.transition.commit = commit
    const result = await run.tool.execute(args, run.exec)
    assert.deepEqual(result, { status: 'switched', state_revision: 3 })
    const expected = { ...before, state: {
      ...before.state, revision: 3, next_constraint_number: 5,
      discovered_constraints: [...storedConstraints([independent], 2), ...storedConstraints([replacement, addition], 3)],
    } }
    assert.deepEqual(run.durableAtSwitch, [{ snapshot: expected, changes: { stateChanged: true, subStepChanges: [] } }])
    const restarted = new SessionWorkspaceProvider(root)
    assert.deepEqual(await readDurableWorkspace(restarted, 'session-a'), expected)
    const resident = await buildResidentContext(restarted.forSession('session-a'), 'session-a')
    assert.deepEqual((resident!.payload.context_governor as { state: unknown }).state, expected.state)
    await assert.rejects(run.tool.execute({ ...args, expected_state_revision: 3 }, run.exec), /active constraint: constraint-000001/)
    assert.deepEqual(run.counts(), { switches: 1, concluded: 1 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
