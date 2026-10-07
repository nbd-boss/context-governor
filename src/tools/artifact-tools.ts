import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { type ArtifactContains, type ArtifactResourceFormat } from '../evidence/artifact-contract.ts'
import { EpochDeltaBuffer } from '../epoch/epoch-delta-buffer.ts'
import { readDurableWorkspace } from '../workspace/workspace-snapshot.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import { ARTIFACT_SELECTION_GUIDANCE } from '../agent-guidance.ts'

const containsSchema = {
  type: 'object' as const, required: true, additionalProperties: false,
  properties: {
    kind: { type: 'string' as const, required: true },
    summary: { type: 'string' as const, required: true },
    coverage: { type: 'string' as const, required: true },
    key_facts: { type: 'array' as const, required: true, items: { type: 'string' as const } },
    available_fields: { type: 'array' as const, required: true, items: { type: 'string' as const } },
  },
} as const

export const REGISTER_ARTIFACT_DESCRIPTION = [
  'Synchronously validate one structured Resource and reserve an Artifact ID in the current Epoch. The Artifact is not durable until a later advance_task_progress marks this Artifact as produced by the current SubStep, followed by a boundary commit.',
  'path must be an absolute path under the configured workspace, format must be json, jsonl, or csv, and source_events must identify current-Session evidence for the produced Resource.',
  'contains.key_facts must be concrete facts directly supported by the Resource; contains.available_fields must name fields actually present in it.',
  ARTIFACT_SELECTION_GUIDANCE,
].join(' ')

function sourceEventsExist(value: unknown, events: readonly { seq: number }[]): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !/^event-(0|[1-9]\d*)$/.test(id))) {
    throw new Error('source_events must contain one or more event-N identifiers')
  }
  if (value.some(id => !events.some(event => event.seq === Number(id.slice('event-'.length))))) {
    throw new Error('source_events must reference events in the current Session')
  }
}

/** Register only validated Artifact metadata in the in-memory Epoch Delta. */
export function registerArtifactTools(ctx: Context, workspaces: SessionWorkspaceProvider, deltas: EpochDeltaBuffer): void {
  ctx.tools.register(defineTool({
    name: 'register_artifact',
    description: REGISTER_ARTIFACT_DESCRIPTION,
    parameters: {
      reason: { type: 'string', required: true },
      expected_epoch_revision: { type: 'integer', required: true },
      contains: containsSchema,
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
        epoch_revision: { type: 'integer', required: true },
        artifact_id: { type: 'string', required: true },
        contains: containsSchema,
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('register_artifact requires an active Session.')
      const sessionId = exec.agent.session.id
      const sourceEvents = args.source_events as unknown
      sourceEventsExist(sourceEvents, exec.agent.session.snapshotEvents())
      const durable = await readDurableWorkspace(workspaces, sessionId)
      const before = deltas.snapshot(sessionId, durable)
      if (args.expected_epoch_revision !== before.revision) throw new Error(`epoch revision mismatch: expected ${String(args.expected_epoch_revision)}, current ${String(before.revision)}`)
      const workspace = workspaces.forSession(sessionId)
      const artifact = await workspace.artifact_service.register({
        contains: args.contains as ArtifactContains,
        resource: args.resource as { path: string; format: ArtifactResourceFormat },
      }, [
        ...before.projected.artifacts,
        ...before.pending_artifacts.map(item => item.artifact),
      ])
      const snapshot = deltas.recordArtifact({
        sessionId, durable, expectedRevision: before.revision, reason: args.reason as string, artifact, source_events: sourceEvents,
      })
      return { status: 'verified', epoch_revision: snapshot.revision, artifact_id: artifact.artifact_id, contains: artifact.contains }
    },
  }))
}
