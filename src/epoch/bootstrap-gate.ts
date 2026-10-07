import type { Context } from '@deepseek-ai/cordis'

import { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'

/** Read-only Governor navigation remains safe before task State exists. */
const BOOTSTRAP_ALLOWED_TOOLS = new Set([
  'initialize_context_state',
])

export const BOOTSTRAP_REQUIRED_MESSAGE = [
  'Context Governor is enabled, but this Session has no Context State yet.',
  'Before using Canvas, filesystem, terminal, or any other task tool, call initialize_context_state.',
  'Use the user request to provide a concise mission, complete task-level acceptance criteria with an ordered result-first task_plan, the first Step complete current_step_plan, and explicit user_constraints.',
  'After it succeeds, retry this same tool call.',
].join(' ')

/** Pure policy so the bootstrap boundary stays independently testable. */
export function bootstrapAllowsTool(toolName: string, hasState: boolean): boolean {
  return hasState || BOOTSTRAP_ALLOWED_TOOLS.has(toolName)
}

/**
 * Make Context Governor opt-out rather than optional for each Session.
 *
 * The plugin deliberately does not invent semantic State. Instead it blocks
 * ordinary work until the model has supplied that State through the bootstrap
 * tool. The DSH tool pipeline returns the rejection to the model, which can
 * repair by initializing and retrying without losing the original task turn.
 */
export function installBootstrapGate(ctx: Context, workspaces: SessionWorkspaceProvider): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    // Only Agent-originated calls belong to a Session-managed task. Host
    // startup and test calls without an Agent must remain unaffected.
    if (exec.agent === undefined) return await next()

    const workspace = workspaces.forSession(exec.agent.session.id)
    await workspace.recover()
    const state = await workspace.state.read()
    if (bootstrapAllowsTool(exec.name, state !== undefined)) return await next()

    return { kind: 'deny', reason: BOOTSTRAP_REQUIRED_MESSAGE }
  })
}
