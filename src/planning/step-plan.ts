import { requireExactKeys, requireText, requireTextList } from '../contract-utils.ts'
import { nextStepId, parseStepId, type StepId } from '../ids.ts'
import { requireCompleteCoverage, validateIndexedCovers, validatePlanningCriteria } from './planning-core.ts'

export type TaskStatus = 'pending' | 'in_progress' | 'done'

export interface TaskPlanStep {
  step_id: StepId
  step: string
  status: TaskStatus
  covers: number[]
}

export interface TaskPlan {
  completion_criteria: string[]
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

export interface PendingStepPlanDraft extends StepPlanDraftItem {
  step_id?: string
}

function validateStatus(value: unknown, field: string): TaskStatus {
  if (value !== 'pending' && value !== 'in_progress' && value !== 'done') {
    throw new Error(`${field} must be pending, in_progress, or done`)
  }
  return value
}

function validateDraftItem(value: unknown, field: string, criterionCount: number, allowStepId = false): StepPlanDraftItem {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const item = value as Record<string, unknown>
  requireExactKeys(item, field, allowStepId ? ['step_id', 'inputs', 'step', 'result', 'covers'] : ['inputs', 'step', 'result', 'covers'])
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
  requireExactKeys(record, 'task_plan', ['completion_criteria', 'steps'])
  const criteria = validatePlanningCriteria(record.completion_criteria, 'task_plan.completion_criteria')
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
    return {
      step_id: stepId,
      step,
      status: validateStatus(item.status, `${field}.status`),
      covers: validateIndexedCovers(item.covers, criteria.length, `${field}.covers`),
    }
  })
  requireCompleteCoverage(criteria, steps.map(step => step.covers), 'task_plan.completion_criteria')
  return { completion_criteria: criteria, steps }
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
  return validateTaskPlan({ completion_criteria: criteria, steps })
}

/** Replace only Pending Steps while preserving task criteria and protected work. */
export function revisePendingTaskPlan(taskPlan: TaskPlan, pendingDrafts: PendingStepPlanDraft[]): TaskPlan {
  const current = validateTaskPlan(taskPlan)
  if (!Array.isArray(pendingDrafts)) throw new Error('pending_steps must be an array')
  const pendingById = new Map(current.steps.filter(step => step.status === 'pending').map(step => [step.step_id, step]))
  const protectedSteps = current.steps.filter(step => step.status !== 'pending')
  const knownIds = new Set(current.steps.map(step => step.step_id))
  const suppliedIds = new Set<string>()
  const labels = new Set(protectedSteps.map(step => step.step))
  const pending = pendingDrafts.map((value, index): TaskPlanStep => {
    const field = `pending_steps[${String(index)}]`
    const draft = validateDraftItem(value, field, current.completion_criteria.length, true)
    if (labels.has(draft.step)) throw new Error(`pending_steps contains duplicate or protected step: ${draft.step}`)
    labels.add(draft.step)
    if (value.step_id === undefined) {
      const stepId = nextStepId([...knownIds])
      knownIds.add(stepId)
      return { step_id: stepId, step: draft.step, status: 'pending', covers: draft.covers }
    }
    const stepId = parseStepId(value.step_id, `${field}.step_id`)
    if (suppliedIds.has(stepId)) throw new Error(`pending_steps contains duplicate step_id: ${stepId}`)
    suppliedIds.add(stepId)
    if (!pendingById.has(stepId)) throw new Error(`Only pending Step IDs can be revised: ${stepId}`)
    return { step_id: stepId, step: draft.step, status: 'pending', covers: draft.covers }
  })
  const next = validateTaskPlan({ completion_criteria: current.completion_criteria, steps: [...protectedSteps, ...pending] })
  if (JSON.stringify(current.steps) === JSON.stringify(next.steps)) throw new Error('pending_steps must make a substantive task-plan change')
  return next
}
