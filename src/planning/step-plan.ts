import { requireExactKeys, requireText, requireTextList } from '../contract-utils.ts'
import { nextStepId, parseStepId, stepIdAt, type StepId } from '../ids.ts'
import { requireCompleteCoverage, validateIndexedCovers, validatePlanningCriteria } from './planning-core.ts'
import { editPendingItems, readPendingChange, type PendingEdit } from './pending-edit.ts'

export type TaskStatus = 'pending' | 'in_progress' | 'done'

export interface TaskPlanStep {
  step_id: StepId
  step: string
  status: TaskStatus
  covers: number[]
}

export interface TaskPlan {
  next_step_number: number
  completion_criteria: string[]
  superseded_criteria: number[]
  steps: TaskPlanStep[]
}

export interface StepPlanDraftItem {
  inputs: string[]
  step: string
  result: string
  covers: number[]
}

export interface StepPlanDraft {
  completion_criteria: string[]
  steps: StepPlanDraftItem[]
}

export type StepChange =
  | ({ operation: 'add' } & StepPlanDraftItem)
  | ({ operation: 'update'; step_id: string } & StepPlanDraftItem)
  | { operation: 'delete'; step_id: string }

function validateStatus(value: unknown, field: string): TaskStatus {
  if (value !== 'pending' && value !== 'in_progress' && value !== 'done') {
    throw new Error(`${field} must be pending, in_progress, or done`)
  }
  return value
}

function validateDraftItem(value: unknown, field: string, criterionCount: number): StepPlanDraftItem {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const item = value as Record<string, unknown>
  requireExactKeys(item, field, ['inputs', 'step', 'result', 'covers'])
  const inputs = requireTextList(item.inputs, `${field}.inputs`)
  if (inputs.length === 0) throw new Error(`${field}.inputs must be a non-empty array`)
  return {
    inputs,
    step: requireText(item.step, `${field}.step`),
    result: requireText(item.result, `${field}.result`),
    covers: validateIndexedCovers(item.covers, criterionCount, `${field}.covers`),
  }
}

/** Validate the sole persisted Task Plan authority. */
export function validateTaskPlan(value: unknown): TaskPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('task_plan must be an object')
  const record = value as Record<string, unknown>
  requireExactKeys(record, 'task_plan', ['next_step_number', 'completion_criteria', 'superseded_criteria', 'steps'])
  const criteria = validatePlanningCriteria(record.completion_criteria, 'task_plan.completion_criteria')
  if (!Array.isArray(record.superseded_criteria)) throw new Error('task_plan.superseded_criteria must be an array')
  const superseded = record.superseded_criteria.map((item, index) => {
    if (!Number.isSafeInteger(item) || item < 0 || item >= criteria.length) throw new Error(`task_plan.superseded_criteria[${String(index)}] is invalid`)
    return item as number
  })
  if (new Set(superseded).size !== superseded.length) throw new Error('task_plan.superseded_criteria contains duplicates')
  if (superseded.length === criteria.length) throw new Error('task_plan requires at least one active completion criterion')
  if (!Array.isArray(record.steps) || record.steps.length === 0) throw new Error('task_plan.steps must be a non-empty array')
  const ids = new Set<string>()
  const labels = new Set<string>()
  const steps = record.steps.map((value, index) => {
    const field = `task_plan.steps[${String(index)}]`
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
    const item = value as Record<string, unknown>
    requireExactKeys(item, field, ['step_id', 'step', 'status', 'covers'])
    const stepId = parseStepId(item.step_id, `${field}.step_id`)
    if (ids.has(stepId)) throw new Error(`task_plan.steps contains duplicate step_id: ${stepId}`)
    ids.add(stepId)
    const step = requireText(item.step, `${field}.step`)
    if (labels.has(step)) throw new Error(`task_plan.steps contains duplicate step: ${step}`)
    labels.add(step)
    const covers = validateIndexedCovers(item.covers, criteria.length, `${field}.covers`)
    const status = validateStatus(item.status, `${field}.status`)
    if (status === 'pending' && covers.some(cover => superseded.includes(cover))) throw new Error(`${field}.covers cannot claim a superseded criterion`)
    return {
      step_id: stepId,
      step,
      status,
      covers,
    }
  })
  const covered = new Set(steps.flatMap(step => step.covers))
  for (let index = 0; index < criteria.length; index += 1) {
    if (!superseded.includes(index) && !covered.has(index)) throw new Error(`task_plan.completion_criteria[${String(index)}] is not covered by any Step`)
  }
  const nextNumber = record.next_step_number
  if (!Number.isSafeInteger(nextNumber) || (nextNumber as number) < Number(nextStepId(steps.map(step => step.step_id)).slice(5))) {
    throw new Error('task_plan.next_step_number must be a safe integer greater than every allocated Step ID')
  }
  return { next_step_number: nextNumber as number, completion_criteria: criteria, superseded_criteria: superseded, steps }
}

