import { requireText, requireTextList } from '../contract-utils.ts'
import {
  nextCriterionId,
  nextSubStepId,
  parseCriterionId,
  parseStepId,
  subStepIdAt,
  validateSubStepId,
  type CriterionId,
  type SubStepId,
} from '../ids.ts'
import { requireCompleteCoverage, validateIndexedCovers, validatePlanningCriteria } from './planning-core.ts'
import { validateSubState, type PendingSubStep, type SubState } from '../state/sub-state-contract.ts'
import { editPendingItems, readPendingChange, type PendingEdit } from './pending-edit.ts'

export interface SubStepPlanDraftItem {
  inputs: string[]
  action: string
  result: string
  covers: number[]
}

export interface SubStepPlanDraft {
  step_completion_criteria: string[]
  sub_steps: SubStepPlanDraftItem[]
}

interface SubStepDraft {
  inputs: string[]
  action: string
  result: string
  covers: string[]
}

export type SubStepChange =
  | ({ operation: 'add' } & SubStepDraft)
  | ({ operation: 'update'; sub_step_id: string } & SubStepDraft)
  | { operation: 'delete'; sub_step_id: string }

interface PlanningFields {
  inputs: string[]
  action: string
  result: string
}

function validatePlanningFields(item: {
  inputs: unknown
  action: unknown
  result: unknown
}, field: string): PlanningFields {
  const inputs = requireTextList(item.inputs, `${field}.inputs`)
  if (inputs.length === 0) throw new Error(`${field}.inputs must be a non-empty array`)
  return {
    inputs,
    action: requireText(item.action, `${field}.action`),
    result: requireText(item.result, `${field}.result`),
  }
}

function validatePlanDraft(input: SubStepPlanDraft): SubStepPlanDraft {
  const criteria = validatePlanningCriteria(input.step_completion_criteria, 'step_completion_criteria')
  if (!Array.isArray(input.sub_steps) || input.sub_steps.length === 0) throw new Error('sub_steps must be a non-empty array')
  const subSteps = input.sub_steps.map((item, index) => {
    const field = `sub_steps[${String(index)}]`
    const planning = validatePlanningFields(item, field)
    const covers = validateIndexedCovers(item.covers, criteria.length, `${field}.covers_criterion_indexes`)
    return { ...planning, covers }
  })
  requireCompleteCoverage(criteria, subSteps.map(item => item.covers), 'step_completion_criteria')
  return { step_completion_criteria: criteria, sub_steps: subSteps }
}

export function createPlannedSubState(input: {
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
      covers: item.covers.map(index => criteria[index]!.criterion_id),
    }
  })
  const first = planned[0]!
  return validateSubState({
    schema_version: 1,
    step_id: parseStepId(input.step_id),
    next_sub_step_number: Number(nextSubStepId(allocatedSubSteps).slice(9)),
    step_completion_criteria: criteria,
    superseded_criterion_ids: [],
    completed_sub_steps: [],
    current_sub_step: { ...first, continuation: null },
    pending_sub_steps: planned.slice(1),
  })
}

/** Shared by ordinary edits and criteria replans; the final snapshot owns coverage validation. */
export function applySubStepChange(subState: SubState, value: SubStepChange, usedIds: readonly SubStepId[]): SubState {
  const change = readPendingChange(value, 'sub_step_id', ['inputs', 'action', 'result', 'covers'])
  const validCriteria = new Set(subState.step_completion_criteria.map(item => item.criterion_id))
  const id = change.operation === 'add'
    ? nextSubStepId([...usedIds, subStepIdAt(subState.next_sub_step_number - 1)])
    : validateSubStepId(change.sub_step_id)
  let edit: PendingEdit<PendingSubStep>
  if (change.operation === 'delete') edit = { operation: 'delete', id }
  else {
    const planning = validatePlanningFields({ inputs: change.inputs, action: change.action, result: change.result }, 'change')
    if (!Array.isArray(change.covers) || change.covers.length === 0) throw new Error('change.covers must be a non-empty array')
    const local = new Set<string>()
    const covers = change.covers.map((value, index) => {
      const criterionId = parseCriterionId(value, `change.covers[${String(index)}]`)
      if (!validCriteria.has(criterionId)) throw new Error(`change.covers references unknown criterion_id: ${criterionId}`)
      if (local.has(criterionId)) throw new Error(`change.covers contains duplicate criterion_id: ${criterionId}`)
      local.add(criterionId)
      return criterionId
    })
    edit = { operation: change.operation, id, value: { sub_step_id: id, action: planning.action, covers } }
  }
  return {
    ...subState,
    next_sub_step_number: change.operation === 'add' ? Number(id.slice(9)) + 1 : subState.next_sub_step_number,
    pending_sub_steps: editPendingItems(subState.pending_sub_steps, edit, item => item.sub_step_id, () => true),
  }
}
