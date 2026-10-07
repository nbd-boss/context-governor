import type { SessionWorkspaceProvider } from './session-workspace.ts'

/** Read one recovered durable Workspace snapshot before applying Epoch Deltas. */
export async function readDurableWorkspace(workspaces: SessionWorkspaceProvider, sessionId: string) {
  const workspace = workspaces.forSession(sessionId)
  await workspace.recover()
  const state = await workspace.state.read()
  if (state === undefined) throw new Error('Context State does not exist; use initialize_context_state first.')
  return {
    state,
    sub_states: await workspace.sub_states.readAll(),
    artifacts: await workspace.artifacts.readAll(),
  }
}
