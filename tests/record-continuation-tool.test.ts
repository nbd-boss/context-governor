import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import { validateJsonSchemaValue } from '../../deepseek-harness/packages/core/tools/src/json-schema.ts'
import { registerRecordContinuationTool } from '../src/tools/record-continuation-tool.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { WorkspaceMutations } from '../src/workspace/workspace-mutations.ts'
import { readDurableWorkspace } from '../src/workspace/workspace-snapshot.ts'
import { initializeWorkspace, plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

const handoff = {
  progress: 'Confirmed progress is saved; the remaining result requires a missing input.',
  working_resources: [],
  resume_from: 'Wait for the required source, then inspect it and complete the remaining result.',
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'governor-continuation-tool-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaces = new SessionWorkspaceProvider(join(root, 'metadata'), () => root)
  const workspace = workspaces.forSession('session-a')
  await initializeWorkspace(workspace, {
    mission: 'Produce the required result.', task_plan: plannedTaskPlan('Produce the result.'), user_constraints: [],
  }, [plannedSubState()])
  const mutations = new WorkspaceMutations(workspaces)
  const tools: ToolDefinition[] = []
  registerRecordContinuationTool({ tools: { register: tool => tools.push(tool) } } as unknown as Context, workspaces, mutations)
  let concluded = 0
  const exec = {
    agent: { session: { id: 'session-a' } },
    concludeTurn() {
      const disk = JSON.parse(readFileSync(join(root, 'metadata', 'sessions', 'session-a', 'sub_states', 'step-000001.json'), 'utf8'))
      assert.ok(disk.current_sub_step.continuation)
      concluded++
    },
  } as never
  return { root, workspaces, workspace, tool: tools[0]!, exec, concluded: () => concluded }
}

test('requires an explicit continuation operation and save preserves its non-terminal file-backed behavior', async t => {
  const run = await setup(t)
  assert.match(validateJsonSchemaValue(run.tool.parameters, handoff).join(' '), /operation/)
  assert.notDeepEqual(validateJsonSchemaValue(run.tool.parameters, { ...handoff, operation: 'complete' }), [])
  await assert.rejects(run.tool.execute({ ...handoff, operation: 'save' }, run.exec), /save requires at least one real working Resource/)
  const resource = join(run.root, 'working.json')
  await writeFile(resource, '{"partial":true}')
  const continuation = { ...handoff, working_resources: [{ path: resource, contains: 'Confirmed partial result.' }] }
  const result = await run.tool.execute({ operation: 'save', ...continuation }, run.exec) as { status: string; state_revision: number }
  assert.equal(result.status, 'committed')
  assert.equal(result.state_revision, 2)
  assert.equal(run.concluded(), 0)
  assert.deepEqual((await run.workspace.sub_states.readAll())[0]!.current_sub_step!.continuation, continuation)
})

test('wait_for_input durably saves a text-only handoff before ending the turn without completing work', async t => {
  const run = await setup(t)
  const before = await readDurableWorkspace(run.workspaces, 'session-a')
  const result = await run.tool.execute({ operation: 'wait_for_input', ...handoff }, run.exec) as { status: string; state_revision: number }
  assert.equal(result.status, 'waiting_for_input')
  assert.equal(result.state_revision, 2)
  assert.equal(run.concluded(), 1)
  const reopened = new SessionWorkspaceProvider(join(run.root, 'metadata'), () => run.root)
  const after = await readDurableWorkspace(reopened, 'session-a')
  assert.deepEqual(after.state, { ...before.state, revision: 2 })
  assert.equal(after.state.lifecycle.status, 'active')
  assert.equal(after.state.task_plan.steps[0]!.status, 'in_progress')
  assert.deepEqual(after.sub_states[0]!.completed_sub_steps, before.sub_states[0]!.completed_sub_steps)
  assert.deepEqual(after.sub_states[0]!.step_completion_criteria, before.sub_states[0]!.step_completion_criteria)
  assert.deepEqual(after.sub_states[0]!.current_sub_step!.continuation, handoff)
  assert.equal('operation' in after.sub_states[0]!.current_sub_step!.continuation!, false)
  assert.deepEqual(await run.workspace.audits.list('session-a'), [])
})

test('waiting can reuse an identical durable save without inventing another State change', async t => {
  const run = await setup(t)
  const resource = join(run.root, 'working.json')
  await writeFile(resource, '{"partial":true}')
  const continuation = { ...handoff, working_resources: [{ path: resource, contains: 'Partial result.' }] }
  await run.tool.execute({ operation: 'save', ...continuation }, run.exec)
  run.workspace.transition.commit = async () => { throw new Error('unchanged handoff must not be rewritten') }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run.tool.execute({ operation: 'wait_for_input', ...continuation }, run.exec) as { status: string; state_revision: number }
    assert.equal(result.status, 'waiting_for_input')
    assert.equal(result.state_revision, 2)
  }
  assert.equal(run.concluded(), 2)
  assert.equal((await run.workspace.state.read())!.lifecycle.status, 'active')
})

test('invalid handoffs and persistence failures never terminate or advance the current work', async t => {
  const run = await setup(t)
  const before = await readDurableWorkspace(run.workspaces, 'session-a')
  for (const input of [
    { ...handoff, operation: 'unexpected' },
    { ...handoff, operation: 'wait_for_input', resume_from: ' ' },
    { ...handoff, operation: 'wait_for_input', working_resources: [{ path: join(run.root, 'missing.json'), contains: 'Missing resource.' }] },
  ]) {
    await assert.rejects(run.tool.execute(input, run.exec))
    assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
    assert.equal(run.concluded(), 0)
  }
  run.workspace.transition.commit = async () => { throw new Error('simulated persistence failure') }
  await assert.rejects(run.tool.execute({ ...handoff, operation: 'wait_for_input' }, run.exec), /simulated persistence failure/)
  assert.deepEqual(await readDurableWorkspace(run.workspaces, 'session-a'), before)
  assert.equal(run.concluded(), 0)
})
