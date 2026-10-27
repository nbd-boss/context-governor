import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { PLANNING_CORE_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE, PENDING_PLAN_REVISION_GUIDANCE } from '../agent-guidance.ts'
import { reviseSubStep } from '../epoch/epoch-projection.ts'
import type { WorkspaceMutations } from '../workspace/workspace-mutations.ts'
import { subStepChangeSchema, stateOutputSchema, nullableSubStateOutputSchema } from './tool-schemas.ts'
import { toSubStepChange } from './planning-input.ts'

export const REVISE_SUBSTEP_DESCRIPTION = [
  'Add, update, or delete exactly one pending SubStep in the active Step. add appends new work and Governor allocates its ID; update preserves identity and position; delete removes only that pending plan entry.',
  'This tool never changes step_completion_criteria, completed_sub_steps, or current_sub_step. A mere execution-method change does not require replanning.',
  'For add/update, supply inputs, one result, action, and covers_criterion_ids from current_sub_state.step_completion_criteria. inputs/result are planning-only and discarded. delete takes only sub_step_id inside change.',
  'A successful replacement is atomically persisted and returned with the new State revision.',
  PLANNING_CORE_GUIDANCE,
  SUB_STEP_PLANNING_GUIDANCE,
  PENDING_PLAN_REVISION_GUIDANCE,
].join('\n\n')

export function registerReviseSubstepTool(
  ctx: Context,
  mutations: WorkspaceMutations,
): void {
  ctx.tools.register(defineTool({
    name: 'revise_substep',
    description: REVISE_SUBSTEP_DESCRIPTION,
    parameters: {
      expected_state_revision: { type: 'integer', required: true },
      step_id: { type: 'string', required: true },
      expected_current_sub_step_id: { type: 'string', required: true },
      change: { ...subStepChangeSchema, required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        state_revision: { type: 'integer', required: true },
        state: stateOutputSchema,
        current_sub_state: nullableSubStateOutputSchema,
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('revise_substep requires an active Session.')
      const snapshot = await mutations.apply(exec.agent.session.id, args.expected_state_revision as number, base => reviseSubStep(base, {
          step_id: args.step_id as string,
          expected_current_sub_step_id: args.expected_current_sub_step_id as string,
          change: toSubStepChange(args.change as Record<string, unknown>),
      }))
      const active = snapshot.state.task_plan.steps.find(step => step.status === 'in_progress')
      return {
        status: 'committed',
        state_revision: snapshot.state.revision,
        state: snapshot.state,
        current_sub_state: active === undefined ? null : snapshot.sub_states.find(subState => subState.step_id === active.step_id) ?? null,
      }
    },
  }))
}
