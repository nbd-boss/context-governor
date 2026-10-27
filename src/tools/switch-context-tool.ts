import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import type { EpochController } from '../epoch/epoch-controller.ts'
import { SWITCH_RECONCILIATION_GUIDANCE } from '../agent-guidance.ts'
import type { WorkspaceMutations } from '../workspace/workspace-mutations.ts'
import type { DiscoveredConstraintChange } from '../state/state-contract.ts'
import { discoveredConstraintChangeSchema } from './tool-schemas.ts'
import { requireSessionEventIds } from './session-evidence.ts'

export const SWITCH_CONTEXT_DESCRIPTION = [
  'Begin a clean Context Epoch from the latest durable State and SubStates. Every prior successful Governor state change was already atomically persisted; this tool does not rewrite unchanged files.',
  'new_discovered_constraints is required: submit confirmed runtime restrictions to add or replace, or [] when none remain. Follow context_governor.decision_checks.after_reconnaissance; each entry uses condition, required_behavior, source_events referencing the execution History, and replaces ([] for an independent boundary, or active constraint_id values to retire). Governor allocates new IDs and validates replacements against the pre-call effective set. The whole list is atomically persisted as one State revision before requesting the switch, including in closing mode. An invalid entry or failed persistence prevents the switch; [] leaves State unchanged.',
  'Completing a SubStep does not itself require a Context switch: record it promptly, continue in the same Epoch when useful, and switch only at a natural boundary or when context pressure requires it.',
  SWITCH_RECONCILIATION_GUIDANCE,
].join('\n\n')

/** Persist outstanding constraints before requesting a Context boundary. */
export function registerSwitchContextTool(
  ctx: Context,
  epochs: EpochController,
  mutations: WorkspaceMutations,
): void {
  ctx.tools.register(defineTool({
    name: 'switch_context',
    description: SWITCH_CONTEXT_DESCRIPTION,
    parameters: {
      reason: { type: 'string', required: true, description: 'Brief explanation of this Context switch and any otherwise-unsaved recovery clues; the tool description defines the switch-note rules.' },
      expected_state_revision: { type: 'integer', required: true },
      new_discovered_constraints: { type: 'array', required: true, items: discoveredConstraintChangeSchema },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        state_revision: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('switch_context requires an active Session.')
      if (typeof args.reason !== 'string' || args.reason.trim() === '') throw new Error('reason must be a non-empty string')
      const sessionId = exec.agent.session.id
      if (args.new_discovered_constraints.length > 0) {
        const events = exec.agent.session.snapshotEvents()
        for (const [index, constraint] of args.new_discovered_constraints.entries()) {
          requireSessionEventIds(constraint?.source_events, events, `new_discovered_constraints[${String(index)}].source_events`)
        }
      }
      const snapshot = await mutations.switchSnapshot(sessionId, args.expected_state_revision as number, args.new_discovered_constraints as DiscoveredConstraintChange[])
      await epochs.requestSwitch(exec.agent, args.reason.trim(), { stateChanged: snapshot.state.revision !== args.expected_state_revision, subStepChanges: [] })
      exec.concludeTurn()
      return {
        status: 'switched',
        state_revision: snapshot.state.revision,
      }
    },
  }))
}
