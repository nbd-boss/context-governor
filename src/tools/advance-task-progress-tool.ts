import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { PLANNING_CORE_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE } from '../agent-guidance.ts'
import { EpochDeltaBuffer } from '../epoch/epoch-delta-buffer.ts'
import type { EpochController } from '../epoch/epoch-controller.ts'
import { stampBoundaryRevision } from '../epoch/epoch-projection.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import type { ArtifactRef } from '../state/sub-state-contract.ts'
import type { SubStepPlanDraft } from '../planning/sub-step-plan.ts'
import { stateOutputSchema, subStepPlanSchema } from './tool-schemas.ts'
import { validateWorkspaceSnapshot } from '../workspace/workspace-validator.ts'
import { readDurableWorkspace } from '../workspace/workspace-snapshot.ts'

const completedSchema = {
  type: 'object' as const, required: true, additionalProperties: false,
  properties: {
    summary: { type: 'string' as const, required: true },
    source_events: { type: 'array' as const, required: true, items: { type: 'string' as const } },
    artifact_refs: {
      type: 'array' as const, required: true,
      items: {
        type: 'object' as const, additionalProperties: false,
        properties: {
          artifact_id: { type: 'string' as const, required: true },
          relation: { type: 'string' as const, required: true, enum: ['produced', 'used'] },
        },
      },
    },
  },
} as const

const identityProperties = {
  step_id: { type: 'string' as const, required: true },
  expected_sub_step_id: { type: 'string' as const, required: true },
  completed: completedSchema,
} as const

const advanceSubStepSchema = {
  type: 'object' as const, additionalProperties: false,
  properties: {
    type: { type: 'string' as const, required: true, enum: ['advance_sub_step'] },
    ...identityProperties,
  },
} as const

const advanceStepSchema = {
  type: 'object' as const, additionalProperties: false,
  properties: {
    type: { type: 'string' as const, required: true, enum: ['advance_step'] },
    ...identityProperties,
    next_step: {
      type: 'object' as const, required: true, additionalProperties: false,
      properties: {
        step_id: { type: 'string' as const, required: true },
        plan: subStepPlanSchema,
      },
    },
  },
} as const

const completeTaskSchema = {
  type: 'object' as const, additionalProperties: false,
  properties: {
    type: { type: 'string' as const, required: true, enum: ['complete_task'] },
    ...identityProperties,
  },
} as const

export const ADVANCE_TASK_PROGRESS_DESCRIPTION = [
  'Advance exactly one completed current SubStep through the task lifecycle.',
  'Use advance_sub_step when the current Step still has planned pending_sub_steps; Governor activates the first pending item automatically.',
  'Use advance_step only when the current Step has no pending_sub_steps and another pending top-level Step exists. next_step must identify that Step and provide its complete SubStep plan.',
  'Use complete_task only for the final active Step when neither pending SubSteps nor pending top-level Steps remain. It atomically persists all Epoch Deltas, marks lifecycle completed, and ends the turn.',
  'advance_sub_step and advance_step update only the in-memory Epoch projection; switch_context persists those non-terminal changes.',
  'Identify current work by step_id and expected_sub_step_id. completed.summary must state one confirmed reusable conclusion with current-Session event-N evidence. Always supply artifact_refs; use [] when none.',
  PLANNING_CORE_GUIDANCE,
  SUB_STEP_PLANNING_GUIDANCE,
].join(' ')

type TransitionCommon = {
  step_id: string
  expected_sub_step_id: string
  completed: { summary: string; source_events: unknown; artifact_refs: unknown }
}

type TransitionArgs =
  | TransitionCommon & { type: 'advance_sub_step' }
  | TransitionCommon & { type: 'advance_step'; next_step: { step_id: string; plan: SubStepPlanDraft } }
  | TransitionCommon & { type: 'complete_task' }

function sourceEventsExist(value: unknown, events: readonly { seq: number }[]): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !/^event-(0|[1-9]\d*)$/.test(id))) {
    throw new Error('completed.source_events must contain one or more event-N identifiers')
  }
  if (value.some(id => !events.some(event => event.seq === Number(id.slice('event-'.length))))) {
    throw new Error('completed.source_events must reference events in the current Session')
  }
}

