import { ContextQuery } from './context-query.ts'
import { CONTINUATION_RECOVERY_GUIDANCE, PRIOR_WORK_RETRIEVAL_POLICY } from '../agent-guidance.ts'
import type { SessionWorkspace } from '../workspace/session-workspace.ts'

export interface ResidentContext {
  payload: Record<string, unknown>
  text: string
}

/** Build only the durable target resident view; no index is written to disk. */
export async function buildResidentContext(
  workspace: SessionWorkspace,
  sessionId: string,
): Promise<ResidentContext | undefined> {
  const state = await workspace.state.read()
  if (state === undefined) return undefined
  const query = new ContextQuery({ state, sub_states: await workspace.sub_states.readAll(), artifacts: await workspace.artifacts.readAll() })
  const currentSubState = query.currentRuntimeSubState() ?? null
  const continuation = currentSubState?.current_sub_step?.continuation
  const recoveryGuidance = continuation === undefined || continuation === null ? '' : ` ${CONTINUATION_RECOVERY_GUIDANCE}`
  const payload: Record<string, unknown> = {
    context_governor: {
      instruction: `This baseline matches persistent State and SubStates. State is task-level authority. The current SubState owns the Step criteria and completed/current/pending SubStep plan. Complete only the current SubStep; Governor activates the next pending item. Deltas are in memory until switch_context or advance_task_progress complete_task succeeds. user_constraints are direct human requirements; discovered_constraints are evidence-linked runtime boundaries.${recoveryGuidance}`,
      session_id: sessionId,
      state: query.state(),
      global_step_navigation: query.globalNavigation(),
      current_sub_state: currentSubState,
      retrieval_policy: PRIOR_WORK_RETRIEVAL_POLICY,
    },
  }
  const text = JSON.stringify(payload, null, 2)
  return { payload, text }
}
