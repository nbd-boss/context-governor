import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { EpochDeltaBuffer } from '../epoch/epoch-delta-buffer.ts'
import { readDurableWorkspace } from '../workspace/workspace-snapshot.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import { stateOutputSchema } from './tool-schemas.ts'

export const RECORD_EPOCH_CONTINUATION_DESCRIPTION = [
  'Replace the current incomplete SubStep continuation in memory so a later Context Epoch can resume exact work without rediscovery.',
  'Use this only when the current SubStep is not complete and already has reusable progress in one or more real mutable workspace files.',
  'progress states what is already covered, working_resources names those files and their contents, and resume_from states the exact next action or bounded boundary; it must not merely say to continue working.',
  'The next Epoch treats this Continuation as its active handoff: do not use it to repeat confirmed retrieval or verification. If output is too large for one operation, persist the next bounded portion and replace this Continuation with the following boundary.',
  'Do not use this for completed work or verified immutable data: use advance_task_progress and, when needed, register_artifact instead.',
  'The Governor derives the active Step, SubStep, and current Epoch revision. A later call replaces the earlier Continuation rather than appending a progress log.',
].join(' ')

/** Register unfinished-work handoff without exposing duplicate identity fields. */
export function registerRecordEpochContinuationTool(ctx: Context, workspaces: SessionWorkspaceProvider, deltas: EpochDeltaBuffer): void {
  ctx.tools.register(defineTool({
    name: 'record_epoch_continuation',
    description: RECORD_EPOCH_CONTINUATION_DESCRIPTION,
    parameters: {
      progress: { type: 'string', required: true },
      working_resources: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            contains: { type: 'string', required: true },
          },
        },
      },
      resume_from: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        epoch_revision: { type: 'integer', required: true },
        state: stateOutputSchema,
        current_sub_state: { type: 'object', additionalProperties: true, properties: {} },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('record_epoch_continuation requires an active Session.')
      const sessionId = exec.agent.session.id
      const workspace = workspaces.forSession(sessionId)
      const continuation = await workspace.continuation_service.validate({
        progress: args.progress,
        working_resources: args.working_resources,
        resume_from: args.resume_from,
      })
      const durable = await readDurableWorkspace(workspaces, sessionId)
      const snapshot = deltas.recordContinuation({ sessionId, durable, operation: continuation })
      const active = snapshot.projected.state.task_plan.steps.find(step => step.status === 'in_progress')
      return {
        status: 'recorded',
        epoch_revision: snapshot.revision,
        state: snapshot.projected.state,
        current_sub_state: active === undefined ? null : snapshot.projected.sub_states.find(subState => subState.step_id === active.step_id) ?? null,
      }
    },
  }))
}
