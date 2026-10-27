import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import { createInitialState } from '../state/state-contract.ts'
import { formatDecisionCheck, PLANNING_CORE_GUIDANCE, STEP_PLANNING_GUIDANCE, TASK_COMPLETION_CRITERIA_GUIDANCE } from '../agent-guidance.ts'
import type { StepPlanDraft } from '../planning/step-plan.ts'
import { stateOutputSchema, stepPlanSchema } from './tool-schemas.ts'

/** Initialize the task-level plan; the first Step is active but not yet planned. */
export function registerStateTools(ctx: Context, workspaces: SessionWorkspaceProvider): void {
  ctx.tools.register(defineTool({
    name: 'initialize_context_state',
    description: `Initialize a new task from the Mission and its ordered task-level plan. The first Step becomes active without a SubState. Inspect relevant evidence when needed, then call plan_current_step before executing or completing a SubStep. user_constraints contains only direct user requirements.\n\n${TASK_COMPLETION_CRITERIA_GUIDANCE}\n\n${PLANNING_CORE_GUIDANCE}\n\n${STEP_PLANNING_GUIDANCE}\n\n${formatDecisionCheck('before_scope_or_external_change')}`,
    parameters: {
      mission: { type: 'string', required: true },
      task_plan: stepPlanSchema,
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
      await workspace.transition.initialize({ state: prepared, sub_states: [], artifacts: [] })
      workspace.state.invalidate()
      return (await workspace.state.read())!
    },
  }))
}
