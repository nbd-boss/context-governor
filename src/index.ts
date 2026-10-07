/**
 * Context Governor plugin for the DSH experiment.
 *
 * It owns Context State bootstrap, Epoch boundaries, and durable State,
 * SubState, and Artifact records while DSH retains raw Session History.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-subagent'
// The plugin lives beside, rather than inside, the DSH checkout. Resolve the
// runtime schema module through that checkout so the DSH loader can load it.
import Schema from '../../deepseek-harness/vendor/schemastery/src/index.ts'

import { HistoryIndex } from './evidence/history-index.ts'
import { registerHistoryTools } from './tools/history-tools.ts'
import { registerStateTools } from './tools/state-tools.ts'
import { registerSubStateTools } from './tools/sub-state-tools.ts'
import { EpochController } from './epoch/epoch-controller.ts'
import { registerSwitchContextTool } from './tools/switch-context-tool.ts'
import { registerAdvanceTaskProgressTool } from './tools/advance-task-progress-tool.ts'
import { EpochDeltaBuffer } from './epoch/epoch-delta-buffer.ts'
import { registerAuditTools } from './tools/audit-tools.ts'
import { SessionWorkspaceProvider } from './workspace/session-workspace.ts'
import { installBootstrapGate } from './epoch/bootstrap-gate.ts'
import { installTransitionGate } from './epoch/transition-gate.ts'
import { registerArtifactTools } from './tools/artifact-tools.ts'
import { registerArtifactReadTool } from './tools/artifact-read-tool.ts'
import { registerStateDeltaTools } from './tools/state-delta-tools.ts'
import { registerRecordEpochContinuationTool } from './tools/record-epoch-continuation-tool.ts'
import { registerReplacePendingSubStepPlanTool } from './tools/replace-pending-sub-step-plan-tool.ts'

export interface Config {
  enabled: boolean
  residentTokenBudget: number
  switchThresholdRatio: number
  workspaceDirectory: string
}

/** Configuration exposed through DSH's plugin overlay. */
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  residentTokenBudget: Schema.number().step(1).min(1).default(6000),
  switchThresholdRatio: Schema.number().min(0.01).max(0.99).default(0.8),
  workspaceDirectory: Schema.string().default('.context-governor'),
})

/** Stable loader name for the local Context Governor plugin. */
export const name = 'context-governor'

/** Require durable Session support before registering Context lifecycle hooks. */
export const inject = ['sessions', 'tools', 'tokenMeter', 'sessionProjections', 'subagents']

/**
 * Register Context lifecycle hooks, State boundaries, and read-only retrieval.
 * @param ctx - DSH's shared plugin context.
 * @param config - Governor configuration loaded from the plugin overlay.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return

  const historyIndex = new HistoryIndex()
  const rebuild = (session: { id: string; snapshotEvents(): readonly { seq: number; type: string }[] }) => {
    historyIndex.rebuild(session.id, session.snapshotEvents())
  }

  // A resumed Session carries its existing raw trace as seed events, which do
  // not re-emit through session/event. Rebuild at its creation boundary, then
  // append only genuinely new events.
  ctx.on('session/created', rebuild)
  for (const session of ctx.sessions.list()) rebuild(session)
  ctx.on('session/event', (session, event) => {
    historyIndex.append(session.id, event)
  })

  const workspaces = new SessionWorkspaceProvider(config.workspaceDirectory)
  registerHistoryTools(ctx, historyIndex, workspaces)
  console.log('[context-governor] phase 2 History index and read-only tools loaded')

  registerStateTools(ctx, workspaces)
  console.log('[context-governor] phase 3 State bootstrap tool loaded')
  installBootstrapGate(ctx, workspaces)
  console.log('[context-governor] bootstrap gate loaded')
  const epochDeltas = new EpochDeltaBuffer()

  registerSubStateTools(ctx, workspaces)
  console.log('[context-governor] phase 3 SubState retrieval tool loaded')

  const epochs = new EpochController(
    workspaces,
    config.residentTokenBudget,
    config.switchThresholdRatio,
  )
  epochs.install(ctx)
  installTransitionGate(ctx, workspaces, sessionId => epochs.requiresTransition(sessionId))
  registerAdvanceTaskProgressTool(ctx, workspaces, epochs, epochDeltas)
  registerRecordEpochContinuationTool(ctx, workspaces, epochDeltas)
  registerReplacePendingSubStepPlanTool(ctx, workspaces, epochDeltas)
  registerStateDeltaTools(ctx, workspaces, epochDeltas)
  registerArtifactTools(ctx, workspaces, epochDeltas)
  registerArtifactReadTool(ctx, workspaces)
  registerSwitchContextTool(ctx, workspaces, epochs, epochDeltas)
  console.log('[context-governor] phase 4 Context Epoch controller and transition gate loaded')
  registerAuditTools(ctx, workspaces)
  console.log('[context-governor] phase 5 audit recorder and read-only audit tool loaded')
}
