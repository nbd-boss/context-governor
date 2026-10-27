import { nextCriterionId, parseCriterionId, parseStepId, subStepIdAt, type CriterionId, type SubStepId } from '../ids.ts'
import { validateContextState } from '../state/state-contract.ts'
import { createPlannedSubState, applySubStepChange, type SubStepChange, type SubStepPlanDraft, type SubStepPlanDraftItem } from '../planning/sub-step-plan.ts'
import { validateSubState, validateSubStepContinuation, type ArtifactRef, type CriterionEvidence, type SubState, type SubStepContinuation } from '../state/sub-state-contract.ts'
import type { Artifact } from '../evidence/artifact-contract.ts'
import { validateWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/workspace-validator.ts'

export interface CompletedCurrentSubStepInput {
  summary: string
  criterion_evidence: CriterionEvidence[]
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
  next_step: { step_id: string } | null
}

export interface PlanCurrentStepInput {
  step_id: string
  plan: SubStepPlanDraft
}

export interface ReviseSubStepInput {
  step_id: string
  expected_current_sub_step_id: string
  change: SubStepChange
}

export interface ReplanStepCriteriaInput {
  step_id: string
  expected_current_sub_step_id: string
  supersede: string[]
  add: string[]
  changes: Array<
    | { operation: 'delete'; sub_step_id: string }
    | ({ operation: 'add' } & SubStepPlanDraftItem)
    | ({ operation: 'update'; sub_step_id: string } & SubStepPlanDraftItem)
  >
}

export type RecordContinuationInput = SubStepContinuation

function usedSubStepIds(snapshot: WorkspaceSnapshot): SubStepId[] {
  return snapshot.sub_states.flatMap(subState => [
    subStepIdAt(subState.next_sub_step_number - 1),
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
    covers: current.covers,
    summary: completed.summary,
    criterion_evidence: completed.criterion_evidence,
    artifact_refs: completed.artifact_refs,
  }
}

function replaceSubState(snapshot: WorkspaceSnapshot, next: SubState): WorkspaceSnapshot {
  return {
    ...snapshot,
    sub_states: snapshot.sub_states.map(subState => subState.step_id === next.step_id ? next : subState),
  }
}

function plannedSubState(snapshot: WorkspaceSnapshot, stepId: string, plan: SubStepPlanDraft): SubState {
  return createPlannedSubState({
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
  if (next === undefined) throw new Error('advance_sub_step requires at least one pending SubStep. Before choosing advance_step or complete_task at this boundary, apply context_governor.decision_checks.before_completion; if the promised result remains unmet, keep the Step active, preserve partial progress, and report the blocker.')
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
  const subStates = current.sub_states.map(subState => subState.step_id === completedState.step_id ? completedState : subState)

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
  return validateWorkspaceSnapshot({
    state: startedState,
    artifacts,
    sub_states: subStates,
  })
}

export function planCurrentStep(snapshot: WorkspaceSnapshot, input: PlanCurrentStepInput): WorkspaceSnapshot {
  const current = validateWorkspaceSnapshot(snapshot)
  const stepId = parseStepId(input.step_id, 'step_id')
  const active = current.state.task_plan.steps.find(step => step.status === 'in_progress')
  if (active?.step_id !== stepId) throw new Error('step_id must identify the active Step')
  if (current.sub_states.some(subState => subState.step_id === stepId)) {
    throw new Error(`The active Step already has a SubState: ${stepId}`)
  }
  return validateWorkspaceSnapshot({
    ...current,
    sub_states: [...current.sub_states, plannedSubState(current, stepId, input.plan)],
  })
}

export function reviseSubStep(snapshot: WorkspaceSnapshot, input: ReviseSubStepInput): WorkspaceSnapshot {
  const current = validateWorkspaceSnapshot(snapshot)
  const subState = activeSubState(current, input.step_id, input.expected_current_sub_step_id)
  const projected = validateSubState(applySubStepChange(subState, input.change, usedSubStepIds(current)))
  return validateWorkspaceSnapshot(replaceSubState(current, projected))
}
/** Keep historical criterion IDs and completed work intact while replacing only pending work. */
export function replanStepCriteria(snapshot: WorkspaceSnapshot, input: ReplanStepCriteriaInput): WorkspaceSnapshot {
  const current = validateWorkspaceSnapshot(snapshot)
  const subState = activeSubState(current, input.step_id, input.expected_current_sub_step_id)
  if (!Array.isArray(input.supersede) || !Array.isArray(input.add)) throw new Error('supersede and add must be arrays')
  const existing = new Set(subState.step_completion_criteria.map(item => item.criterion_id))
  const supersede = input.supersede.map((value, index) => {
    const id = parseCriterionId(value, `supersede[${String(index)}]`)
    if (!existing.has(id) || subState.superseded_criterion_ids.includes(id)) throw new Error(`Only active criteria can be superseded: ${id}`)
    return id
  })
  if (new Set(supersede).size !== supersede.length) throw new Error('supersede contains duplicate criterion IDs')
  if (supersede.length === 0 && input.add.length === 0) throw new Error('Criteria replan must change at least one criterion')
  const allocated = [...usedCriterionIds(current)]
  const additions = input.add.map((criterion, index) => {
    if (typeof criterion !== 'string' || criterion.trim() === '') throw new Error(`add[${String(index)}] must be non-empty text`)
    const criterion_id = nextCriterionId(allocated)
    allocated.push(criterion_id)
    return { criterion_id, criterion: criterion.trim() }
  })
  const criteria = [...subState.step_completion_criteria, ...additions]
  if (new Set(criteria.map(item => item.criterion)).size !== criteria.length) throw new Error('step_completion_criteria contains duplicate text')
  const retired = [...subState.superseded_criterion_ids, ...supersede]
  if (!Array.isArray(input.changes)) throw new Error('changes must be an array')
  const drafts = input.changes.map((item, index): SubStepChange => {
    if (item.operation === 'delete') return item
    if (!Array.isArray(item.covers) || item.covers.length === 0) throw new Error(`changes[${String(index)}].covers_criterion_indexes must be non-empty`)
    return {
      ...item,
      covers: item.covers.map(cover => {
        if (!Number.isSafeInteger(cover) || cover < 0 || cover >= criteria.length) throw new Error(`changes[${String(index)}].covers_criterion_indexes contains invalid index`)
        const id = criteria[cover]!.criterion_id
        if (retired.includes(id)) throw new Error(`changes[${String(index)}] cannot cover a superseded criterion`)
        return id
      }),
    } as SubStepChange
  })
  const seeded = {
    ...subState,
    step_completion_criteria: criteria,
    superseded_criterion_ids: retired,
  }
  const projected = validateSubState(drafts.reduce((base, change) => applySubStepChange(base, change, usedSubStepIds(current)), seeded))
  return validateWorkspaceSnapshot(replaceSubState(current, projected))
}