/** The sole Agent-facing authority for SubStep, Step, and terminal task progress. */
export function registerAdvanceTaskProgressTool(
  ctx: Context,
  workspaces: SessionWorkspaceProvider,
  epochs: EpochController,
  deltas: EpochDeltaBuffer,
): void {
  ctx.tools.register(defineTool({
    name: 'advance_task_progress',
    description: ADVANCE_TASK_PROGRESS_DESCRIPTION,
    parameters: {
      reason: { type: 'string', required: true },
      expected_epoch_revision: { type: 'integer', required: true },
      transition: { required: true, oneOf: [advanceSubStepSchema, advanceStepSchema, completeTaskSchema] },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        epoch_revision: { type: 'integer', required: true },
        state: stateOutputSchema,
        current_sub_state: {
          required: true,
          oneOf: [
            { type: 'object', additionalProperties: true, properties: {} },
            { type: 'null' },
          ],
        },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('advance_task_progress requires an active Session.')
      const sessionId = exec.agent.session.id
      const transition = args.transition as TransitionArgs
      sourceEventsExist(transition.completed.source_events, exec.agent.session.snapshotEvents())
      if (!Array.isArray(transition.completed.artifact_refs)) throw new Error('completed.artifact_refs must be an array')
      const completed = {
        summary: transition.completed.summary,
        source_events: transition.completed.source_events,
        artifact_refs: transition.completed.artifact_refs as ArtifactRef[],
      }
      const common = {
        step_id: transition.step_id,
        expected_sub_step_id: transition.expected_sub_step_id,
        completed,
      }
      const durable = await readDurableWorkspace(workspaces, sessionId)

      if (transition.type === 'advance_sub_step') {
        const snapshot = deltas.recordSubStep({
          sessionId, durable,
          expectedRevision: args.expected_epoch_revision as number,
          reason: args.reason as string,
          operation: common,
        })
        const active = snapshot.projected.state.task_plan.steps.find(step => step.status === 'in_progress')
        return {
          status: 'recorded', epoch_revision: snapshot.revision, state: snapshot.projected.state,
          current_sub_state: snapshot.projected.sub_states.find(item => item.step_id === active?.step_id) ?? null,
        }
      }

      if (transition.type === 'advance_step') {
        const snapshot = deltas.recordStep({
          sessionId, durable,
          expectedRevision: args.expected_epoch_revision as number,
          reason: args.reason as string,
          operation: { ...common, next_step: transition.next_step },
        })
        const active = snapshot.projected.state.task_plan.steps.find(step => step.status === 'in_progress')
        return {
          status: 'recorded', epoch_revision: snapshot.revision, state: snapshot.projected.state,
          current_sub_state: snapshot.projected.sub_states.find(item => item.step_id === active?.step_id) ?? null,
        }
      }

      const before = deltas.snapshot(sessionId, durable)
      if (args.expected_epoch_revision !== before.revision) {
        throw new Error(`epoch revision mismatch: expected ${String(args.expected_epoch_revision)}, current ${String(before.revision)}`)
      }
      const active = before.projected.state.task_plan.steps.find(step => step.status === 'in_progress')
      if (active?.step_id !== transition.step_id || before.projected.state.task_plan.steps.some(step => step.status === 'pending')) {
        throw new Error('complete_task requires the final active Step with no pending top-level Steps')
      }
      const producedIds = new Set(completed.artifact_refs
        .filter(reference => reference.relation === 'produced')
        .map(reference => reference.artifact_id))
      if (before.pending_artifacts.some(item => !producedIds.has(item.artifact.artifact_id))) {
        throw new Error('Every registered Artifact must be referenced as produced by a completed SubStep before completing the task')
      }
      const terminal = deltas.recordStep({
        sessionId, durable,
        expectedRevision: before.revision,
        reason: args.reason as string,
        operation: { ...common, next_step: null },
      })
      if (terminal.pending_artifacts.length > 0) {
        throw new Error('Every registered Artifact must be referenced as produced by a completed SubStep before completing the task')
      }
      const stamped = stampBoundaryRevision(durable.state, terminal.projected)
      const target = validateWorkspaceSnapshot({
        ...stamped,
        state: { ...stamped.state, lifecycle: { status: 'completed' } },
      })
      const workspace = workspaces.forSession(sessionId)
      await workspace.transition.commit(durable, target)
      workspace.state.invalidate()
      deltas.clear(sessionId)
      await epochs.complete(exec.agent, args.reason as string, { stateChanged: true, subStepChanges: [] })
      exec.concludeTurn()
      return { status: 'completed', epoch_revision: terminal.revision, state: target.state, current_sub_state: null }
    },
  }))
}
