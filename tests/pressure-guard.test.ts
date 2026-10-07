import assert from 'node:assert/strict'
import test from 'node:test'

import { assessPressure, renderSwitchReminder } from '../src/epoch/pressure-guard.ts'

test('reserves 20 percent of the model window at the default switch threshold', () => {
  assert.deepEqual(assessPressure({
    contextWindow: 1_000_000,
    currentTokens: 790_000,
    pendingMessageTokens: 10_000,
  }, 0.8), {
    thresholdTokens: 800_000,
    projectedTokens: 800_000,
    shouldRemind: true,
  })
})

test('counts the pending user message before deciding whether to remind', () => {
  assert.equal(assessPressure({
    contextWindow: 100_000,
    currentTokens: 79_500,
    pendingMessageTokens: 600,
  }, 0.8).shouldRemind, true)
})

test('pressure reminder requires local settlement or an active SubStep before switching', () => {
  const decision = assessPressure({
    contextWindow: 100_000,
    currentTokens: 80_000,
    pendingMessageTokens: 0,
  }, 0.8)
  const reminder = renderSwitchReminder(decision, 100_000)
  assert.match(reminder, /停止新的外部查询/)
  assert.match(reminder, /工作区文件读取/)
  assert.match(reminder, /已查询不等于已处理，已处理不等于已保存/)
  assert.match(reminder, /保持当前 SubStep 未完成/)
})
