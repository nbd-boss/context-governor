import { validateArtifact, type Artifact } from '../evidence/artifact-contract.ts'
import { deriveExecutionMode, validateContextState, type ContextState } from '../state/state-contract.ts'
import { validateSubState, type SubState } from '../state/sub-state-contract.ts'

/** The complete durable task snapshot checked before an Epoch boundary commit. */
export interface WorkspaceSnapshot {
  state: ContextState
  sub_states: SubState[]
  artifacts: Artifact[]
}

/** Validate relationships that cannot be checked by any one durable file. */
export function validateWorkspaceSnapshot(value: WorkspaceSnapshot): WorkspaceSnapshot {
  const state = validateContextState(value.state)
  const subStates = value.sub_states.map(validateSubState)
  const artifacts = value.artifacts.map(validateArtifact)
  const steps = new Map(state.task_plan.steps.map(step => [step.step_id, step]))
  const statesByStep = new Map<string, SubState>()
  for (const subState of subStates) {
    if (!steps.has(subState.step_id)) throw new Error(`SubState references unknown step_id: ${subState.step_id}`)
    if (statesByStep.has(subState.step_id)) throw new Error(`Multiple SubStates reference step_id: ${subState.step_id}`)
    statesByStep.set(subState.step_id, subState)
  }
  for (const step of state.task_plan.steps) {
    const subState = statesByStep.get(step.step_id)
    if (step.status === 'pending' && subState !== undefined) throw new Error(`Pending Step must not have SubState: ${step.step_id}`)
    if (step.status !== 'pending' && subState === undefined) throw new Error(`Started Step requires SubState: ${step.step_id}`)
    if (step.status === 'done' && (subState?.current_sub_step !== null || subState.pending_sub_steps.length !== 0)) {
      throw new Error(`Done Step must not have current or pending SubSteps: ${step.step_id}`)
    }
    if (step.status === 'in_progress' && subState?.current_sub_step === null) throw new Error(`In-progress Step requires current_sub_step: ${step.step_id}`)
  }
  const subStepIds = new Set<string>()
  const criterionIds = new Set<string>()
  for (const subState of subStates) {
    for (const criterion of subState.step_completion_criteria) {
      if (criterionIds.has(criterion.criterion_id)) throw new Error(`Workspace contains duplicate criterion_id: ${criterion.criterion_id}`)
      criterionIds.add(criterion.criterion_id)
    }
    for (const subStep of [
      ...subState.completed_sub_steps,
      ...(subState.current_sub_step === null ? [] : [subState.current_sub_step]),
      ...subState.pending_sub_steps,
    ]) {
      if (subStepIds.has(subStep.sub_step_id)) throw new Error(`Workspace contains duplicate sub_step_id: ${subStep.sub_step_id}`)
      subStepIds.add(subStep.sub_step_id)
    }
  }
  const artifactIds = new Set(artifacts.map(artifact => artifact.artifact_id))
  if (artifactIds.size !== artifacts.length) throw new Error('Workspace contains duplicate artifact_id')
  const producers = new Map<string, number>()
  for (const subState of subStates) {
    for (const subStep of subState.completed_sub_steps) {
      for (const reference of subStep.artifact_refs) {
        if (!artifactIds.has(reference.artifact_id)) throw new Error(`Artifact reference does not exist: ${reference.artifact_id}`)
        if (reference.relation === 'produced') producers.set(reference.artifact_id, (producers.get(reference.artifact_id) ?? 0) + 1)
      }
    }
  }
  for (const artifact of artifacts) {
    if (producers.get(artifact.artifact_id) !== 1) throw new Error(`Artifact requires exactly one produced reference: ${artifact.artifact_id}`)
  }
  validateMode(state, statesByStep)
  return { state, sub_states: subStates, artifacts }
}

function validateMode(state: ContextState, statesByStep: ReadonlyMap<string, SubState>): void {
  const mode = deriveExecutionMode(state)
  if (mode === 'working') {
    const active = state.task_plan.steps.filter(step => step.status === 'in_progress')
    if (active.length !== 1 || active[0] === undefined || statesByStep.get(active[0].step_id)?.current_sub_step === null) {
      throw new Error('Working Workspace requires exactly one active SubState')
    }
  }
}
