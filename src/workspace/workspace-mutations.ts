import type { Artifact } from '../evidence/artifact-contract.ts'
import { validateArtifact } from '../evidence/artifact-contract.ts'
import { criterionEvidenceEventIds, type ArtifactRef, type CriterionEvidence } from '../state/sub-state-contract.ts'
import { validateWorkspaceSnapshot, type WorkspaceSnapshot } from './workspace-validator.ts'
import { readDurableWorkspace } from './workspace-snapshot.ts'
import type { SessionWorkspaceProvider } from './session-workspace.ts'
import { applyDiscoveredConstraints, type DiscoveredConstraintChange } from '../state/state-contract.ts'

interface PendingArtifact {
  artifact: Artifact
  source_events: string[]
}

/** One durable State revision per successful mutation; only unclaimed Artifacts remain staged. */
export class WorkspaceMutations {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, PendingArtifact[]>()

  constructor(private readonly workspaces: SessionWorkspaceProvider) {}

  async apply(
    sessionId: string,
    expectedRevision: number | undefined,
    project: (base: WorkspaceSnapshot, pending: readonly PendingArtifact[]) => WorkspaceSnapshot,
    options: { allowUnchanged?: boolean } = {},
  ): Promise<WorkspaceSnapshot> {
    return this.serial(sessionId, async () => {
      const base = validateWorkspaceSnapshot(await readDurableWorkspace(this.workspaces, sessionId))
      this.requireRevision(base, expectedRevision)
      const staged = this.pending.get(sessionId) ?? []
      const projected = project(base, staged)
      if (JSON.stringify(projected) === JSON.stringify(base)) {
        if (options.allowUnchanged) return base
        throw new Error('Mutation did not change State or SubState')
      }
      return this.commit(sessionId, base, projected, staged)
    })
  }

  async registerArtifact(
    sessionId: string,
    expectedRevision: number,
    sourceEvents: string[],
    create: (known: readonly Artifact[]) => Promise<Artifact>,
  ): Promise<{ artifact: Artifact; stateRevision: number }> {
    return this.serial(sessionId, async () => {
      const base = validateWorkspaceSnapshot(await readDurableWorkspace(this.workspaces, sessionId))
      this.requireRevision(base, expectedRevision)
      const staged = this.pending.get(sessionId) ?? []
      const artifact = validateArtifact(await create([...base.artifacts, ...staged.map(item => item.artifact)]))
      if (sourceEvents.length === 0) throw new Error('Artifact source_events must not be empty')
      if ([...base.artifacts, ...staged.map(item => item.artifact)].some(item => item.artifact_id === artifact.artifact_id)) {
        throw new Error(`Artifact already exists: ${artifact.artifact_id}`)
      }
      this.pending.set(sessionId, [...staged, { artifact, source_events: [...sourceEvents] }])
      return { artifact, stateRevision: base.state.revision }
    })
  }

  producedArtifacts(pending: readonly PendingArtifact[], refs: readonly ArtifactRef[], evidence: readonly CriterionEvidence[]): Artifact[] {
    const staged = new Map(pending.map(item => [item.artifact.artifact_id, item]))
    const evidenceEvents = new Set(criterionEvidenceEventIds(evidence))
    for (const ref of refs.filter(item => item.relation === 'used')) {
      if (staged.has(ref.artifact_id)) throw new Error(`Artifact must be produced before use: ${ref.artifact_id}`)
    }
    return refs.filter(item => item.relation === 'produced').map(ref => {
      const item = staged.get(ref.artifact_id)
      if (item === undefined) throw new Error(`Produced Artifact must be registered in this Epoch: ${ref.artifact_id}`)
      const missingEvents = item.source_events.filter(id => !evidenceEvents.has(id))
      if (missingEvents.length > 0) {
        throw new Error(`Produced Artifact evidence must be included in completed.criterion_evidence: ${ref.artifact_id}; missing source_events: ${missingEvents.join(', ')}`)
      }
      return item.artifact
    })
  }

  requireArtifactHandoff(pending: readonly PendingArtifact[], produced: readonly Artifact[], boundary: string): void {
    const producedIds = new Set(produced.map(item => item.artifact_id))
    const missing = pending.filter(item => !producedIds.has(item.artifact.artifact_id))
    if (missing.length > 0) {
      throw new Error(`Every registered Artifact must be referenced as produced by a completed SubStep before ${boundary}; missing: ${missing.map(item => `${item.artifact.artifact_id} (source_events: ${item.source_events.join(', ')})`).join('; ')}`)
    }
  }

  async switchSnapshot(sessionId: string, expectedRevision: number, constraints: readonly DiscoveredConstraintChange[]): Promise<WorkspaceSnapshot> {
    return this.serial(sessionId, async () => {
      const snapshot = validateWorkspaceSnapshot(await readDurableWorkspace(this.workspaces, sessionId))
      this.requireRevision(snapshot, expectedRevision)
      if (snapshot.state.lifecycle.status === 'completed') throw new Error('Context task is already completed')
      this.requireArtifactHandoff(this.pending.get(sessionId) ?? [], [], 'switching Context')
      if (constraints.length === 0) return snapshot
      const state = applyDiscoveredConstraints(snapshot.state, constraints)
      return this.commit(sessionId, snapshot, { ...snapshot, state }, [])
    })
  }

  /** Called under the Session queue; ordinary mutations and switch handoffs share one transaction path. */
  private async commit(sessionId: string, base: WorkspaceSnapshot, projected: WorkspaceSnapshot, staged: readonly PendingArtifact[]): Promise<WorkspaceSnapshot> {
    const target = validateWorkspaceSnapshot({
      ...projected,
      state: { ...projected.state, revision: base.state.revision + 1 },
    })
    const workspace = this.workspaces.forSession(sessionId)
    try {
      await workspace.transition.commit(base, target)
    } catch (error: unknown) {
      // Complete or reject an interrupted transaction before reporting its outcome.
      try {
        await workspace.recover()
        const recovered = await readDurableWorkspace(this.workspaces, sessionId)
        if (JSON.stringify(recovered) !== JSON.stringify(target)) throw error
      } catch {
        throw error
      }
    }
    workspace.state.invalidate()
    const produced = new Set(target.artifacts.map(item => item.artifact_id))
    this.pending.set(sessionId, staged.filter(item => !produced.has(item.artifact.artifact_id)))
    return target
  }

  private requireRevision(snapshot: WorkspaceSnapshot, expected: number | undefined): void {
    if (expected !== undefined && snapshot.state.revision !== expected) {
      throw new Error(`State revision mismatch: expected ${String(expected)}, current ${String(snapshot.state.revision)}`)
    }
  }

  private async serial<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const tail = prior.then(() => next)
    this.queues.set(sessionId, tail)
    await prior
    try {
      return await run()
    } finally {
      release()
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId)
    }
  }
}
