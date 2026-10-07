import { createPlannedSubState, type SubStepPlanDraft } from '../src/planning/sub-step-plan.ts'
import type { CriterionId, SubStepId } from '../src/ids.ts'
import type { StepPlanDraft } from '../src/planning/step-plan.ts'

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
    completion_criteria: ['The result is verified.'],
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
  sub_state_id?: string
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
    sub_state_id: input.sub_state_id ?? 'sub-state-000001',
    plan,
    used_criterion_ids: input.used_criterion_ids ?? [],
    used_sub_step_ids: input.used_sub_step_ids ?? [],
  })
}
