import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../../deepseek-harness/packages/core/tools/src/index.ts'

import { formatDecisionCheck } from '../agent-guidance.ts'
import type { EpochController } from '../epoch/epoch-controller.ts'
import { advanceStep, advanceSubStep } from '../epoch/epoch-projection.ts'
import type { WorkspaceMutations } from '../workspace/workspace-mutations.ts'
import { criterionEvidenceEventIds, validateCriterionEvidence, type ArtifactRef, type CriterionEvidence } from '../state/sub-state-contract.ts'
import { stateOutputSchema, nullableSubStateOutputSchema } from './tool-schemas.ts'
import { requireSessionEventIds } from './session-evidence.ts'
import type { TaskPlan } from '../planning/step-plan.ts'

const completedSchema = {
  type: 'object' as const, required: true, additionalProperties: false,
  properties: {
    summary: { type: 'string' as const, required: true },
    criterion_evidence: {
      type: 'array' as const, required: true,
      items: {
        type: 'object' as const, additionalProperties: false,
        properties: {
          criterion_id: { type: 'string' as const, required: true },
          source_events: { type: 'array' as const, required: true, items: { type: 'string' as const } },
        },
      },
    },
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

const transitionSchema = {
  oneOf: [
    { type: 'object' as const, additionalProperties: false, properties: {
      type: { type: 'string' as const, required: true, enum: ['advance_sub_step'] },
      ...identityProperties,
    } },
    { type: 'object' as const, additionalProperties: false, properties: {
      type: { type: 'string' as const, required: true, enum: ['advance_step'] },
      ...identityProperties,
      next_step: {
        type: 'object' as const, required: true, additionalProperties: false,
        properties: { step_id: { type: 'string' as const, required: true } },
      },
    } },
    { type: 'object' as const, additionalProperties: false, properties: {
      type: { type: 'string' as const, required: true, enum: ['complete_task'] },
      ...identityProperties,
      task_criteria_check: {
        type: 'array' as const, required: true,
        description: 'Check every effective State.task_plan.completion_criteria entry by its original zero-based index; omit superseded indexes. Only all-met checks permit completion. These checks supplement, not replace, completed.criterion_evidence for the current SubStep.',
        items: {
          type: 'object' as const, additionalProperties: false,
          properties: {
            criterion_index: { type: 'integer' as const, required: true },
            outcome: { type: 'string' as const, required: true, enum: ['met', 'unmet', 'unverified'] },
            source_events: { type: 'array' as const, required: true, items: { type: 'string' as const } },
          },
        },
      },
    } },
  ],
} as const

interface TaskCriterionCheck {
  criterion_index: number
  outcome: 'met' | 'unmet' | 'unverified'
  source_events: string[]
}

/** Check terminal declarations against the current plan, not their business truth. */
function requireTaskCriteriaMet(checks: readonly TaskCriterionCheck[], plan: TaskPlan, events: readonly { seq: number }[]): void {
  const effective = new Set(plan.completion_criteria.map((_, index) => index).filter(index => !plan.superseded_criteria.includes(index)))
  const seen = new Set<number>()
  const unresolved: string[] = []
  for (const [index, check] of checks.entries()) {
    const field = `transition.task_criteria_check[${String(index)}]`
    if (!effective.has(check.criterion_index)) throw new Error(`${field}.criterion_index must identify an effective task_plan.completion_criteria entry`)
    if (seen.has(check.criterion_index)) throw new Error(`transition.task_criteria_check contains duplicate criterion_index: ${String(check.criterion_index)}`)
    seen.add(check.criterion_index)
    requireSessionEventIds(check.source_events, events, `${field}.source_events`)
    if (check.outcome !== 'met') unresolved.push(`task_plan.completion_criteria[${String(check.criterion_index)}] (${check.outcome})`)
  }
  const missing = [...effective].filter(index => !seen.has(index))
  if (missing.length > 0) throw new Error(`transition.task_criteria_check is missing effective criterion indexes: ${missing.join(', ')}`)
  if (unresolved.length > 0) {
    throw new Error(`Cannot complete task; required outcomes remain unresolved: ${unresolved.join(', ')}. Keep affected work active, preserve reusable progress with record_continuation when applicable, and report unresolved blockers instead of claiming completion.`)
  }
}

export const ADVANCE_TASK_PROGRESS_DESCRIPTION = [
  'Advance exactly one completed current SubStep through the task lifecycle.',
  'Use advance_sub_step when the current Step still has planned pending_sub_steps; Governor activates the first pending item automatically.',
  'Use advance_step only after the current Step passes context_governor.decision_checks.before_completion, has no pending_sub_steps, and another pending top-level Step exists. Only advance_step takes next_step.step_id; the next Step starts without a SubState, so inspect relevant evidence and call plan_current_step before executing it.',
  'Use complete_task only for the final active Step when neither pending SubSteps nor pending top-level Steps remain and every effective task-level completion criterion is met. Finishing the plan is necessary but does not itself prove task completion. It atomically persists the terminal State and ends the turn.',
  'Only complete_task requires transition.task_criteria_check: submit exactly one entry for each effective State.task_plan.completion_criteria index, excluding superseded_criteria. Each entry gives criterion_index, outcome (met, unmet, or unverified), and non-empty original source_events. Check the actual task-level result, not merely whether a child Step, investigation, or report finished; a documented obstacle does not waive a required outcome. Any unmet or unverified entry rejects completion without committing progress. Other transition types must not include task_criteria_check.',
  'Governor checks declarations, coverage, and event references, not business truth; claim met only when the evidence actually establishes that task criterion. Checks remain in the original tool-call History, not in a second persistent State or SubState ledger.',
  'Each successful progress call atomically persists the new State, SubState, and any produced Artifacts.',
  'Before advance_step or complete_task, every registered Artifact must have been committed as produced by a completed SubStep, including Artifacts produced by this call. A rejected handoff leaves the current Step and SubStep unchanged; repair the listed references or evidence and retry.',
  'Identify current work by step_id and expected_sub_step_id. completed.summary must state one confirmed reusable conclusion. completed.criterion_evidence must provide current-Session event-N evidence for every criterion covered by the current SubStep; use the exact criterion_id values in current_sub_state. Always supply artifact_refs; use [] when none.',
  formatDecisionCheck('before_completion'),
].join('\n\n')

type TransitionCommon = {
  step_id: string
  expected_sub_step_id: string
  completed: { summary: string; criterion_evidence: unknown; artifact_refs: unknown }
}

type TransitionArgs = TransitionCommon & (
  | { type: 'advance_sub_step' }
  | { type: 'advance_step'; next_step: { step_id: string } }
  | { type: 'complete_task'; task_criteria_check: TaskCriterionCheck[] }
)

function sourceEventsExist(value: unknown, events: readonly { seq: number }[]): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !/^event-(0|[1-9]\d*)$/.test(id))) {
    throw new Error('completed.criterion_evidence must contain one or more event-N identifiers')
  }
  if (value.some(id => !events.some(event => event.seq === Number(id.slice('event-'.length))))) {
    throw new Error('completed.criterion_evidence must reference events in the current Session')
  }
}

