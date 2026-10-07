import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import { createInitialState } from '../state/state-contract.ts'
import { createPlannedSubState, type SubStepPlanDraft } from '../planning/sub-step-plan.ts'
import { nextSubStateId } from '../ids.ts'
import { PLANNING_CORE_GUIDANCE, STEP_PLANNING_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE, TASK_COMPLETION_CRITERIA_GUIDANCE } from '../agent-guidance.ts'
import type { StepPlanDraft } from '../planning/step-plan.ts'
import { stateOutputSchema, stepPlanSchema, subStepPlanSchema } from './tool-schemas.ts'

/** Initialize State and the active Step's complete planned SubState together. */
export function registerStateTools(ctx: Context, workspaces: SessionWorkspaceProvider): void {
  ctx.tools.register(defineTool({
    name: 'initialize_context_state',
    description: `Initialize a new task. First derive task-level completion criteria from the Mission, then plan the complete ordered task_plan from those criteria; Governor activates its first Step. Then plan that active Step completely in current_step_plan; Governor activates its first SubStep. user_constraints contains only direct user requirements. ${TASK_COMPLETION_CRITERIA_GUIDANCE} ${PLANNING_CORE_GUIDANCE} ${STEP_PLANNING_GUIDANCE} ${SUB_STEP_PLANNING_GUIDANCE}`,
    parameters: {
      mission: { type: 'string', required: true },
      task_plan: stepPlanSchema,
      current_step_plan: subStepPlanSchema,
      user_constraints: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: { schema: stateOutputSchema, render: (_args, state) => [{ type: 'text', text: JSON.stringify(state) }] },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('initialize_context_state requires an active Session.')
      const workspace = workspaces.forSession(exec.agent.session.id)
      await workspace.recover()
      if (await workspace.state.read() !== undefined) throw new Error('Context State already exists; start a new Session for a new task.')
      const prepared = createInitialState({
        mission: args.mission as string,
        task_plan: args.task_plan as StepPlanDraft,
        user_constraints: args.user_constraints as string[],
      })
      const step = prepared.task_plan.steps.find(item => item.status === 'in_progress')!
      const subState = createPlannedSubState({
        sub_state_id: nextSubStateId([]),
        step_id: step.step_id,
        plan: args.current_step_plan as SubStepPlanDraft,
        used_criterion_ids: [],
        used_sub_step_ids: [],
      })
      await workspace.transition.initialize({ state: prepared, sub_states: [subState], artifacts: [] })
      workspace.state.invalidate()
      return (await workspace.state.read())!
    },
  }))
}
