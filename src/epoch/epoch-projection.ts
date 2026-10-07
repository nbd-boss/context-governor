import { nextSubStateId, parseStepId, type CriterionId, type SubStepId } from '../ids.ts'
import { validateContextState } from '../state/state-contract.ts'
import { createPlannedSubState, createReplacementPendingSubSteps, type PendingSubStepDraft, type SubStepPlanDraft } from '../planning/sub-step-plan.ts'
import { validateSubState, validateSubStepContinuation, type ArtifactRef, type SubState, type SubStepContinuation } from '../state/sub-state-contract.ts'
import type { Artifact } from '../evidence/artifact-contract.ts'
import { validateWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/workspace-validator.ts'

export interface CompletedCurrentSubStepInput {
  summary: string
  source_events: string[]
  artifact_refs: ArtifactRef[]
}

interface CurrentIdentity {
  step_id: string
  expected_sub_step_id: string
  completed: CompletedCurrentSubStepInput
  introduced_artifacts?: Artifact[]
}

export interface AdvanceSubStepInput extends CurrentIdentity {}

export interface AdvanceStepInput extends CurrentIdentity {
  next_step: { step_id: string; plan: SubStepPlanDraft } | null
}

export interface ReplacePendingSubStepPlanInput {
  step_id: string
  expected_current_sub_step_id: string
  pending_sub_steps: PendingSubStepDraft[]
}

export type RecordContinuationInput = SubStepContinuation

function usedSubStepIds(snapshot: WorkspaceSnapshot): SubStepId[] {
  return snapshot.sub_states.flatMap(subState => [
    ...subState.completed_sub_steps.map(item => item.sub_step_id),
    ...(subState.current_sub_step === null ? [] : [subState.current_sub_step.sub_step_id]),
    ...subState.pending_sub_steps.map(item => item.sub_step_id),
  ])
}

function usedCriterionIds(snapshot: WorkspaceSnapshot): CriterionId[] {
  return snapshot.sub_states.flatMap(subState => subState.step_completion_criteria.map(item => item.criterion_id))
}

function activeSubState(snapshot: WorkspaceSnapshot, stepId: string, expectedSubStepId: string): SubState {
  const parsedStepId = parseStepId(stepId, 'step_id')
  const active = snapshot.state.task_plan.steps.find(item => item.status === 'in_progress')
  if (active?.step_id !== parsedStepId) throw new Error('step_id must identify the active Step')
  const subState = snapshot.sub_states.find(item => item.step_id === parsedStepId)
  if (subState === undefined) throw new Error(`No SubState exists for step_id: ${parsedStepId}`)
  if (subState.current_sub_step === null) throw new Error(`SubState has no current SubStep: ${parsedStepId}`)
  if (subState.current_sub_step.sub_step_id !== expectedSubStepId) {
    throw new Error(`expected_sub_step_id does not match the current SubStep: ${expectedSubStepId}`)
  }
  return subState
}

function completeCurrent(subState: SubState, completed: CompletedCurrentSubStepInput): SubState['completed_sub_steps'][number] {
  const current = subState.current_sub_step
  if (current === null) throw new Error(`SubState has no current SubStep: ${subState.step_id}`)
  return {
    sub_step_id: current.sub_step_id,
    action: current.action,
    completion_criteria: current.completion_criteria,
    covers: current.covers,
    summary: completed.summary,
    source_events: completed.source_events,
    artifact_refs: completed.artifact_refs,
  }
}

function replaceSubState(snapshot: WorkspaceSnapshot, next: SubState): WorkspaceSnapshot {
  return {
    ...snapshot,
    sub_states: snapshot.sub_states.map(subState => subState.sub_state_id === next.sub_state_id ? next : subState),
  }
}

function plannedSubState(snapshot: WorkspaceSnapshot, stepId: string, plan: SubStepPlanDraft): SubState {
  return createPlannedSubState({
    sub_state_id: nextSubStateId(snapshot.sub_states.map(item => item.sub_state_id)),
    step_id: stepId,
    plan,
    used_criterion_ids: usedCriterionIds(snapshot),
    used_sub_step_ids: usedSubStepIds(snapshot),
  })
}

export function recordContinuation(snapshot: WorkspaceSnapshot, input: RecordContinuationInput): WorkspaceSnapshot {
  const current = validateWorkspaceSnapshot(snapshot)
  const activeStep = current.state.task_plan.steps.find(step => step.status === 'in_progress')
  if (activeStep === undefined) throw new Error('Continuation requires one active Step')
  const subState = current.sub_states.find(item => item.step_id === activeStep.step_id)
  if (subState?.current_sub_step === null || subState?.current_sub_step === undefined) {
    throw new Error('Continuation requires one current SubStep')
  }
  return validateWorkspaceSnapshot(replaceSubState(current, validateSubState({
    ...subState,
    current_sub_step: {
      ...subState.current_sub_step,
      continuation: validateSubStepContinuation(input),
    },
  })))
}

export function advanceSubStep(snapshot: WorkspaceSnapshot, input: AdvanceSubStepInput): WorkspaceSnapshot {
  const current = validateWorkspaceSnapshot(snapshot)
  const subState = activeSubState(current, input.step_id, input.expected_sub_step_id)
  const [next, ...remaining] = subState.pending_sub_steps
  if (next === undefined) throw new Error('advance_sub_step requires at least one pending SubStep; use advance_step at the Step boundary')
  const completed = completeCurrent(subState, input.completed)
  const projected = validateSubState({
    ...subState,
    completed_sub_steps: [...subState.completed_sub_steps, completed],
    current_sub_step: { ...next, continuation: null },
    pending_sub_steps: remaining,
  })
  return validateWorkspaceSnapshot({
    ...replaceSubState(current, projected),
    artifacts: [...current.artifacts, ...(input.introduced_artifacts ?? [])],
  })
}

export function advanceStep(snapshot: WorkspaceSnapshot, input: AdvanceStepInput): WorkspaceSnapshot {
  const current = validateWorkspaceSnapshot(snapshot)
  const currentState = validateContextState(current.state)
  const active = currentState.task_plan.steps.find(step => step.status === 'in_progress')
  if (active === undefined || active.step_id !== input.step_id) throw new Error('step_id must identify the active Step')
  const activeState = activeSubState(current, input.step_id, input.expected_sub_step_id)
  if (activeState.pending_sub_steps.length !== 0) throw new Error('advance_step requires pending_sub_steps to be empty; finish the planned SubSteps first')
  const completedState = validateSubState({
    ...activeState,
    completed_sub_steps: [...activeState.completed_sub_steps, completeCurrent(activeState, input.completed)],
    current_sub_step: null,
  })
  const doneSteps = currentState.task_plan.steps.map(step => step.step_id === active.step_id ? { ...step, status: 'done' as const } : step)
  const artifacts = [...current.artifacts, ...(input.introduced_artifacts ?? [])]
  const subStates = current.sub_states.map(subState => subState.sub_state_id === completedState.sub_state_id ? completedState : subState)

  if (input.next_step === null) {
    if (doneSteps.some(step => step.status === 'pending')) throw new Error('next_step is required while pending Steps remain')
    return validateWorkspaceSnapshot({
      ...current,
      artifacts,
      state: validateContextState({ ...currentState, task_plan: { ...currentState.task_plan, steps: doneSteps } }),
      sub_states: subStates,
    })
  }

  const nextStepId = parseStepId(input.next_step.step_id, 'next_step.step_id')
  const nextStep = doneSteps.find(step => step.step_id === nextStepId)
  if (nextStep?.status !== 'pending') throw new Error('next_step.step_id must identify a pending Step')
  const startedSteps = doneSteps.map(step => step.step_id === nextStepId ? { ...step, status: 'in_progress' as const } : step)
  const startedState = validateContextState({ ...currentState, task_plan: { ...currentState.task_plan, steps: startedSteps } })
  const baseForAllocation: WorkspaceSnapshot = { state: startedState, sub_states: subStates, artifacts }
  const nextSubState = plannedSubState(baseForAllocation, nextStepId, input.next_step.plan)
  return validateWorkspaceSnapshot({
    state: startedState,
    artifacts,
    sub_states: [...subStates, nextSubState],
  })
}

export function replacePendingSubStepPlan(snapshot: WorkspaceSnapshot, input: ReplacePendingSubStepPlanInput): WorkspaceSnapshot {
  const current = validateWorkspaceSnapshot(snapshot)
  const subState = activeSubState(current, input.step_id, input.expected_current_sub_step_id)
  const pending = createReplacementPendingSubSteps({
    sub_state: subState,
    pending_sub_steps: input.pending_sub_steps,
    used_sub_step_ids: usedSubStepIds(current),
  })
  const before = subState.pending_sub_steps.map(item => ({ action: item.action, completion_criteria: item.completion_criteria, covers: item.covers }))
  const after = pending.map(item => ({ action: item.action, completion_criteria: item.completion_criteria, covers: item.covers }))
  if (JSON.stringify(before) === JSON.stringify(after)) throw new Error('pending_sub_steps must make a substantive plan change')
  const projected = validateSubState({ ...subState, pending_sub_steps: pending })
  return validateWorkspaceSnapshot(replaceSubState(current, projected))
}

export function stampBoundaryRevision(baseState: WorkspaceSnapshot['state'], projected: WorkspaceSnapshot): WorkspaceSnapshot {
  const base = validateContextState(baseState)
  const checked = validateWorkspaceSnapshot(projected)
  return validateWorkspaceSnapshot({
    ...checked,
    state: validateContextState({ ...checked.state, revision: base.revision + 1 }),
  })
}
