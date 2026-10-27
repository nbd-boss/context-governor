import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { PLANNING_CORE_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE } from '../agent-guidance.ts'
import { planCurrentStep } from '../epoch/epoch-projection.ts'
import type { WorkspaceMutations } from '../workspace/workspace-mutations.ts'
import { subStepPlanSchema, stateOutputSchema, subStateOutputSchema } from './tool-schemas.ts'
import { toSubStepPlanDraft } from './planning-input.ts'

/** A Step owns no SubState until its acceptance criteria and children are grounded. */
export function registerPlanCurrentStepTool(ctx: Context, mutations: WorkspaceMutations): void {
  ctx.tools.register(defineTool({
    name: 'plan_current_step',
    description: [
      'Plan the active, not-yet-planned Step after inspecting only the evidence needed to establish its acceptance criteria. If existing authoritative evidence is sufficient, plan directly.',
      'Submit complete step_completion_criteria and sub_steps together; every criterion must be covered. Field names alone do not establish a business obligation.',
      'This atomically persists the new SubState and starts its first SubStep. A Step that already has a SubState cannot be planned again.',
      PLANNING_CORE_GUIDANCE,
      SUB_STEP_PLANNING_GUIDANCE,
    ].join('\n\n'),
    parameters: {
      expected_state_revision: { type: 'integer', required: true },
      step_id: { type: 'string', required: true },
      plan: subStepPlanSchema,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        state_revision: { type: 'integer', required: true },
        state: stateOutputSchema,
        current_sub_state: { ...subStateOutputSchema, required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('plan_current_step requires an active Session.')
      const snapshot = await mutations.apply(exec.agent.session.id, args.expected_state_revision as number, base => planCurrentStep(base, {
        step_id: args.step_id as string,
        plan: toSubStepPlanDraft(args.plan as Parameters<typeof toSubStepPlanDraft>[0]),
      }))
      return {
        status: 'planned', state_revision: snapshot.state.revision, state: snapshot.state,
        current_sub_state: snapshot.sub_states.find(item => item.step_id === args.step_id)!,
      }
    },
  }))
}
