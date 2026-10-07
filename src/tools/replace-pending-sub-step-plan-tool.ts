import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { PLANNING_CORE_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE } from '../agent-guidance.ts'
import { EpochDeltaBuffer } from '../epoch/epoch-delta-buffer.ts'
import { readDurableWorkspace } from '../workspace/workspace-snapshot.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import type { PendingSubStepDraft } from '../planning/sub-step-plan.ts'
import { pendingSubStepPlanItemSchema } from './tool-schemas.ts'

export const REPLACE_PENDING_SUB_STEP_PLAN_DESCRIPTION = [
  'Replace the complete pending_sub_steps plan for the active Step after execution reveals a better split, merge, removal, or order.',
  'This tool never changes step_completion_criteria, completed_sub_steps, or current_sub_step. A mere execution-method change does not require replanning.',
  'For each desired pending item, state its conceptual inputs, one independently verifiable result, action, completion criteria, and persisted criterion-N coverage. Governor uses inputs/result only to make planning explicit, discards them after validation, and assigns fresh SubStep IDs.',
  'The replacement remains an in-memory Epoch Delta until switch_context succeeds.',
  PLANNING_CORE_GUIDANCE,
  SUB_STEP_PLANNING_GUIDANCE,
].join(' ')

export function registerReplacePendingSubStepPlanTool(
  ctx: Context,
  workspaces: SessionWorkspaceProvider,
  deltas: EpochDeltaBuffer,
): void {
  ctx.tools.register(defineTool({
    name: 'replace_pending_sub_step_plan',
    description: REPLACE_PENDING_SUB_STEP_PLAN_DESCRIPTION,
    parameters: {
      reason: { type: 'string', required: true },
      expected_epoch_revision: { type: 'integer', required: true },
      step_id: { type: 'string', required: true },
      expected_current_sub_step_id: { type: 'string', required: true },
      pending_sub_steps: {
        type: 'array', required: true,
        items: pendingSubStepPlanItemSchema,
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        epoch_revision: { type: 'integer', required: true },
        current_sub_state: { type: 'object', additionalProperties: true, properties: {} },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('replace_pending_sub_step_plan requires an active Session.')
      const sessionId = exec.agent.session.id
      const durable = await readDurableWorkspace(workspaces, sessionId)
      const snapshot = deltas.recordPendingSubStepPlan({
        sessionId,
        durable,
        expectedRevision: args.expected_epoch_revision as number,
        reason: args.reason as string,
        operation: {
          step_id: args.step_id as string,
          expected_current_sub_step_id: args.expected_current_sub_step_id as string,
          pending_sub_steps: args.pending_sub_steps as PendingSubStepDraft[],
        },
      })
      const active = snapshot.projected.state.task_plan.steps.find(step => step.status === 'in_progress')
      return {
        status: 'recorded',
        epoch_revision: snapshot.revision,
        current_sub_state: active === undefined ? null : snapshot.projected.sub_states.find(subState => subState.step_id === active.step_id) ?? null,
      }
    },
  }))
}
