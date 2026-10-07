import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { ContextQuery } from '../epoch/context-query.ts'
import { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'

/** Read a detailed Step SubState by stable identity; it never writes an index. */
export function registerSubStateTools(ctx: Context, workspaces: SessionWorkspaceProvider): void {
  ctx.tools.register(defineTool({
    name: 'read_sub_state',
    description: 'Read one Step SubState by its stable step_id. It returns completed SubStep conclusions and lightweight Artifact navigation. Use it before recovering prior work from History, workspace files, or external systems. If Artifact key facts are insufficient but its coverage and available_fields match the exact inputs needed next, call read_artifact with that artifact_id.',
    parameters: {
      step_id: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        schema_version: { type: 'integer', required: true },
        sub_state_id: { type: 'string', required: true },
        step_id: { type: 'string', required: true },
        step_completion_criteria: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
        completed_sub_steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
        current_sub_step: {
          required: true,
          oneOf: [
            { type: 'object', additionalProperties: true, properties: {} },
            { type: 'null' },
          ],
        },
        pending_sub_steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('read_sub_state requires an active Session.')
      const workspace = workspaces.forSession(exec.agent.session.id)
      await workspace.recover()
      const state = await workspace.state.read()
      if (state === undefined) throw new Error('Context State does not exist; use initialize_context_state first.')
      if (!state.task_plan.steps.some(step => step.step_id === args.step_id)) throw new Error(`step_id is not in task_plan: ${String(args.step_id)}`)
      const query = new ContextQuery({ state, sub_states: await workspace.sub_states.readAll(), artifacts: await workspace.artifacts.readAll() })
      const subState = query.runtimeSubState(args.step_id as string)
      if (subState === undefined) throw new Error(`No SubState exists for step_id: ${String(args.step_id)}`)
      await workspace.audits.recordRead(exec.agent.session.id, { kind: 'sub_state', target: args.step_id as string })
      return subState
    },
  }))
}
