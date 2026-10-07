import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import type { EpochController } from '../epoch/epoch-controller.ts'
import { EpochDeltaBuffer } from '../epoch/epoch-delta-buffer.ts'
import { stampBoundaryRevision } from '../epoch/epoch-projection.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import { SWITCH_RECONCILIATION_GUIDANCE } from '../agent-guidance.ts'
import { readDurableWorkspace } from '../workspace/workspace-snapshot.ts'

export const SWITCH_CONTEXT_DESCRIPTION = [
  'Commit the ordered in-memory State and SubState Deltas, then begin a clean Context Epoch. It accepts no duplicate State, SubState, or History payload.',
  'Use expected_epoch_revision 0 only when this Epoch recorded no in-memory Delta.',
  'Completing a SubStep does not itself require a Context switch: record it promptly, continue in the same Epoch when useful, and switch only at a natural boundary or when context pressure requires it.',
  SWITCH_RECONCILIATION_GUIDANCE,
].join(' ')

/** Durable boundary for State and SubState, installed through a recoverable transaction. */
export function registerSwitchContextTool(
  ctx: Context,
  workspaces: SessionWorkspaceProvider,
  epochs: EpochController,
  deltas: EpochDeltaBuffer,
): void {
  ctx.tools.register(defineTool({
    name: 'switch_context',
    description: SWITCH_CONTEXT_DESCRIPTION,
    parameters: {
      reason: { type: 'string', required: true },
      expected_epoch_revision: { type: 'integer', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        state_revision: { type: 'integer', required: true },
        committed_epoch_revision: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('switch_context requires an active Session.')
      if (typeof args.reason !== 'string' || args.reason.trim() === '') throw new Error('reason must be a non-empty string')
      const sessionId = exec.agent.session.id
      const workspace = workspaces.forSession(sessionId)
      const durable = await readDurableWorkspace(workspaces, sessionId)
      const snapshot = deltas.snapshot(sessionId, durable)
      if (args.expected_epoch_revision !== snapshot.revision) throw new Error(`epoch revision mismatch: expected ${String(args.expected_epoch_revision)}, current ${String(snapshot.revision)}`)
      if (snapshot.pending_artifacts.length > 0) {
        throw new Error('Every registered Artifact must be referenced as produced by a completed SubStep before switching Context')
      }
      if (snapshot.revision > 0) {
        const target = stampBoundaryRevision(durable.state, snapshot.projected)
        await workspace.transition.commit(durable, target)
        workspace.state.invalidate()
      }
      deltas.clear(sessionId)
      await epochs.requestSwitch(exec.agent, args.reason.trim(), { stateChanged: snapshot.revision > 0, subStepChanges: [] })
      exec.concludeTurn()
      return {
        status: 'committed',
        state_revision: snapshot.revision > 0 ? durable.state.revision + 1 : durable.state.revision,
        committed_epoch_revision: snapshot.revision,
      }
    },
  }))
}
