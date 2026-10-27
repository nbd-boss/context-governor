import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { replanTaskCriteria, type StepChange } from '../planning/step-plan.ts'
import { validateContextState } from '../state/state-contract.ts'
import { replanStepCriteria, type ReplanStepCriteriaInput } from '../epoch/epoch-projection.ts'
import type { WorkspaceMutations } from '../workspace/workspace-mutations.ts'
import { stepChangeSchema, replannedSubStepChangeSchema, stateOutputSchema, nullableSubStateOutputSchema } from './tool-schemas.ts'
import { CRITERIA_REPLAN_GUIDANCE } from '../agent-guidance.ts'

const output = {
  schema: { type: 'object' as const, additionalProperties: false, properties: {
    status: { type: 'string' as const, required: true },
    state_revision: { type: 'integer' as const, required: true },
    state: stateOutputSchema,
    current_sub_state: nullableSubStateOutputSchema,
  } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

function evidence(value: unknown, events: readonly { seq: number }[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !/^event-(0|[1-9]\d*)$/.test(id))) {
    throw new Error('source_events must contain current-Session event-N evidence')
  }
  if (value.some(id => !events.some(event => event.seq === Number(id.slice(6))))) {
    throw new Error('source_events must reference current-Session events')
  }
}

function result(snapshot: import('../workspace/workspace-validator.ts').WorkspaceSnapshot) {
  const active = snapshot.state.task_plan.steps.find(step => step.status === 'in_progress')
  return {
    status: 'committed', state_revision: snapshot.state.revision, state: snapshot.state,
    current_sub_state: snapshot.sub_states.find(item => item.step_id === active?.step_id) ?? null,
  }
}

/** Replan current acceptance criteria together with their not-yet-started work. */
export function registerCriteriaReplanTools(ctx: Context, mutations: WorkspaceMutations): void {
  ctx.tools.register(defineTool({
    name: 'replan_task_criteria',
    description: [
      'Revise task-level acceptance criteria under the shared criteria-replanning policy below. Keep existing criterion indexes and done/active Steps immutable. Supersede old indexes, append new criteria, and supply affected Step changes using the same add/update/delete operations as revise_step. changes may be [] if no plan edit is needed. Governor applies all changes in memory, validates final coverage, and commits once. Newly appended criteria start at the old completion_criteria.length.',
      CRITERIA_REPLAN_GUIDANCE,
    ].join('\n\n'),
    parameters: {
      source_events: { type: 'array', required: true, items: { type: 'string' } },
      expected_state_revision: { type: 'integer', required: true },
      supersede_criterion_indexes: { type: 'array', required: true, items: { type: 'integer' } },
      add_criteria: { type: 'array', required: true, items: { type: 'string' } },
      changes: { type: 'array', required: true, items: stepChangeSchema },
    },
    output,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('replan_task_criteria requires an active Session')
      evidence(args.source_events, exec.agent.session.snapshotEvents())
      const snapshot = await mutations.apply(exec.agent.session.id, args.expected_state_revision as number, base => ({
        ...base,
        state: validateContextState({ ...base.state, task_plan: replanTaskCriteria(base.state.task_plan, {
          supersede: args.supersede_criterion_indexes as number[],
          add: args.add_criteria as string[],
          changes: args.changes as StepChange[],
        }) }),
      }))
      return result(snapshot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'replan_step_criteria',
    description: [
      'Revise the active planned Step acceptance criteria under the shared criteria-replanning policy below. Keep completed and current SubSteps unchanged. Supersede old criterion IDs, append new criteria, and supply affected SubStep changes using the same add/update/delete operations as revise_substep. For add/update here, covers_criterion_indexes refer to existing criteria followed by add_criteria. changes may be [] if no plan edit is needed. Governor applies the shared edits in memory, validates final coverage, and commits once; completed history is never rewritten.',
      CRITERIA_REPLAN_GUIDANCE,
    ].join('\n\n'),
    parameters: {
      source_events: { type: 'array', required: true, items: { type: 'string' } },
      expected_state_revision: { type: 'integer', required: true },
      step_id: { type: 'string', required: true },
      expected_current_sub_step_id: { type: 'string', required: true },
      supersede_criterion_ids: { type: 'array', required: true, items: { type: 'string' } },
      add_criteria: { type: 'array', required: true, items: { type: 'string' } },
      changes: { type: 'array', required: true, items: replannedSubStepChangeSchema },
    },
    output,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('replan_step_criteria requires an active Session')
      evidence(args.source_events, exec.agent.session.snapshotEvents())
      const snapshot = await mutations.apply(exec.agent.session.id, args.expected_state_revision as number, base => replanStepCriteria(base, {
        step_id: args.step_id as string,
        expected_current_sub_step_id: args.expected_current_sub_step_id as string,
        supersede: args.supersede_criterion_ids as string[],
        add: args.add_criteria as string[],
        changes: (args.changes as Array<Record<string, unknown>>).map(item => {
          const { covers_criterion_indexes, ...change } = item
          return item.operation === 'delete' ? item : { ...change, covers: covers_criterion_indexes }
        }) as ReplanStepCriteriaInput['changes'],
      }))
      return result(snapshot)
    },
  }))
}