/** Validate an Agent-authored Step plan and allocate its stable identities. */
export function createPlannedTaskPlan(value: StepPlanDraft): TaskPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('task_plan must be an object')
  const record = value as unknown as Record<string, unknown>
  requireExactKeys(record, 'task_plan', ['completion_criteria', 'steps'])
  const criteria = validatePlanningCriteria(record.completion_criteria, 'task_plan.completion_criteria')
  if (!Array.isArray(record.steps) || record.steps.length === 0) throw new Error('task_plan.steps must be a non-empty array')
  const drafts = record.steps.map((item, index) => validateDraftItem(item, `task_plan.steps[${String(index)}]`, criteria.length))
  const labels = new Set<string>()
  const allocated: StepId[] = []
  const steps = drafts.map((item, index): TaskPlanStep => {
    if (labels.has(item.step)) throw new Error(`task_plan.steps contains duplicate step: ${item.step}`)
    labels.add(item.step)
    const stepId = nextStepId(allocated)
    allocated.push(stepId)
    return { step_id: stepId, step: item.step, status: index === 0 ? 'in_progress' : 'pending', covers: item.covers }
  })
  requireCompleteCoverage(criteria, steps.map(step => step.covers), 'task_plan.completion_criteria')
  return validateTaskPlan({ next_step_number: steps.length + 1, completion_criteria: criteria, superseded_criteria: [], steps })
}

/** Apply one edit in memory; callers validate the complete transaction target. */
function applyStepChange(current: TaskPlan, value: StepChange): TaskPlan {
  const change = readPendingChange(value, 'step_id', ['inputs', 'step', 'result', 'covers'])
  const id = change.operation === 'add' ? stepIdAt(current.next_step_number) : parseStepId(change.step_id)
  let edit: PendingEdit<TaskPlanStep>
  if (change.operation === 'delete') edit = { operation: 'delete', id }
  else {
    const draft = validateDraftItem({ inputs: change.inputs, step: change.step, result: change.result, covers: change.covers }, 'change', current.completion_criteria.length)
    edit = { operation: change.operation, id, value: { step_id: id, step: draft.step, status: 'pending', covers: draft.covers } }
  }
  return {
    ...current,
    next_step_number: current.next_step_number + (change.operation === 'add' ? 1 : 0),
    steps: editPendingItems(current.steps, edit, item => item.step_id, item => item.status === 'pending'),
  }
}

/** One public plan edit always returns a fully covered, valid plan. */
export function reviseStep(taskPlan: TaskPlan, change: StepChange): TaskPlan {
  return validateTaskPlan(applyStepChange(validateTaskPlan(taskPlan), change))
}

/** Append new criteria without changing the meaning of any historical covers index. */
export function replanTaskCriteria(taskPlan: TaskPlan, input: {
  supersede: number[]
  add: string[]
  changes: StepChange[]
}): TaskPlan {
  const current = validateTaskPlan(taskPlan)
  if (!Array.isArray(input.supersede) || !Array.isArray(input.add)) throw new Error('supersede and add must be arrays')
  for (const index of input.supersede) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= current.completion_criteria.length || current.superseded_criteria.includes(index)) {
      throw new Error(`Only active criterion indexes can be superseded: ${String(index)}`)
    }
  }
  if (new Set(input.supersede).size !== input.supersede.length) throw new Error('supersede contains duplicate indexes')
  if (input.supersede.length === 0 && input.add.length === 0) throw new Error('Criteria replan must change at least one criterion')
  const added = requireTextList(input.add, 'add')
  const criteria = [...current.completion_criteria, ...added]
  if (new Set(criteria).size !== criteria.length) throw new Error('Task completion criteria must not contain duplicates')
  const nextCriteria = [...current.superseded_criteria, ...input.supersede]
  const seeded = { ...current, completion_criteria: criteria, superseded_criteria: nextCriteria }
  if (!Array.isArray(input.changes)) throw new Error('changes must be an array')
  return validateTaskPlan(input.changes.reduce(applyStepChange, seeded))
}
