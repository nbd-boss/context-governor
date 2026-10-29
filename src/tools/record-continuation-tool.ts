import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { recordContinuation } from '../epoch/epoch-projection.ts'
import { CONSTRAINT_HANDOFF_GUIDANCE } from '../agent-guidance.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import type { WorkspaceMutations } from '../workspace/workspace-mutations.ts'
import { stateOutputSchema, nullableSubStateOutputSchema } from './tool-schemas.ts'

export const RECORD_CONTINUATION_DESCRIPTION = [
  'Persist recovery information for the current incomplete SubStep without changing its criteria, advancing work, or completing the task. A current SubStep must already exist.',
  'operation=save records reusable progress in real mutable workspace files and returns without ending the turn or switching Context. operation=wait_for_input records unmet work and the required external input, then ends the current turn only after the handoff is durably saved; the Step remains in_progress and lifecycle.status remains active.',
  CONSTRAINT_HANDOFF_GUIDANCE,
  'progress states what is already covered, remaining uncertainty, and relevant failed attempts with their conditions; working_resources names those files and their contents, and resume_from states the exact next action or bounded boundary; it must not merely say to continue working. For wait_for_input, identify the missing prerequisite and its impact in progress, and the required input plus the next action once supplied in resume_from. Before this terminating call, explain the blocker and required input to the user.',
  'save requires at least one real working Resource. wait_for_input may use working_resources=[] for a text-only handoff; never create a placeholder file merely to stop. Any supplied paths must still name real workspace files.',
  'The next Epoch treats this Continuation as its active handoff: do not use it to repeat confirmed retrieval or verification. If output is too large for one operation, persist the next bounded portion and replace this Continuation with the following boundary.',
  'Do not use this for completed work or verified immutable data: use advance_task_progress and, when needed, register_artifact instead.',
  'The Governor derives the active Step and SubStep. A changed Continuation immediately persists one new State revision and replaces the earlier Continuation, not a progress log. wait_for_input can reuse an identical already-durable Continuation without rewriting it. operation controls only this call and is not added to State or SubState.',
].join('\n\n')

/** Register unfinished-work handoff without exposing duplicate identity fields. */
export function registerRecordContinuationTool(ctx: Context, workspaces: SessionWorkspaceProvider, mutations: WorkspaceMutations): void {
  ctx.tools.register(defineTool({
    name: 'record_continuation',
    description: RECORD_CONTINUATION_DESCRIPTION,
    parameters: {
      operation: { type: 'string', required: true, enum: ['save', 'wait_for_input'] },
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
        state_revision: { type: 'integer', required: true },
        state: stateOutputSchema,
        current_sub_state: nullableSubStateOutputSchema,
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('record_continuation requires an active Session.')
      if (args.operation !== 'save' && args.operation !== 'wait_for_input') {
        throw new Error('operation must be save or wait_for_input')
      }
      const waiting = args.operation === 'wait_for_input'
      const sessionId = exec.agent.session.id
      const workspace = workspaces.forSession(sessionId)
      const continuation = await workspace.continuation_service.validate({
        progress: args.progress,
        working_resources: args.working_resources,
        resume_from: args.resume_from,
      })
      if (!waiting && continuation.working_resources.length === 0) {
        throw new Error('operation=save requires at least one real working Resource')
      }
      const snapshot = await mutations.apply(sessionId, undefined, base => recordContinuation(base, continuation), { allowUnchanged: waiting })
      const active = snapshot.state.task_plan.steps.find(step => step.status === 'in_progress')
      if (waiting) exec.concludeTurn()
      return {
        status: waiting ? 'waiting_for_input' : 'committed',
        state_revision: snapshot.state.revision,
        state: snapshot.state,
        current_sub_state: active === undefined ? null : snapshot.sub_states.find(subState => subState.step_id === active.step_id) ?? null,
      }
    },
  }))
}