/** The sole Agent-facing authority for SubStep, Step, and terminal task progress. */
export function registerAdvanceTaskProgressTool(
  ctx: Context,
  epochs: EpochController,
  mutations: WorkspaceMutations,
): void {
  ctx.tools.register(defineTool({
    name: 'advance_task_progress',
    description: ADVANCE_TASK_PROGRESS_DESCRIPTION,
    parameters: {
      expected_state_revision: { type: 'integer', required: true },
      transition: { ...transitionSchema, required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        state_revision: { type: 'integer', required: true },
        state: stateOutputSchema,
        current_sub_state: nullableSubStateOutputSchema,
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('advance_task_progress requires an active Session.')
      const sessionId = exec.agent.session.id
      const transition = args.transition as TransitionArgs
      const events = exec.agent.session.snapshotEvents()
      const target = await mutations.apply(sessionId, args.expected_state_revision as number, (base, pending) => {
        const active = base.state.task_plan.steps.find(step => step.status === 'in_progress')
        const subState = base.sub_states.find(item => item.step_id === active?.step_id)
        const current = subState?.current_sub_step
        if (active?.step_id !== transition.step_id || current?.sub_step_id !== transition.expected_sub_step_id) {
          throw new Error('step_id and expected_sub_step_id must identify the current SubStep')
        }
        if (transition.type === 'complete_task') requireTaskCriteriaMet(transition.task_criteria_check, base.state.task_plan, events)
        const criterionEvidence = validateCriterionEvidence(
          transition.completed.criterion_evidence, current.covers, 'completed.criterion_evidence',
        )
        sourceEventsExist(criterionEvidenceEventIds(criterionEvidence), events)
        if (!Array.isArray(transition.completed.artifact_refs)) throw new Error('completed.artifact_refs must be an array')
        const completed = {
          summary: transition.completed.summary,
          criterion_evidence: criterionEvidence as CriterionEvidence[],
          artifact_refs: transition.completed.artifact_refs as ArtifactRef[],
        }
        const introduced_artifacts = mutations.producedArtifacts(pending, completed.artifact_refs, criterionEvidence)
        const common = { step_id: transition.step_id, expected_sub_step_id: transition.expected_sub_step_id, completed, introduced_artifacts }
        if (transition.type === 'advance_sub_step') return advanceSubStep(base, common)
        if (transition.type === 'advance_step') {
          mutations.requireArtifactHandoff(pending, introduced_artifacts, 'ending the current Step')
          return advanceStep(base, { ...common, next_step: { step_id: transition.next_step.step_id } })
        }
        if (base.state.task_plan.steps.some(step => step.status === 'pending')) {
          throw new Error('complete_task requires the final active Step with no pending top-level Steps')
        }
        mutations.requireArtifactHandoff(pending, introduced_artifacts, 'completing the task')
        const finished = advanceStep(base, { ...common, next_step: null })
        return { ...finished, state: { ...finished.state, lifecycle: { status: 'completed' } } }
      })
      if (transition.type === 'complete_task') {
        await epochs.complete(exec.agent, transition.completed.summary, { stateChanged: true, subStepChanges: [] })
        exec.concludeTurn()
        return { status: 'completed', state_revision: target.state.revision, state: target.state, current_sub_state: null }
      }
      const active = target.state.task_plan.steps.find(step => step.status === 'in_progress')
      return {
        status: 'committed', state_revision: target.state.revision, state: target.state,
        current_sub_state: target.sub_states.find(item => item.step_id === active?.step_id) ?? null,
      }
    },
  }))
}
