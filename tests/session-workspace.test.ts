import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'

import { apply as applyGovernor } from '../src/index.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { initializeWorkspace, plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

test('two Sessions receive isolated State, SubState, and audit roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-workspace-'))
  try {
    const workspaces = new SessionWorkspaceProvider(directory)
    const first = workspaces.forSession('session-a')
    const second = workspaces.forSession('session-b')
    await initializeWorkspace(first, {
      mission: 'First task.', task_plan: plannedTaskPlan('First step.'), user_constraints: [],
    }, [plannedSubState({ plan: {
      step_completion_criteria: ['First done.'],
      sub_steps: [{ action: 'Do first work.', covers: [0] }],
    } })])
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

test('uses each Session directory for resources independently of the State storage directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-resource-roots-'))
  try {
    const storage = join(directory, 'metadata', '.context-governor')
    const projects = new Map([
      ['session-a', join(directory, 'projects', 'a')],
      ['session-b', join(directory, 'projects', 'b')],
    ])
    for (const project of projects.values()) await mkdir(project, { recursive: true })
    const workspaces = new SessionWorkspaceProvider(storage, id => projects.get(id))
    const contains = { kind: 'result', summary: 'One verified value.', coverage: 'Current task.', key_facts: ['The value is 1.'], available_fields: ['value'] }
    for (const [id, project] of projects) {
      const resource = join(project, 'result.json')
      await writeFile(resource, '{"value":1}', 'utf8')
      const workspace = workspaces.forSession(id)
      await initializeWorkspace(workspace, { mission: 'Save a result.', task_plan: plannedTaskPlan('Save result.'), user_constraints: [] })
      const artifact = await workspace.artifact_service.register({ contains, resource: { path: resource, format: 'json' } }, [])
      assert.equal((await workspace.artifact_service.read(artifact)).status, 'ready')
      const continuation = await workspace.continuation_service.validate({ progress: 'Partial result saved.', working_resources: [{ path: resource, contains: 'One value.' }], resume_from: 'Verify the remaining input.' })
      assert.equal(continuation.working_resources[0]!.path, resource)
    }
    const first = workspaces.forSession('session-a')
    const otherResource = join(projects.get('session-b')!, 'result.json')
    await assert.rejects(first.artifact_service.register({ contains, resource: { path: otherResource, format: 'json' } }, []), /must stay inside the allowed workspace/)
    await assert.rejects(first.continuation_service.validate({ progress: 'Partial.', working_resources: [{ path: otherResource, contains: 'Another task.' }], resume_from: 'Continue.' }), /must stay inside the allowed workspace/)
    const storageResource = join(storage, 'sessions', 'session-a', 'state.json')
    await assert.rejects(first.artifact_service.register({ contains, resource: { path: storageResource, format: 'json' } }, []), /must stay inside the allowed workspace/)
    const restarted = new SessionWorkspaceProvider(storage, id => projects.get(id))
    assert.equal((await restarted.forSession('session-a').state.read())?.mission, 'Save a result.')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('does not infer a resource directory when Session cwd is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-missing-cwd-'))
  try {
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    assert.equal(await workspace.state.read(), undefined)
    assert.throws(() => workspace.artifact_service, /Session workspace cwd is unavailable/)
    assert.throws(() => workspace.continuation_service, /Session workspace cwd is unavailable/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('plugin resolves resource paths from the live DSH Session rather than its storage configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-dsh-cwd-'))
  try {
    const storage = join(directory, 'metadata', '.context-governor')
    const project = join(directory, 'project')
    await mkdir(project)
    const resource = join(project, 'result.json')
    await writeFile(resource, '{"value":1}', 'utf8')
    const tools = new Map<string, ToolDefinition>()
    const session = { id: 'session-a', header: { cwd: project }, snapshotEvents: () => [{ seq: 4, type: 'tool/result' }] }
    applyGovernor({
      sessions: { list: () => [session], get: (id: string) => id === session.id ? session : undefined },
      tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) },
      on() {},
    } as unknown as Context, { enabled: true, switchThresholdRatio: 0.8, workspaceDirectory: storage })
    const exec = { agent: { session } } as never
    await tools.get('initialize_context_state')!.execute({ mission: 'Inspect input.', task_plan: plannedTaskPlan('Inspect source.'), user_constraints: [] }, exec)
    await tools.get('plan_current_step')!.execute({ expected_state_revision: 1, step_id: 'step-000001', plan: {
      step_completion_criteria: ['Source inspected.'], sub_steps: [{ inputs: ['Source.'], action: 'Inspect source.', result: 'Verified source.', covers_criterion_indexes: [0] }],
    } }, exec)
    const artifact = await tools.get('register_artifact')!.execute({
      expected_state_revision: 2, source_events: ['event-4'],
      contains: { kind: 'result', summary: 'One value.', coverage: 'Current project.', key_facts: ['The value is 1.'], available_fields: ['value'] },
      resource: { path: resource, format: 'json' },
    }, exec) as { status: string }
    assert.equal(artifact.status, 'verified')
    const continued = await tools.get('record_continuation')!.execute({ operation: 'save', progress: 'Partial result saved.', working_resources: [{ path: resource, contains: 'One value.' }], resume_from: 'Inspect the remaining input.' }, exec) as { current_sub_state: { current_sub_step: { continuation: { working_resources: Array<{ path: string }> } } } }
    assert.equal(continued.current_sub_state.current_sub_step.continuation.working_resources[0]!.path, resource)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
