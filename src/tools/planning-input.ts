import type { SubStepChange, SubStepPlanDraft } from '../planning/sub-step-plan.ts'

type NewPlanInput = Omit<SubStepPlanDraft, 'sub_steps'> & {
  sub_steps: Array<Omit<SubStepPlanDraft['sub_steps'][number], 'covers'> & { covers_criterion_indexes: number[] }>
}

/** Keep DSH-facing coverage names explicit; the planning domain uses one compact internal field. */
export function toSubStepPlanDraft(input: NewPlanInput): SubStepPlanDraft {
  return {
    step_completion_criteria: input.step_completion_criteria,
    sub_steps: input.sub_steps.map(({ covers_criterion_indexes, ...item }) => ({ ...item, covers: covers_criterion_indexes })),
  }
}

export function toSubStepChange(input: Record<string, unknown>): SubStepChange {
  const { covers_criterion_ids, ...change } = input
  return (input.operation === 'delete' ? input : { ...change, covers: covers_criterion_ids }) as SubStepChange
}
