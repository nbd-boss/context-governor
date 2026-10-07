import type { AuditRead, ContextAuditSink, SubStepAuditChange } from './audit-contract.ts'
import { AuditStore, type EpochAuditRecord } from './audit-store.ts'

/** Serializes file mutations per Session while exposing the small audit boundary. */
export class AuditRecorder implements ContextAuditSink {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly store: AuditStore) {}

  startEpoch(input: { sessionId: string; baselineEvent: string; residentTokens: number }): Promise<void> {
    return this.enqueue(input.sessionId, () => this.store.start(input.sessionId, input.baselineEvent, input.residentTokens))
  }

  closeEpoch(input: { sessionId: string; reason: string; endEvent: string; stateChanged: boolean; subStepChanges: SubStepAuditChange[]; pressure?: { currentTokens: number; contextWindow: number; thresholdTokens: number } }): Promise<void> {
    return this.enqueue(input.sessionId, () => this.store.close(input.sessionId, input.reason, input.endEvent, input.stateChanged, input.subStepChanges, input.pressure))
  }

  completeEpoch(input: { sessionId: string; reason: string; endEvent: string; stateChanged: boolean; subStepChanges: SubStepAuditChange[]; pressure?: { currentTokens: number; contextWindow: number; thresholdTokens: number } }): Promise<void> {
    return this.enqueue(input.sessionId, () => this.store.complete(input.sessionId, input.reason, input.endEvent, input.stateChanged, input.subStepChanges, input.pressure))
  }

  recordRead(sessionId: string, read: AuditRead): Promise<void> {
    return this.enqueue(sessionId, () => this.store.appendRead(sessionId, read))
  }

  async list(sessionId: string): Promise<EpochAuditRecord[]> {
    await this.queues.get(sessionId)
    return this.store.list(sessionId)
  }

  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.queues.set(sessionId, next)
    return next
  }
}
