import { validateArtifact, type Artifact } from '../evidence/artifact-contract.ts'
import {
  advanceStep,
  advanceSubStep,
  recordContinuation,
  replacePendingSubStepPlan,
  type AdvanceStepInput,
  type AdvanceSubStepInput,
  type RecordContinuationInput,
  type ReplacePendingSubStepPlanInput,
} from './epoch-projection.ts'
import {
  appendDiscoveredConstraint,
  appendUserConstraint,
  revisePendingSteps,
  type AppendDiscoveredConstraintInput,
  type AppendUserConstraintInput,
  type RevisePendingStepsInput,
} from '../state/state-contract.ts'
import { validateWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/workspace-validator.ts'

export interface PendingArtifact {
  artifact: Artifact
  source_events: string[]
}

export interface EpochDeltaSnapshot {
  base: WorkspaceSnapshot
  projected: WorkspaceSnapshot
  revision: number
  reasons: string[]
  pending_artifacts: PendingArtifact[]
}

interface Buffer extends EpochDeltaSnapshot {}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Ordered in-memory Workspace projections. It has no filesystem dependency. */
export class EpochDeltaBuffer {
  private readonly buffers = new Map<string, Buffer>()

  snapshot(sessionId: string, durable: WorkspaceSnapshot): EpochDeltaSnapshot {
    const checked = validateWorkspaceSnapshot(durable)
    const existing = this.buffers.get(sessionId)
    if (existing === undefined) return { base: clone(checked), projected: clone(checked), revision: 0, reasons: [], pending_artifacts: [] }
    if (!sameValue(existing.base, checked)) throw new Error('Persistent Workspace changed during this Epoch; start a new Context before recording another Delta.')
    return clone(existing)
  }

  recordSubStep(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    operation: AdvanceSubStepInput
  }): EpochDeltaSnapshot {
    return this.record(input, advanceSubStep)
  }

  recordStep(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    operation: AdvanceStepInput
  }): EpochDeltaSnapshot {
    return this.record(input, advanceStep)
  }

  recordPlanRevision(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    operation: RevisePendingStepsInput
  }): EpochDeltaSnapshot {
    return this.recordState(input, state => revisePendingSteps(state, input.operation))
  }

  recordUserConstraint(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    operation: AppendUserConstraintInput
  }): EpochDeltaSnapshot {
    return this.recordState(input, state => appendUserConstraint(state, input.operation))
  }

  recordDiscoveredConstraint(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    operation: AppendDiscoveredConstraintInput
  }): EpochDeltaSnapshot {
    return this.recordState(input, state => appendDiscoveredConstraint(state, input.operation))
  }

  recordPendingSubStepPlan(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    operation: ReplacePendingSubStepPlanInput
  }): EpochDeltaSnapshot {
    return this.recordWorkspace(input, replacePendingSubStepPlan)
  }

  /** Replace the current SubStep's unfinished-work navigation in memory. */
  recordContinuation(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    operation: RecordContinuationInput
  }): EpochDeltaSnapshot {
    const revision = this.snapshot(input.sessionId, input.durable).revision
    const buffer = this.writableBuffer({
      ...input,
      expectedRevision: revision,
      reason: 'Updated current SubStep continuation.',
    }, 'Continuation')
    buffer.projected = recordContinuation(buffer.projected, input.operation)
    buffer.revision += 1
    buffer.reasons.push('Updated current SubStep continuation.')
    return clone(buffer)
  }

  /** Keep a verified Artifact in this Epoch until a producer SubStep claims it. */
  recordArtifact(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    artifact: Artifact
    source_events: string[]
  }): EpochDeltaSnapshot {
    const buffer = this.writableBuffer(input, 'Artifact')
    const artifact = validateArtifact(input.artifact)
    const known = new Set([
      ...buffer.projected.artifacts.map(item => item.artifact_id),
      ...buffer.pending_artifacts.map(item => item.artifact.artifact_id),
    ])
    if (known.has(artifact.artifact_id)) throw new Error(`Artifact already exists in this Epoch: ${artifact.artifact_id}`)
    if (input.source_events.length === 0) throw new Error('Artifact source_events must not be empty')
    buffer.pending_artifacts.push({ artifact, source_events: [...input.source_events] })
    buffer.revision += 1
    buffer.reasons.push(input.reason.trim())
    return clone(buffer)
  }

  clear(sessionId: string): void {
    this.buffers.delete(sessionId)
  }

  private record<T extends AdvanceSubStepInput>(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    operation: T
  }, apply: (snapshot: WorkspaceSnapshot, operation: T) => WorkspaceSnapshot): EpochDeltaSnapshot {
    const buffer = this.writableBuffer(input, 'Delta')
    const introduced = this.producedArtifacts(buffer, input.operation)
    buffer.projected = apply(buffer.projected, { ...input.operation, introduced_artifacts: introduced.map(item => item.artifact) })
    if (introduced.length > 0) {
      const ids = new Set(introduced.map(item => item.artifact.artifact_id))
      buffer.pending_artifacts = buffer.pending_artifacts.filter(item => !ids.has(item.artifact.artifact_id))
    }
    buffer.revision += 1
    buffer.reasons.push(input.reason.trim())
    return clone(buffer)
  }

  private recordState<T>(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    operation: T
  }, apply: (state: WorkspaceSnapshot['state']) => WorkspaceSnapshot['state']): EpochDeltaSnapshot {
    const buffer = this.writableBuffer(input, 'State Delta')
    buffer.projected = validateWorkspaceSnapshot({ ...buffer.projected, state: apply(buffer.projected.state) })
    buffer.revision += 1
    buffer.reasons.push(input.reason.trim())
    return clone(buffer)
  }

  private recordWorkspace<T>(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
    operation: T
  }, apply: (snapshot: WorkspaceSnapshot, operation: T) => WorkspaceSnapshot): EpochDeltaSnapshot {
    const buffer = this.writableBuffer(input, 'Workspace Delta')
    buffer.projected = apply(buffer.projected, input.operation)
    buffer.revision += 1
    buffer.reasons.push(input.reason.trim())
    return clone(buffer)
  }

  private writableBuffer(input: {
    sessionId: string
    durable: WorkspaceSnapshot
    expectedRevision: number
    reason: string
  }, label: string): Buffer {
    if (typeof input.reason !== 'string' || input.reason.trim() === '') throw new Error(`${label} reason must be a non-empty string`)
    const durable = validateWorkspaceSnapshot(input.durable)
    let buffer = this.buffers.get(input.sessionId)
    if (buffer === undefined) {
      buffer = { base: clone(durable), projected: clone(durable), revision: 0, reasons: [], pending_artifacts: [] }
      this.buffers.set(input.sessionId, buffer)
    } else if (!sameValue(buffer.base, durable)) {
      throw new Error('Persistent Workspace changed during this Epoch; start a new Context before recording another Delta.')
    }
    if (input.expectedRevision !== buffer.revision) {
      throw new Error(`epoch revision mismatch: expected ${String(input.expectedRevision)}, current ${String(buffer.revision)}`)
    }
    return buffer
  }

  private producedArtifacts(buffer: Buffer, operation: AdvanceSubStepInput): PendingArtifact[] {
    const references = operation.completed.artifact_refs
    const pending = new Map(buffer.pending_artifacts.map(item => [item.artifact.artifact_id, item]))
    for (const reference of references.filter(item => item.relation === 'used')) {
      if (pending.has(reference.artifact_id)) {
        throw new Error(`Artifact must be produced before another SubStep can use it: ${reference.artifact_id}`)
      }
    }
    const produced = references.filter(item => item.relation === 'produced').map(reference => {
      const artifact = pending.get(reference.artifact_id)
      if (artifact === undefined) throw new Error(`Produced Artifact must be registered in this Epoch: ${reference.artifact_id}`)
      if (artifact.source_events.some(id => !operation.completed.source_events.includes(id))) {
        throw new Error(`Produced Artifact evidence must be included in completed.source_events: ${reference.artifact_id}`)
      }
      return artifact
    })
    return produced
  }
}
