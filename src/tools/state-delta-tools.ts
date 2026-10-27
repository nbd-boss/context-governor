import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { PLANNING_CORE_GUIDANCE, STEP_PLANNING_GUIDANCE } from '../agent-guidance.ts'
import type { WorkspaceMutations } from '../workspace/workspace-mutations.ts'
import type { WorkspaceSnapshot } from '../workspace/workspace-validator.ts'
import { applyDiscoveredConstraints, appendUserConstraint, reviseStateStep } from '../state/state-contract.ts'
import type { StepChange } from '../planning/step-plan.ts'
import { discoveredConstraintChangeSchema, stepChangeSchema, stateOutputSchema, nullableSubStateOutputSchema } from './tool-schemas.ts'
import { requireSessionEventIds } from './session-evidence.ts'
import { PENDING_PLAN_REVISION_GUIDANCE } from '../agent-guidance.ts'

function currentSessionEvents(exec: { agent?: { session: { snapshotEvents(): readonly { seq: number; type: string }[] } } }): readonly { seq: number; type: string }[] {
  if (exec.agent === undefined) throw new Error('State Delta tools require an active Session.')
  return exec.agent.session.snapshotEvents()
}

function deltaOutput(snapshot: WorkspaceSnapshot) {
  const active = snapshot.state.task_plan.steps.find(step => step.status === 'in_progress')
  return {
    status: 'committed',
    state_revision: snapshot.state.revision,
    state: snapshot.state,
    current_sub_state: active === undefined ? null : snapshot.sub_states.find(subState => subState.step_id === active.step_id) ?? null,
  }
}

const output = {
  schema: { type: 'object' as const, additionalProperties: false, properties: {
    status: { type: 'string' as const, required: true },
    state_revision: { type: 'integer' as const, required: true },
    state: stateOutputSchema,
    current_sub_state: nullableSubStateOutputSchema,
  } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/** State-only changes use the same immediate Workspace transaction as SubStep progress. */
export function registerStateDeltaTools(ctx: Context, mutations: WorkspaceMutations): void {
  ctx.tools.register(defineTool({
    name: 'revise_step',
    description: `Add, update, or delete exactly one pending top-level Step. add appends a new Step and Governor allocates its ID. update preserves the existing Step ID and position; delete removes only that pending plan entry. Use task_plan completion-criteria indexes in covers. inputs/result are planning-only. Active and done Steps cannot change.\n\n${PENDING_PLAN_REVISION_GUIDANCE}\n\n${PLANNING_CORE_GUIDANCE}\n\n${STEP_PLANNING_GUIDANCE}`,
    parameters: {
      expected_state_revision: { type: 'integer', required: true },
      change: { ...stepChangeSchema, required: true },
    },
    output,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('revise_step requires an active Session.')
      const snapshot = await mutations.apply(exec.agent.session.id, args.expected_state_revision as number, base => ({
        ...base,
        state: reviseStateStep(base.state, { change: args.change as StepChange }),
      }))
      return deltaOutput(snapshot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'record_discovered_constraint',
    description: 'Record one confirmed runtime constraint or replace specified active constraints, following context_governor.decision_checks.after_reconnaissance. condition states when and where it applies; required_behavior states the resulting action requirement; source_events identifies supporting original events in the execution History. replaces is required: [] adds an independent boundary; existing constraint_id values explicitly retire those boundaries and add this replacement with a new Governor-generated ID. State keeps only effective constraints; original calls remain in History. A successful change is atomically persisted.',
    parameters: {
      expected_state_revision: { type: 'integer', required: true },
      ...discoveredConstraintChangeSchema.properties,
    },
    output,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('record_discovered_constraint requires an active Session.')
      const sessionId = exec.agent.session.id
      const sourceEvents = args.source_events as unknown
      requireSessionEventIds(sourceEvents, currentSessionEvents(exec), 'source_events')
      const snapshot = await mutations.apply(sessionId, args.expected_state_revision as number, base => ({
        ...base,
        state: applyDiscoveredConstraints(base.state, [{
          kind: args.kind as 'retry_safety' | 'external_contract' | 'environment_limit',
          condition: args.condition as string,
          required_behavior: args.required_behavior as string,
          source_events: sourceEvents,
          replaces: args.replaces as string[],
        }]),
      }))
      return deltaOutput(snapshot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'record_user_constraint',
    description: 'Append one new explicit human requirement to State. source_event must be the current Session user/message that supplied it. This tool cannot remove or rewrite existing user constraints; a successful change is atomically persisted.',
    parameters: {
      expected_state_revision: { type: 'integer', required: true },
      constraint: { type: 'string', required: true },
      source_event: { type: 'string', required: true },
    },
    output,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('record_user_constraint requires an active Session.')
      const sessionId = exec.agent.session.id
      const events = currentSessionEvents(exec)
      requireSessionEventIds([args.source_event], events, 'source_event')
      const event = events.find(candidate => candidate.seq === Number((args.source_event as string).slice('event-'.length)))
      if (event?.type !== 'user/message') throw new Error('source_event must identify a current Session user/message')
      const snapshot = await mutations.apply(sessionId, args.expected_state_revision as number, base => ({
        ...base,
        state: appendUserConstraint(base.state, { constraint: args.constraint as string }),
      }))
      return deltaOutput(snapshot)
    },
  }))
}
