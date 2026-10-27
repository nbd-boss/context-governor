import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { type ArtifactContains, type ArtifactResourceFormat } from '../evidence/artifact-contract.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import type { WorkspaceMutations } from '../workspace/workspace-mutations.ts'
import { ARTIFACT_SELECTION_GUIDANCE } from '../agent-guidance.ts'
import { artifactContainsSchema } from './tool-schemas.ts'

export const REGISTER_ARTIFACT_DESCRIPTION = [
  'Synchronously validate one structured Resource and reserve an Artifact ID. Its metadata becomes durable when advance_task_progress atomically records the producing SubStep and Artifact together.',
  'path must be an absolute path under the configured workspace, format must be json, jsonl, or csv, and source_events must identify current-Session evidence for the produced Resource.',
  'contains.key_facts must be concrete facts directly supported by the Resource; contains.available_fields must name fields actually present in it.',
  'Before treating an inferred scope or identity relationship as a verified Artifact fact, apply context_governor.decision_checks.before_scope_or_external_change.',
  ARTIFACT_SELECTION_GUIDANCE,
].join('\n\n')

function sourceEventsExist(value: unknown, events: readonly { seq: number }[]): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !/^event-(0|[1-9]\d*)$/.test(id))) {
    throw new Error('source_events must contain one or more event-N identifiers')
  }
  if (value.some(id => !events.some(event => event.seq === Number(id.slice('event-'.length))))) {
    throw new Error('source_events must reference events in the current Session')
  }
}

/** Keep only unclaimed Artifact metadata staged until its producer is committed. */
export function registerArtifactTools(ctx: Context, workspaces: SessionWorkspaceProvider, mutations: WorkspaceMutations): void {
  ctx.tools.register(defineTool({
    name: 'register_artifact',
    description: REGISTER_ARTIFACT_DESCRIPTION,
    parameters: {
      expected_state_revision: { type: 'integer', required: true },
      contains: artifactContainsSchema,
      resource: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          format: { type: 'string', required: true, enum: ['json', 'jsonl', 'csv'] },
        },
      },
      source_events: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        state_revision: { type: 'integer', required: true },
        artifact_id: { type: 'string', required: true },
        contains: artifactContainsSchema,
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('register_artifact requires an active Session.')
      const sessionId = exec.agent.session.id
      const sourceEvents = args.source_events as unknown
      sourceEventsExist(sourceEvents, exec.agent.session.snapshotEvents())
      const workspace = workspaces.forSession(sessionId)
      const result = await mutations.registerArtifact(
        sessionId,
        args.expected_state_revision as number,
        sourceEvents,
        known => workspace.artifact_service.register({
          contains: args.contains as ArtifactContains,
          resource: args.resource as { path: string; format: ArtifactResourceFormat },
        }, known),
      )
      return { status: 'verified', state_revision: result.stateRevision, artifact_id: result.artifact.artifact_id, contains: result.artifact.contains }
    },
  }))
}
