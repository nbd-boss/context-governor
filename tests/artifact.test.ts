import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ArtifactService } from '../src/evidence/artifact-service.ts'
import { advanceSubStep } from '../src/epoch/epoch-projection.ts'
import { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { WorkspaceMutations } from '../src/workspace/workspace-mutations.ts'
import { initializeWorkspace, plannedSubState, plannedTaskPlan } from './test-fixtures.ts'

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
    const reread = await service.read(artifact)
    assert.equal(reread.status, 'ready')
    assert.deepEqual(reread.status === 'ready' ? reread.content : undefined, [{ course_code: 'CS101', title: 'Algorithms' }])

    assert.equal(artifact.contains.available_fields.includes('course_code'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('marks a changed or missing Resource stale without returning trusted content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-artifact-stale-'))
  try {
    const resource = join(directory, 'courses.json')
    await writeFile(resource, JSON.stringify([{ course_code: 'CS101' }]), 'utf8')
    const service = new ArtifactService(directory)
    const artifact = await service.register({
      contains: { kind: 'course_list', summary: 'One course.', coverage: 'Fixture.', key_facts: ['CS101 exists.'], available_fields: ['course_code'] },
      resource: { path: resource, format: 'json' },
    }, [])
    await writeFile(resource, JSON.stringify([{ course_code: 'CS101' }, { course_code: 'MATH201' }]), 'utf8')
    const result = await service.read(artifact)
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

test('persists an Artifact only with its producer during immediate SubStep commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-artifact-boundary-'))
  try {
    const resource = join(directory, 'courses.json')
    await writeFile(resource, JSON.stringify([{ course_code: 'CS101' }]), 'utf8')
    const workspaces = new SessionWorkspaceProvider(directory, () => directory)
    const workspace = workspaces.forSession('session-a')
    const state = await initializeWorkspace(workspace, {
      mission: 'Inspect courses.', task_plan: plannedTaskPlan('List courses.'), user_constraints: [],
    }, [plannedSubState({ plan: {
      step_completion_criteria: ['Course list is known.', 'The next action is selected.'],
      sub_steps: [
        { action: 'Read courses.', covers: [0] },
        { action: 'Use the course.', covers: [1] },
      ],
    } })])
    const input = {
      contains: { kind: 'course_list', summary: 'One course.', coverage: 'Fixture.', key_facts: ['CS101 exists.'], available_fields: ['course_code'] },
      resource: { path: resource, format: 'json' as const },
    }
    const mutations = new WorkspaceMutations(workspaces)
    const { artifact } = await mutations.registerArtifact('session-a', state.revision, ['event-4'], known => workspace.artifact_service.register(input, known))
    assert.equal(await workspace.artifacts.read(artifact.artifact_id), undefined)
    const target = await mutations.apply('session-a', state.revision, (base, pending) => {
      const criterion_evidence = [{ criterion_id: 'criterion-000001' as const, source_events: ['event-4'] }]
      const artifact_refs = [{ artifact_id: artifact.artifact_id, relation: 'produced' as const }]
      return advanceSubStep(base, {
        step_id: 'step-000001', expected_sub_step_id: 'sub-step-000001',
        completed: { summary: 'CS101 is available.', criterion_evidence, artifact_refs },
        introduced_artifacts: mutations.producedArtifacts(pending, artifact_refs, criterion_evidence),
      })
    })
    assert.equal(target.state.revision, state.revision + 1)
    assert.equal((await workspace.artifacts.read(artifact.artifact_id))?.contains.summary, 'One course.')
    assert.deepEqual((await workspace.artifacts.readAll()).map(item => item.artifact_id), [artifact.artifact_id])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
