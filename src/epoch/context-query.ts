import { parseStepId } from '../ids.ts'
import type { Artifact } from '../evidence/artifact-contract.ts'
import type { ContextState } from '../state/state-contract.ts'
import type { SubState } from '../state/sub-state-contract.ts'
import { validateWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/workspace-validator.ts'

export interface RuntimeSubState extends SubState {
  artifact_catalog: Array<Pick<Artifact, 'artifact_id' | 'contains'>>
}

/** The read-only runtime view shared by resident Context and navigation tools. */
export class ContextQuery {
  constructor(private readonly snapshot: WorkspaceSnapshot) {
    validateWorkspaceSnapshot(snapshot)
  }

  state(): ContextState {
    return this.snapshot.state
  }

  currentSubState(): SubState | undefined {
    const current = this.snapshot.state.task_plan.steps.find(step => step.status === 'in_progress')
    return current === undefined ? undefined : this.snapshot.sub_states.find(subState => subState.step_id === current.step_id)
  }

  subState(stepId: string): SubState | undefined {
    const id = parseStepId(stepId)
    return this.snapshot.sub_states.find(subState => subState.step_id === id)
  }

  /** List each referenced Artifact's summary once per view; references keep only ID and relation. */
  runtimeSubState(stepId: string): RuntimeSubState | undefined {
    const subState = this.subState(stepId)
    if (subState === undefined) return undefined
    const artifacts = new Map(this.snapshot.artifacts.map(artifact => [artifact.artifact_id, artifact]))
    const catalog = new Map<string, Pick<Artifact, 'artifact_id' | 'contains'>>()
    for (const subStep of subState.completed_sub_steps) {
      for (const reference of subStep.artifact_refs) {
        if (catalog.has(reference.artifact_id)) continue
        const artifact = artifacts.get(reference.artifact_id)
        if (artifact === undefined) throw new Error(`Artifact reference does not exist: ${reference.artifact_id}`)
        catalog.set(artifact.artifact_id, { artifact_id: artifact.artifact_id, contains: artifact.contains })
      }
    }
    return {
      ...subState,
      artifact_catalog: [...catalog.values()],
    }
  }

  currentRuntimeSubState(): RuntimeSubState | undefined {
    const current = this.snapshot.state.task_plan.steps.find(step => step.status === 'in_progress')
    return current === undefined ? undefined : this.runtimeSubState(current.step_id)
  }
}
