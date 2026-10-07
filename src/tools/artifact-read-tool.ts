import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'

/** Read exact Artifact Resource data only after SubState navigation identifies it as necessary. */
export function registerArtifactReadTool(ctx: Context, workspaces: SessionWorkspaceProvider): void {
  ctx.tools.register(defineTool({
    name: 'read_artifact',
    description: 'Read one exact Artifact Resource by artifact_id. For a prior-Epoch result, this is the preferred exact-data source when its SubState key facts are insufficient but its coverage and available_fields match the current action; do not rediscover the same Resource through filesystem search. The result is re-hashed before use, and a changed Resource returns stale without trusted content.',
    parameters: { artifact_id: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        artifact_id: { type: 'string', required: true },
        contains: { type: 'object', required: true, additionalProperties: true, properties: {} },
        // DSH requires an explicit unconstrained JSON value schema. Artifact
        // resources may be an object, array, scalar, or parsed CSV rows.
        content: { type: 'json' },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('read_artifact requires an active Session.')
      const sessionId = exec.agent.session.id
      const workspace = workspaces.forSession(sessionId)
      await workspace.recover()
      const artifact = await workspace.artifacts.read(args.artifact_id as string)
      if (artifact === undefined) throw new Error(`Artifact not found: ${String(args.artifact_id)}`)
      const result = await workspace.artifact_service.read(artifact)
      await workspace.audits.recordRead(sessionId, { kind: 'artifact', target: artifact.artifact_id })
      return {
        status: result.status,
        artifact_id: artifact.artifact_id,
        contains: artifact.contains,
        ...(result.status === 'ready' ? { content: result.content } : {}),
      }
    },
  }))
}
