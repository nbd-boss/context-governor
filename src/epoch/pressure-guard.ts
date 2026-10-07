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
    '停止新的外部查询、任务动作，以及 History、Artifact 和工作区文件读取。只能使用受限的本地写入工具，把本 Epoch 已经返回的结果写入任务产物或中间产物。',
    '已查询不等于已处理，已处理不等于已保存。只有所有必需结果都已整合，才能把对应 SubStep 标记为完成。',
    '若已完成工作产生了切换后仍需精确使用的结构化数据，先按 register_artifact 的规则登记，再记录该 SubStep。',
    '完成收尾后，用 advance_task_progress 记录已完成进展，再调用 switch_context；若无法完整收尾，保持当前 SubStep 未完成并直接切换，让下一 Epoch 继续它。',
    '若任务已经完成，调用 advance_task_progress 的 complete_task。',
  ].join('\n')
}
