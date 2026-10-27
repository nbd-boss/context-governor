import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTEXT_CLOSING_GUIDANCE, SWITCH_RECONCILIATION_GUIDANCE } from '../src/agent-guidance.ts'
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

test('pressure reminder permits local settlement or an unplanned Step handoff before switching', () => {
  const decision = assessPressure({
    contextWindow: 100_000,
    currentTokens: 80_000,
    pendingMessageTokens: 0,
  }, 0.8)
  const reminder = renderSwitchReminder(decision, 100_000)
  assert.match(reminder, /80000 \/ 100000 tokens/)
  assert.ok(reminder.includes(CONTEXT_CLOSING_GUIDANCE))
  assert.ok(reminder.includes(SWITCH_RECONCILIATION_GUIDANCE))
})
