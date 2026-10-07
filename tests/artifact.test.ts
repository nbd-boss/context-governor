import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ArtifactService } from '../src/evidence/artifact-service.ts'
import { ArtifactStore } from '../src/evidence/artifact-store.ts'
import { EpochDeltaBuffer } from '../src/epoch/epoch-delta-buffer.ts'
import { stampBoundaryRevision } from '../src/epoch/epoch-projection.ts'
import { createInitialState } from '../src/state/state-contract.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

test('validates a structured Artifact before its producer SubStep makes it durable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-artifact-'))
  try {
    const resource = join(directory, 'courses.json')
    await writeFile(resource, JSON.stringify([{ course_code: 'CS101', title: 'Algorithms' }]), 'utf8')
    const service = new ArtifactService(directory)
    const artifact = await service.register({
      contains: {
        kind: 'course_list', summary: 'One course.', coverage: 'Current local fixture.',
        key_facts: ['The fixture contains CS101.'], available_fields: ['course_code', 'title'],
      },
      resource: { path: resource, format: 'json' },
    }, [])
    assert.equal(artifact.artifact_id, 'artifact-000001')
    assert.equal((await service.read(artifact)).status, 'ready')

    const state = createInitialState({ mission: 'Inspect courses.', task_plan: plannedTaskPlan('List courses.'), user_constraints: [] })
    const base = { state, sub_states: [plannedSubState({ plan: {
      step_completion_criteria: ['Course list is known.', 'The next action is selected.'],
      sub_steps: [
        { action: 'Read courses.', completion_criteria: ['Course list is known.'], covers: [0] },
        { action: 'Use the course list.', completion_criteria: ['The next action is selected.'], covers: [1] },
      ],
    } })], artifacts: [] }
    const deltas = new EpochDeltaBuffer()
    const registered = deltas.recordArtifact({
      sessionId: 'session-a', durable: base, expectedRevision: 0, reason: 'Course list is reusable.', artifact, source_events: ['event-4'],
    })
    assert.equal(registered.projected.artifacts.length, 0)
    assert.equal(registered.pending_artifacts.length, 1)
    const completed = deltas.recordSubStep({
      sessionId: 'session-a', durable: base, expectedRevision: 1, reason: 'Course list captured.',
      operation: {
        step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
        completed: { summary: 'CS101 is available.', source_events: ['event-4'], artifact_refs: [{ artifact_id: artifact.artifact_id, relation: 'produced' }] },
      },
    })
    assert.equal(completed.pending_artifacts.length, 0)
    assert.equal(completed.projected.artifacts[0]?.artifact_id, artifact.artifact_id)
    assert.equal(completed.projected.sub_states[0]?.completed_sub_steps[0]?.artifact_refs[0]?.relation, 'produced')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps Artifact metadata immutable and marks a changed Resource stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-artifact-stale-'))
  try {
    const resource = join(directory, 'courses.json')
    await writeFile(resource, JSON.stringify([{ course_code: 'CS101' }]), 'utf8')
    const service = new ArtifactService(directory)
    const artifact = await service.register({
      contains: { kind: 'course_list', summary: 'One course.', coverage: 'Fixture.', key_facts: ['CS101 exists.'], available_fields: ['course_code'] },
      resource: { path: resource, format: 'json' },
    }, [])
    const store = new ArtifactStore(join(directory, 'artifacts'))
    await store.save(artifact)
    await assert.rejects(() => store.save(artifact), /immutable/)
    await writeFile(resource, JSON.stringify([{ course_code: 'CS101' }, { course_code: 'MATH201' }]), 'utf8')
    const result = await service.read((await store.read(artifact.artifact_id))!)
    assert.equal(result.status, 'stale')
    assert.equal('content' in result, false)
    await unlink(resource)
    assert.equal((await service.read(artifact)).status, 'stale')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reserves each Artifact Resource path exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-artifact-path-'))
  try {
    const resource = join(directory, 'courses.json')
    await writeFile(resource, JSON.stringify([{ course_code: 'CS101' }]), 'utf8')
    const service = new ArtifactService(directory)
    const first = await service.register({
      contains: { kind: 'course_list', summary: 'One course.', coverage: 'First snapshot.', key_facts: ['CS101 exists.'], available_fields: ['course_code'] },
      resource: { path: resource, format: 'json' },
    }, [])
    await assert.rejects(() => service.register({
      contains: first.contains,
      resource: { path: resource, format: 'json' },
    }, [first]), /already registered by artifact-000001.*reference that Artifact as used/)

    await writeFile(resource, JSON.stringify([{ course_code: 'CS101' }, { course_code: 'MATH201' }]), 'utf8')
    await assert.rejects(() => service.register({
      contains: { kind: 'course_list', summary: 'Two courses.', coverage: 'Revised snapshot.', key_facts: ['CS101 and MATH201 exist.'], available_fields: ['course_code'] },
      resource: { path: resource, format: 'json' },
    }, [first]), /owned by artifact-000001 and its content has changed.*new absolute path/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('registers a revised result at a new path without invalidating the old Artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-artifact-version-'))
  try {
    const firstPath = join(directory, 'courses-001.json')
    const secondPath = join(directory, 'courses-002.json')
    await writeFile(firstPath, JSON.stringify([{ course_code: 'CS101' }]), 'utf8')
    await writeFile(secondPath, JSON.stringify([{ course_code: 'CS101' }, { course_code: 'MATH201' }]), 'utf8')
    const service = new ArtifactService(directory)
    const first = await service.register({
      contains: { kind: 'course_list', summary: 'One course.', coverage: 'First snapshot.', key_facts: ['CS101 exists.'], available_fields: ['course_code'] },
      resource: { path: firstPath, format: 'json' },
    }, [])
    const second = await service.register({
      contains: { kind: 'course_list', summary: 'Two courses.', coverage: 'Second snapshot.', key_facts: ['CS101 and MATH201 exist.'], available_fields: ['course_code'] },
      resource: { path: secondPath, format: 'json' },
    }, [first])
    assert.equal(second.artifact_id, 'artifact-000002')
    assert.equal((await service.read(first)).status, 'ready')
    assert.equal((await service.read(second)).status, 'ready')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects an Artifact whose declared fields are absent from its Resource', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-artifact-fields-'))
  try {
    const resource = join(directory, 'courses.csv')
    await writeFile(resource, 'course_code,title\nCS101,Algorithms\n', 'utf8')
    const service = new ArtifactService(directory)
    await assert.rejects(() => service.register({
      contains: { kind: 'course_list', summary: 'One course.', coverage: 'Fixture.', key_facts: ['CS101 exists.'], available_fields: ['deadline'] },
      resource: { path: resource, format: 'csv' },
    }, []), /does not provide declared field/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('persists an Artifact only with its producer at the Context boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-artifact-boundary-'))
  try {
    const resource = join(directory, 'courses.json')
    await writeFile(resource, JSON.stringify([{ course_code: 'CS101' }]), 'utf8')
    const workspace = new SessionWorkspaceProvider(directory).forSession('session-a')
    const state = await workspace.state.initialize({
      mission: 'Inspect courses.', task_plan: plannedTaskPlan('List courses.'), user_constraints: [],
    })
    await workspace.sub_states.save(plannedSubState({ plan: {
      step_completion_criteria: ['Course list is known.', 'The next action is selected.'],
      sub_steps: [
        { action: 'Read courses.', completion_criteria: ['Course list is known.'], covers: [0] },
        { action: 'Use the course.', completion_criteria: ['Next action is selected.'], covers: [1] },
      ],
    } }))
    const base = { state, sub_states: await workspace.sub_states.readAll(), artifacts: await workspace.artifacts.readAll() }
    const artifact = await workspace.artifact_service.register({
      contains: { kind: 'course_list', summary: 'One course.', coverage: 'Fixture.', key_facts: ['CS101 exists.'], available_fields: ['course_code'] },
      resource: { path: resource, format: 'json' },
    }, [])
    const deltas = new EpochDeltaBuffer()
    deltas.recordArtifact({ sessionId: 'session-a', durable: base, expectedRevision: 0, reason: 'Reusable course rows.', artifact, source_events: ['event-4'] })
    const recorded = deltas.recordSubStep({
      sessionId: 'session-a', durable: base, expectedRevision: 1, reason: 'Course list captured.',
      operation: {
        step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
        completed: { summary: 'CS101 is available.', source_events: ['event-4'], artifact_refs: [{ artifact_id: artifact.artifact_id, relation: 'produced' }] },
      },
    })
    assert.equal(await workspace.artifacts.read(artifact.artifact_id), undefined)
    const order: string[] = []
    await workspace.transition.commit(base, stampBoundaryRevision(base.state, recorded.projected), {
      before_install: file => { order.push(file.kind) },
    })
    assert.deepEqual(order, ['artifact', 'sub_state', 'state'])
    assert.equal((await workspace.artifacts.read(artifact.artifact_id))?.contains.summary, 'One course.')
    assert.equal((await workspace.artifacts.readMany([artifact.artifact_id]))[0]?.artifact_id, artifact.artifact_id)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
