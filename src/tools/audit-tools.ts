import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'

/** Exposes audit metadata only; raw Session History remains behind History tools. */
export function registerAuditTools(ctx: Context, workspaces: SessionWorkspaceProvider): void {
  ctx.tools.register(defineTool({
    name: 'read_context_audit',
    description: 'Read Context Governor audit records for the current Session. This reports Epoch boundaries and retrieval metadata, never raw History content.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { epochs: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('read_context_audit requires an active Session.')
      return { epochs: await workspaces.forSession(exec.agent.session.id).audits.list(exec.agent.session.id) }
    },
  }))
}
