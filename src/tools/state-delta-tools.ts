import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { EpochDeltaBuffer } from '../epoch/epoch-delta-buffer.ts'
import { PLANNING_CORE_GUIDANCE, STEP_PLANNING_GUIDANCE } from '../agent-guidance.ts'
import { readDurableWorkspace } from '../workspace/workspace-snapshot.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import type { ContextState } from '../state/state-contract.ts'
import type { PendingStepPlanDraft } from '../planning/step-plan.ts'
import { pendingStepPlanItemSchema, stateOutputSchema } from './tool-schemas.ts'

const pendingStepsSchema = {
  type: 'array' as const, required: true,
  items: pendingStepPlanItemSchema,
} as const

function currentSessionEvents(exec: { agent?: { session: { snapshotEvents(): readonly { seq: number; type: string }[] } } }): readonly { seq: number; type: string }[] {
  if (exec.agent === undefined) throw new Error('State Delta tools require an active Session.')
  return exec.agent.session.snapshotEvents()
}

function requireEventIds(value: unknown, events: readonly { seq: number }[], field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !/^event-(0|[1-9]\d*)$/.test(id))) {
    throw new Error(`${field} must contain one or more event-N identifiers`)
  }
  if (value.some(id => !events.some(event => event.seq === Number(id.slice('event-'.length))))) {
    throw new Error(`${field} must reference events in the current Session`)
  }
}

function deltaOutput(snapshot: { revision: number; projected: { state: ContextState; sub_states: Array<{ step_id: string }> } }) {
  const active = snapshot.projected.state.task_plan.steps.find(step => step.status === 'in_progress')
  return {
    status: 'recorded',
    epoch_revision: snapshot.revision,
    state: snapshot.projected.state,
    current_sub_state: active === undefined ? null : snapshot.projected.sub_states.find(subState => subState.step_id === active.step_id) ?? null,
  }
}

const output = {
  schema: { type: 'object' as const, additionalProperties: false, properties: {
    status: { type: 'string' as const, required: true },
    epoch_revision: { type: 'integer' as const, required: true },
    state: stateOutputSchema,
    current_sub_state: { type: 'object' as const, additionalProperties: true, properties: {} },
  } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** State-only changes use the same in-memory Delta and boundary transaction as SubStep progress. */
export function registerStateDeltaTools(ctx: Context, workspaces: SessionWorkspaceProvider, deltas: EpochDeltaBuffer): void {
  ctx.tools.register(defineTool({
    name: 'revise_task_plan',
    description: `Revise only not-yet-started pending Steps in the current Epoch. Supply the complete desired pending_steps order: retain a Step by its step_id, omit step_id only for a new Step, and omit an old pending Step to remove it. Use the immutable task_plan completion-criteria indexes in covers. Active and done Steps cannot change. inputs/result are planning-only and are discarded. This records an in-memory Delta only. ${PLANNING_CORE_GUIDANCE} ${STEP_PLANNING_GUIDANCE}`,
    parameters: {
      reason: { type: 'string', required: true },
      expected_epoch_revision: { type: 'integer', required: true },
      pending_steps: pendingStepsSchema,
    },
    output,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('revise_task_plan requires an active Session.')
      const sessionId = exec.agent.session.id
      const durable = await readDurableWorkspace(workspaces, sessionId)
      const snapshot = deltas.recordPlanRevision({
        sessionId, durable, expectedRevision: args.expected_epoch_revision as number, reason: args.reason as string,
        operation: { pending_steps: args.pending_steps as PendingStepPlanDraft[] },
      })
      return deltaOutput(snapshot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'record_discovered_constraint',
    description: 'Record one confirmed runtime constraint that will continue to restrict later work. This is not for hypotheses or ordinary observations. Provide current-Session evidence, and it remains an in-memory Delta until the next boundary.',
    parameters: {
      reason: { type: 'string', required: true },
      expected_epoch_revision: { type: 'integer', required: true },
      kind: { type: 'string', required: true, enum: ['retry_safety', 'external_contract', 'environment_limit'] },
      condition: { type: 'string', required: true },
      required_behavior: { type: 'string', required: true },
      source_events: { type: 'array', required: true, items: { type: 'string' } },
    },
    output,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('record_discovered_constraint requires an active Session.')
      const sessionId = exec.agent.session.id
      const sourceEvents = args.source_events as unknown
      requireEventIds(sourceEvents, currentSessionEvents(exec), 'source_events')
      const durable = await readDurableWorkspace(workspaces, sessionId)
      const snapshot = deltas.recordDiscoveredConstraint({
        sessionId, durable, expectedRevision: args.expected_epoch_revision as number, reason: args.reason as string,
        operation: {
          kind: args.kind as 'retry_safety' | 'external_contract' | 'environment_limit',
          condition: args.condition as string,
          required_behavior: args.required_behavior as string,
          source_events: sourceEvents,
        },
      })
      return deltaOutput(snapshot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'record_user_constraint',
    description: 'Append one new explicit human requirement to State. source_event must be the current Session user/message that supplied it. This tool cannot remove or rewrite existing user constraints, and it records only an in-memory Delta until the next boundary.',
    parameters: {
      reason: { type: 'string', required: true },
      expected_epoch_revision: { type: 'integer', required: true },
      constraint: { type: 'string', required: true },
      source_event: { type: 'string', required: true },
    },
    output,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('record_user_constraint requires an active Session.')
      const sessionId = exec.agent.session.id
      const events = currentSessionEvents(exec)
      requireEventIds([args.source_event], events, 'source_event')
      const event = events.find(candidate => candidate.seq === Number((args.source_event as string).slice('event-'.length)))
      if (event?.type !== 'user/message') throw new Error('source_event must identify a current Session user/message')
      const durable = await readDurableWorkspace(workspaces, sessionId)
      const snapshot = deltas.recordUserConstraint({
        sessionId, durable, expectedRevision: args.expected_epoch_revision as number, reason: args.reason as string,
        operation: { constraint: args.constraint as string },
      })
      return deltaOutput(snapshot)
    },
  }))
}
