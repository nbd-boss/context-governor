import { ContextQuery } from './context-query.ts'
import { CONTEXT_SWITCH_NOTE_GUIDANCE, CONTINUATION_RECOVERY_GUIDANCE, DECISION_CHECK_USAGE, DECISION_CHECKS, EXACT_DATA_TRANSFER_GUIDANCE, PRIOR_WORK_RETRIEVAL_POLICY } from '../agent-guidance.ts'
import type { SessionWorkspace } from '../workspace/session-workspace.ts'

export interface ResidentContext {
  payload: Record<string, unknown>
  text: string
}

/** Build the durable resident view and optional transition note; neither is written back. */
export async function buildResidentContext(
  workspace: SessionWorkspace,
  sessionId: string,
  switchReason?: string,
): Promise<ResidentContext | undefined> {
  const state = await workspace.state.read()
  if (state === undefined) return undefined
  const query = new ContextQuery({ state, sub_states: await workspace.sub_states.readAll(), artifacts: await workspace.artifacts.readAll() })
  const currentSubState = query.currentRuntimeSubState() ?? null
  const switchNote = switchReason?.trim() || undefined
  const continuation = currentSubState?.current_sub_step?.continuation
  const recoveryGuidance = continuation === undefined || continuation === null ? '' : `\n${CONTINUATION_RECOVERY_GUIDANCE}`
  const switchGuidance = switchNote === undefined ? '' : `\n${CONTEXT_SWITCH_NOTE_GUIDANCE}`
  const stepInstruction = currentSubState === null
    ? 'The active Step has no SubState yet. Inspect only the evidence needed to establish criteria, then call plan_current_step before executing or completing a SubStep.'
    : 'The current SubState owns this Step\'s criteria and completed/current/pending SubStep plan. Complete only the current SubStep; Governor activates the next pending item.'
  const payload: Record<string, unknown> = {
    context_governor: {
      instruction: `This is the durable snapshot at the start of this Context Epoch. State is task-level authority. ${stepInstruction} Successful Governor tools immediately persist changes; their latest returned State revision supersedes this Epoch-start snapshot until switch_context reloads it. user_constraints are direct human requirements; discovered_constraints are evidence-linked runtime boundaries.\n${DECISION_CHECK_USAGE}${recoveryGuidance}${switchGuidance}`,
      session_id: sessionId,
      state: query.state(),
      current_sub_state: currentSubState,
      ...(switchNote === undefined ? {} : { switch_note: switchNote }),
      retrieval_policy: PRIOR_WORK_RETRIEVAL_POLICY,
      exact_data_transfer_policy: EXACT_DATA_TRANSFER_GUIDANCE,
      decision_checks: DECISION_CHECKS,
    },
  }
  const text = JSON.stringify(payload, null, 2)
  return { payload, text }
}
