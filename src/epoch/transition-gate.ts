import type { Context } from '@deepseek-ai/cordis'

import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'

/**
 * A pressure-triggered Epoch is in closing mode, not ordinary work mode.
 * These tools can describe or commit work already present in the Context.
 */
const CLOSING_GOVERNOR_TOOLS = new Set([
  'list_recent_tool_results',
  'register_artifact',
  'advance_task_progress',
  'record_epoch_continuation',
  'switch_context',
])

/** Only materialize results that are already visible; never pull more content into a closing Epoch. */
const CLOSING_MATERIALIZATION_TOOLS = new Set([
  'mcp__filesystem__create_directory',
  'mcp__filesystem__edit_file',
  'mcp__filesystem__write_file',
])

export const TRANSITION_REQUIRED_MESSAGE = [
  'Context Governor requires a Context transition before further task work.',
  'This Epoch is now in strict closing mode: do not start another external query, task action, History read, Artifact read, or workspace file read.',
  'You may create, write, or edit a local file only to materialize results already visible in this Context; do not read a file to obtain more input.',
  'A returned tool result is not completed work until every required fact has been integrated into the task output or an intermediate artifact.',
  'If completed work produced exact structured data needed after the switch, apply the register_artifact policy before recording that SubStep.',
  'Then record any completed progress with advance_task_progress and call switch_context.',
  'If the current SubStep remains incomplete but has reusable progress in real workspace files, record it with record_epoch_continuation before switching.',
  'If no reusable progress exists, do not mark the current SubStep complete or invent a Continuation; switch with the current SubStep still active and recover from raw History only in the next Epoch.',
  'If the task is already complete, use advance_task_progress with complete_task.',
].join(' ')

/** Pure policy so strict closing behavior remains independently testable. */
export function transitionAllowsTool(toolName: string, transitionRequired: boolean, switchPending = false): boolean {
  if (!transitionRequired) return true
  if (switchPending) return CLOSING_GOVERNOR_TOOLS.has(toolName)
  return CLOSING_GOVERNOR_TOOLS.has(toolName) || CLOSING_MATERIALIZATION_TOOLS.has(toolName)
}

/**
 * Enforce the overflow fallback without fabricating a State summary. The Agent
 * still owns the State/SubStep payload; this gate only prevents further ordinary
 * work until it commits a switch or terminal completion.
 */
export function installTransitionGate(
  ctx: Context,
  workspaces: SessionWorkspaceProvider,
  isTransitionRequired: (sessionId: string) => boolean,
): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent === undefined) return await next()
    const required = isTransitionRequired(exec.agent.session.id)
    if (transitionAllowsTool(exec.name, required)) return await next()
    return { kind: 'deny', reason: TRANSITION_REQUIRED_MESSAGE }
  })
}
