import { parseStepId, type StepId } from '../ids.ts'
import { deriveExecutionMode, type ContextState } from '../state/state-contract.ts'
import { type ArtifactRef, type SubState } from '../state/sub-state-contract.ts'
import { validateWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/workspace-validator.ts'

export interface GlobalStepNavigation {
  step_id: StepId
  step: string
  status: 'done'
}

export interface RuntimeArtifactRef extends ArtifactRef {
  contains: {
    kind: string
    summary: string
    coverage: string
    key_facts: string[]
    available_fields: string[]
  }
}

export interface RuntimeSubState extends Omit<SubState, 'completed_sub_steps'> {
  completed_sub_steps: Array<Omit<SubState['completed_sub_steps'][number], 'artifact_refs'> & { artifact_refs: RuntimeArtifactRef[] }>
}

/** The read-only runtime view shared by resident Context and navigation tools. */
export class ContextQuery {
  constructor(private readonly snapshot: WorkspaceSnapshot) {
    validateWorkspaceSnapshot(snapshot)
  }

  state(): ContextState {
    return this.snapshot.state
  }

  /** Done work is navigation only; detailed conclusions stay in each SubState. */
  globalNavigation(): GlobalStepNavigation[] {
    const state = this.snapshot.state
    const mode = deriveExecutionMode(state)
    return state.task_plan.steps
      .filter(step => step.status === 'done' && (mode === 'working' || mode === 'finalizing' || mode === 'completed'))
      .map(step => ({ step_id: step.step_id, step: step.step, status: 'done' }))
  }

  currentSubState(): SubState | undefined {
    const current = this.snapshot.state.task_plan.steps.find(step => step.status === 'in_progress')
    return current === undefined ? undefined : this.snapshot.sub_states.find(subState => subState.step_id === current.step_id)
  }

  subState(stepId: string): SubState | undefined {
    const id = parseStepId(stepId)
    return this.snapshot.sub_states.find(subState => subState.step_id === id)
  }

  /** Expand only the lightweight Artifact contains data, never Resource paths or hashes. */
  runtimeSubState(stepId: string): RuntimeSubState | undefined {
    const subState = this.subState(stepId)
    if (subState === undefined) return undefined
    const artifacts = new Map(this.snapshot.artifacts.map(artifact => [artifact.artifact_id, artifact]))
    return {
      ...subState,
      completed_sub_steps: subState.completed_sub_steps.map(subStep => ({
        ...subStep,
        artifact_refs: subStep.artifact_refs.map(reference => {
          const artifact = artifacts.get(reference.artifact_id)
          if (artifact === undefined) throw new Error(`Artifact reference does not exist: ${reference.artifact_id}`)
          return { ...reference, contains: artifact.contains }
        }),
      })),
    }
  }

  currentRuntimeSubState(): RuntimeSubState | undefined {
    const current = this.snapshot.state.task_plan.steps.find(step => step.status === 'in_progress')
    return current === undefined ? undefined : this.runtimeSubState(current.step_id)
  }
}
