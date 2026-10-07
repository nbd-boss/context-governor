/** Small boundary shared by lifecycle and read tools; it contains no storage details. */
export interface SubStepAuditChange {
  operation: 'create' | 'update'
  step: string
  sub_step_id: string
  sub_step: string
}

export interface AuditRead {
  kind: 'sub_state' | 'artifact' | 'event' | 'event_range'
  target: string
}

export interface ContextAuditSink {
  startEpoch(input: {
    sessionId: string
    baselineEvent: string
    residentTokens: number
  }): Promise<void>
  closeEpoch(input: {
    sessionId: string
    reason: string
    endEvent: string
    stateChanged: boolean
    subStepChanges: SubStepAuditChange[]
    pressure?: { currentTokens: number; contextWindow: number; thresholdTokens: number }
  }): Promise<void>
  completeEpoch(input: {
    sessionId: string
    reason: string
    endEvent: string
    stateChanged: boolean
    subStepChanges: SubStepAuditChange[]
    pressure?: { currentTokens: number; contextWindow: number; thresholdTokens: number }
  }): Promise<void>
  recordRead(sessionId: string, read: AuditRead): Promise<void>
}
