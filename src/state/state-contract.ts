import { requireEventIds, requireExactKeys, requireText, requireTextList } from '../contract-utils.ts'
import {
  createPlannedTaskPlan,
  revisePendingTaskPlan,
  validateTaskPlan,
  type PendingStepPlanDraft,
  type StepPlanDraft,
  type TaskPlan,
} from '../planning/step-plan.ts'

export type { TaskPlan, TaskPlanStep, TaskStatus } from '../planning/step-plan.ts'

export const DISCOVERED_CONSTRAINT_KINDS = [
  'retry_safety',
  'external_contract',
  'environment_limit',
] as const

/** Categories for durable runtime boundaries discovered during work. */
export type DiscoveredConstraintKind = typeof DISCOVERED_CONSTRAINT_KINDS[number]

/** A runtime boundary supported by current-Session evidence. */
export interface DiscoveredConstraint {
  kind: DiscoveredConstraintKind
  condition: string
  required_behavior: string
  source_events: string[]
}

/** The terminal state of the whole Context task. */
export interface ContextLifecycle {
  status: 'active' | 'completed'
}

/** The sole persistent authority for task-level information. */
export interface ContextState {
  schema_version: 1
  revision: number
  mission: string
  task_plan: TaskPlan
  user_constraints: string[]
  discovered_constraints: DiscoveredConstraint[]
  lifecycle: ContextLifecycle
}

/** The State-only input for the first Context Epoch. */
export interface InitializeStateInput {
  mission: string
  task_plan: StepPlanDraft
  user_constraints: string[]
}

/** A State-only plan edit. Current SubStep movement belongs to SubState. */
export interface RevisePendingStepsInput {
  pending_steps: PendingStepPlanDraft[]
}

/** A user requirement may only be appended; existing direct requirements remain authoritative. */
export interface AppendUserConstraintInput {
  constraint: string
}

/** A confirmed runtime boundary supported by current-Session evidence. */
export interface AppendDiscoveredConstraintInput extends DiscoveredConstraint {}

/** Execution modes derived from State, never stored independently. */
export type ExecutionMode = 'working' | 'finalizing' | 'completed'

function validateDiscoveredConstraints(value: unknown): DiscoveredConstraint[] {
  if (!Array.isArray(value)) throw new Error('discovered_constraints must be an array')
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`discovered_constraints[${String(index)}] must be an object`)
    const record = item as Record<string, unknown>
    requireExactKeys(record, `discovered_constraints[${String(index)}]`, ['kind', 'condition', 'required_behavior', 'source_events'])
    if (!DISCOVERED_CONSTRAINT_KINDS.includes(record.kind as DiscoveredConstraintKind)) {
      throw new Error(`discovered_constraints[${String(index)}].kind is invalid`)
    }
    const constraint: DiscoveredConstraint = {
      kind: record.kind as DiscoveredConstraintKind,
      condition: requireText(record.condition, `discovered_constraints[${String(index)}].condition`),
      required_behavior: requireText(record.required_behavior, `discovered_constraints[${String(index)}].required_behavior`),
      source_events: requireEventIds(record.source_events, `discovered_constraints[${String(index)}].source_events`),
    }
    const key = JSON.stringify([constraint.kind, constraint.condition, constraint.required_behavior])
    if (seen.has(key)) throw new Error('discovered_constraints contains duplicate runtime boundaries')
    seen.add(key)
    return constraint
  })
}

function validateLifecycle(value: unknown): ContextLifecycle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('lifecycle must be an object')
  const record = value as Record<string, unknown>
  requireExactKeys(record, 'lifecycle', ['status'])
  const status = record.status
  if (status !== 'active' && status !== 'completed') throw new Error('lifecycle.status must be active or completed')
  return { status }
}

/** Validate one durable State document without reading files or DSH History. */
export function validateContextState(value: unknown): ContextState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Context State must be an object')
  const record = value as Record<string, unknown>
  requireExactKeys(record, 'Context State', ['schema_version', 'revision', 'mission', 'task_plan', 'user_constraints', 'discovered_constraints', 'lifecycle'])
  if (record.schema_version !== 1) throw new Error(`Unsupported Context State schema_version: ${String(record.schema_version)}`)
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) throw new Error('revision must be a positive safe integer')
  const lifecycle = validateLifecycle(record.lifecycle)
  const state: ContextState = {
    schema_version: 1,
    revision: record.revision as number,
    mission: requireText(record.mission, 'mission'),
    task_plan: validateTaskPlan(record.task_plan),
    user_constraints: requireTextList(record.user_constraints, 'user_constraints'),
    discovered_constraints: validateDiscoveredConstraints(record.discovered_constraints),
    lifecycle,
  }
  deriveExecutionMode(state)
  return state
}

/** Allocate IDs and validate the first persistent State document. */
export function createInitialState(input: InitializeStateInput): ContextState {
  return validateContextState({
    schema_version: 1,
    revision: 1,
    mission: input.mission,
    task_plan: createPlannedTaskPlan(input.task_plan),
    user_constraints: input.user_constraints,
    discovered_constraints: [],
    lifecycle: { status: 'active' },
  })
}

/** Derive the valid task execution mode from State alone. */
export function deriveExecutionMode(state: ContextState): ExecutionMode {
  const active = state.task_plan.steps.filter(step => step.status === 'in_progress')
  const unfinished = state.task_plan.steps.filter(step => step.status !== 'done')
  if (state.lifecycle.status === 'completed') {
    if (active.length !== 0 || unfinished.length !== 0) throw new Error('Completed State requires every Step to be done')
    return 'completed'
  }
  if (active.length === 1) return 'working'
  if (active.length === 0 && unfinished.length === 0) return 'finalizing'
  throw new Error('Active State requires exactly one in_progress Step or every Step to be done')
}

/**
 * Revise only pending Steps while preserving every stable ID that already
 * exists. Completion and active-work movement are cross-file operations and
 * therefore intentionally do not live in State-only projection.
 */
export function revisePendingSteps(state: ContextState, input: RevisePendingStepsInput): ContextState {
  const current = validateContextState(state)
  if (deriveExecutionMode(current) !== 'working') {
    throw new Error('Pending Steps can be revised only while exactly one Step is in progress')
  }
  const next = validateContextState({
    ...current,
    task_plan: revisePendingTaskPlan(current.task_plan, input.pending_steps),
  })
  return next
}

/** Append one new direct human requirement without silently removing older requirements. */
export function appendUserConstraint(state: ContextState, input: AppendUserConstraintInput): ContextState {
  const current = validateContextState(state)
  const constraint = requireText(input.constraint, 'constraint')
  if (current.user_constraints.includes(constraint)) throw new Error('user_constraints already contains this requirement')
  return validateContextState({ ...current, user_constraints: [...current.user_constraints, constraint] })
}

/** Append one evidence-backed runtime boundary without changing the durable revision yet. */
export function appendDiscoveredConstraint(state: ContextState, input: AppendDiscoveredConstraintInput): ContextState {
  const current = validateContextState(state)
  return validateContextState({ ...current, discovered_constraints: [...current.discovered_constraints, input] })
}
