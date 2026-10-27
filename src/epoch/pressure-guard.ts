import { CONTEXT_CLOSING_GUIDANCE } from '../agent-guidance.ts'

/** Pure policy for deciding whether the next request needs a Context switch reminder. */
export interface PressureSnapshot {
  contextWindow: number
  currentTokens: number
  pendingMessageTokens: number
}

export interface PressureDecision {
  thresholdTokens: number
  projectedTokens: number
  shouldRemind: boolean
}

/**
 * Reserve a fixed fraction of the model window before every request. The
 * reserve is intentionally not a "recent History" budget: it protects model
 * output, tool calls, envelope changes, and estimation variance.
 */
export function assessPressure(snapshot: PressureSnapshot, switchThresholdRatio: number): PressureDecision {
  if (!Number.isFinite(switchThresholdRatio) || switchThresholdRatio <= 0 || switchThresholdRatio >= 1) {
    throw new Error('switchThresholdRatio must be between 0 and 1')
  }
  const thresholdTokens = Math.floor(snapshot.contextWindow * switchThresholdRatio)
  const projectedTokens = Math.max(0, snapshot.currentTokens + snapshot.pendingMessageTokens)
  return { thresholdTokens, projectedTokens, shouldRemind: projectedTokens >= thresholdTokens }
}

export function renderSwitchReminder(decision: PressureDecision, contextWindow: number): string {
  return [
    '[Context Governor: 进入切换前收尾]',
    `下一次请求预计使用 ${String(decision.projectedTokens)} / ${String(contextWindow)} tokens，已达到 ${String(decision.thresholdTokens)} 的安全线。`,
    CONTEXT_CLOSING_GUIDANCE,
  ].join('\n')
}
