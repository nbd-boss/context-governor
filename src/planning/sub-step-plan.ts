import { requireText, requireTextList } from '../contract-utils.ts'
import {
  nextCriterionId,
  nextSubStepId,
  parseCriterionId,
  parseStepId,
  parseSubStateId,
  type CriterionId,
  type SubStepId,
} from '../ids.ts'
import { requireCompleteCoverage, validateIndexedCovers, validatePlanningCriteria } from './planning-core.ts'
import { validateSubState, type PendingSubStep, type SubState } from '../state/sub-state-contract.ts'

export interface SubStepPlanDraftItem {
  inputs: string[]
  action: string
  result: string
  completion_criteria: string[]
  covers: number[]
}

export interface SubStepPlanDraft {
  step_completion_criteria: string[]
  sub_steps: SubStepPlanDraftItem[]
}

export interface PendingSubStepDraft {
  inputs: string[]
  action: string
  result: string
  completion_criteria: string[]
  covers: string[]
}

interface PlanningFields {
  inputs: string[]
  action: string
  result: string
  completion_criteria: string[]
}

function validatePlanningFields(item: {
  inputs: unknown
  action: unknown
  result: unknown
  completion_criteria: unknown
}, field: string): PlanningFields {
  const inputs = requireTextList(item.inputs, `${field}.inputs`)
  if (inputs.length === 0) throw new Error(`${field}.inputs must be a non-empty array`)
  const completionCriteria = requireTextList(item.completion_criteria, `${field}.completion_criteria`)
  if (completionCriteria.length === 0) throw new Error(`${field}.completion_criteria must be a non-empty array`)
  return {
    inputs,
    action: requireText(item.action, `${field}.action`),
    result: requireText(item.result, `${field}.result`),
    completion_criteria: completionCriteria,
  }
}

function validatePlanDraft(input: SubStepPlanDraft): SubStepPlanDraft {
  const criteria = validatePlanningCriteria(input.step_completion_criteria, 'step_completion_criteria')
  if (!Array.isArray(input.sub_steps) || input.sub_steps.length === 0) throw new Error('sub_steps must be a non-empty array')
  const subSteps = input.sub_steps.map((item, index) => {
    const field = `sub_steps[${String(index)}]`
    const planning = validatePlanningFields(item, field)
    const covers = validateIndexedCovers(item.covers, criteria.length, `${field}.covers`)
    return { ...planning, covers }
  })
  requireCompleteCoverage(criteria, subSteps.map(item => item.covers), 'step_completion_criteria')
  return { step_completion_criteria: criteria, sub_steps: subSteps }
}

export function createPlannedSubState(input: {
  sub_state_id: string
  step_id: string
  plan: SubStepPlanDraft
  used_criterion_ids: readonly CriterionId[]
  used_sub_step_ids: readonly SubStepId[]
}): SubState {
  const plan = validatePlanDraft(input.plan)
  const criteria: SubState['step_completion_criteria'] = []
  const allocatedCriteria = [...input.used_criterion_ids]
  for (const criterion of plan.step_completion_criteria) {
    const criterionId = nextCriterionId(allocatedCriteria)
    allocatedCriteria.push(criterionId)
    criteria.push({ criterion_id: criterionId, criterion })
  }
  const allocatedSubSteps = [...input.used_sub_step_ids]
  const planned = plan.sub_steps.map(item => {
    const subStepId = nextSubStepId(allocatedSubSteps)
    allocatedSubSteps.push(subStepId)
    return {
      sub_step_id: subStepId,
      action: item.action,
      completion_criteria: item.completion_criteria,
      covers: item.covers.map(index => criteria[index]!.criterion_id),
    }
  })
  const first = planned[0]!
  return validateSubState({
    schema_version: 1,
    sub_state_id: parseSubStateId(input.sub_state_id),
    step_id: parseStepId(input.step_id),
    step_completion_criteria: criteria,
    completed_sub_steps: [],
    current_sub_step: { ...first, continuation: null },
    pending_sub_steps: planned.slice(1),
  })
}

export function createReplacementPendingSubSteps(input: {
  sub_state: SubState
  pending_sub_steps: PendingSubStepDraft[]
  used_sub_step_ids: readonly SubStepId[]
}): PendingSubStep[] {
  const validCriteria = new Set(input.sub_state.step_completion_criteria.map(item => item.criterion_id))
  if (!Array.isArray(input.pending_sub_steps)) throw new Error('pending_sub_steps must be an array')
  const allocated = [...input.used_sub_step_ids]
  return input.pending_sub_steps.map((item, index) => {
    const field = `pending_sub_steps[${String(index)}]`
    const planning = validatePlanningFields(item, field)
    if (!Array.isArray(item.covers) || item.covers.length === 0) throw new Error(`${field}.covers must be a non-empty array`)
    const local = new Set<string>()
    const covers = item.covers.map((value, coverIndex) => {
      const criterionId = parseCriterionId(value, `${field}.covers[${String(coverIndex)}]`)
      if (!validCriteria.has(criterionId)) throw new Error(`${field}.covers references unknown criterion_id: ${criterionId}`)
      if (local.has(criterionId)) throw new Error(`${field}.covers contains duplicate criterion_id: ${criterionId}`)
      local.add(criterionId)
      return criterionId
    })
    const subStepId = nextSubStepId(allocated)
    allocated.push(subStepId)
    return {
      sub_step_id: subStepId,
      action: planning.action,
      completion_criteria: planning.completion_criteria,
      covers,
    }
  })
}
