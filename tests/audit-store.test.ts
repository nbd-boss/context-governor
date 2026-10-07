import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AuditStore } from '../src/evidence/audit-store.ts'
import { AuditRecorder } from '../src/evidence/audit-recorder.ts'

test('audit records stay per-Epoch and contain retrieval metadata, not raw History', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-audit-'))
  try {
    const audits = new AuditRecorder(new AuditStore(directory))
    await audits.startEpoch({ sessionId: 'session-a', baselineEvent: 'event-12', residentTokens: 456 })
    await audits.recordRead('session-a', { kind: 'sub_step_index', target: '定位根因' })
    await audits.recordRead('session-a', { kind: 'event_range', target: 'event-7..event-10' })
    await audits.closeEpoch({
      sessionId: 'session-a', reason: '阶段结论已确认', endEvent: 'event-20', stateChanged: true,
      subStepChanges: [{ operation: 'create', step: '定位根因', sub_step_id: 'sub-step-1', sub_step: '追踪调用链' }],
      pressure: { currentTokens: 8000, contextWindow: 12000, thresholdTokens: 9600 },
    })
    await audits.startEpoch({ sessionId: 'session-a', baselineEvent: 'event-24', residentTokens: 402 })

    const records = await audits.list('session-a')
    assert.equal(records.length, 2)
    assert.deepEqual(records[0]?.reads, [
      { kind: 'sub_step_index', target: '定位根因' },
      { kind: 'event_range', target: 'event-7..event-10' },
    ])
    assert.equal(records[0]?.switch?.end_event, 'event-20')
    assert.equal(records[0]?.switch?.pressure?.thresholdTokens, 9600)
    assert.equal(records[1]?.baseline_event, 'event-24')
    assert.equal(JSON.stringify(records).includes('raw History'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a completion closes an Epoch without allowing another one to open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-governor-audit-'))
  try {
    const audits = new AuditRecorder(new AuditStore(directory))
    await audits.startEpoch({ sessionId: 'session-complete', baselineEvent: 'event-3', residentTokens: 123 })
    await audits.completeEpoch({
      sessionId: 'session-complete', reason: 'All checks pass.', endEvent: 'event-9', stateChanged: true, subStepChanges: [],
    })
    await audits.startEpoch({ sessionId: 'session-complete', baselineEvent: 'event-10', residentTokens: 456 })
    const records = await audits.list('session-complete')
    assert.equal(records.length, 1)
    assert.equal(records[0]?.completion?.end_event, 'event-9')
    assert.equal(records[0]?.switch, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
