import { createPlannedSubState, type SubStepPlanDraft } from '../src/planning/sub-step-plan.ts'
import type { CriterionId, SubStepId } from '../src/ids.ts'
import type { StepPlanDraft } from '../src/planning/step-plan.ts'
import { createInitialState, type DiscoveredConstraintChange, type InitializeStateInput } from '../src/state/state-contract.ts'
import { constraintIdAt } from '../src/ids.ts'
import type { SubState } from '../src/state/sub-state-contract.ts'
import type { SessionWorkspace } from '../src/workspace/session-workspace.ts'

/** Seed test data through the same transaction writer used by production. */
export async function initializeWorkspace(workspace: SessionWorkspace, input: InitializeStateInput, subStates: SubState[] = []) {
  const state = createInitialState(input)
  await workspace.transition.initialize({ state, sub_states: subStates, artifacts: [] })
  workspace.state.invalidate()
  return state
}

/** Expected durable shape: command-only replacement references are not stored in active records. */
export function storedConstraints(changes: readonly DiscoveredConstraintChange[], first = 1) {
  return changes.map(({ replaces: _replaces, ...facts }, index) => ({ constraint_id: constraintIdAt(first + index), ...facts }))
}

type TestPlanDraft = Omit<SubStepPlanDraft, 'sub_steps'> & {
  sub_steps: Array<Omit<SubStepPlanDraft['sub_steps'][number], 'inputs' | 'result'> & {
    inputs?: string[]
    result?: string
  }>
}

export const DEFAULT_PLAN: SubStepPlanDraft = {
  step_completion_criteria: ['The Step result is verified.'],
  sub_steps: [{
    inputs: ['The Step inputs.'],
    action: 'Complete the Step result.',
    result: 'The verified Step result.',
    covers: [0],
  }],
}

/** Concise tests still exercise the complete production Step-planning contract. */
export function plannedTaskPlan(...steps: string[]): StepPlanDraft {
  return {
    completion_criteria: steps.map(step => `${step} is complete.`),
    steps: steps.map((step, index) => ({
      inputs: [`Inputs for: ${step}`],
      step,
      result: `Verified result of: ${step}`,
      covers: [index],
    })),
  }
}

export function plannedSubState(input: {
  step_id?: string
  plan?: TestPlanDraft
  used_criterion_ids?: CriterionId[]
  used_sub_step_ids?: SubStepId[]
} = {}) {
  const source = input.plan ?? DEFAULT_PLAN
  const plan: SubStepPlanDraft = {
    ...source,
    sub_steps: source.sub_steps.map(item => ({
      ...item,
      inputs: item.inputs ?? [`Input for: ${item.action}`],
      result: item.result ?? `Result of: ${item.action}`,
    })),
  }
  return createPlannedSubState({
    step_id: input.step_id ?? 'step-000001',
    plan,
    used_criterion_ids: input.used_criterion_ids ?? [],
    used_sub_step_ids: input.used_sub_step_ids ?? [],
  })
}
