import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '../../../deepseek-harness/packages/llm/llm/src/index.ts'

import type { SubStepAuditChange } from '../evidence/audit-contract.ts'
import { BOOTSTRAP_REQUIRED_MESSAGE } from './bootstrap-gate.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import { buildResidentContext } from './resident-context.ts'
import { assessPressure, renderSwitchReminder } from './pressure-guard.ts'
import { CONTEXT_CLOSING_GUIDANCE } from '../agent-guidance.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-governor': { kind: 'context-governor' } & ContextFormed
  }
}

interface PendingSwitch {
  reason: string
  continuationQueued: boolean
}

/**
 * Owns the visible-context lifecycle while leaving the Session's raw event
 * trace append-only. A Session may contain many Epochs, but the model sees
 * exactly one stable resident prefix in each Epoch.
 */
export class EpochController {
  private readonly started = new Set<string>()
  private readonly epochStartRevision = new Map<string, number>()
  private readonly completed = new Set<string>()
  private readonly pending = new Map<string, PendingSwitch>()
  private readonly transitionRequired = new Set<string>()
  private readonly closingReminderSent = new Set<string>()
  private ctx?: Context

  constructor(
    private readonly workspaces: SessionWorkspaceProvider,
    private readonly switchThresholdRatio: number,
  ) {}

  install(ctx: Context): void {
    this.ctx = ctx
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      if (this.completed.has(agent.session.id)) return
      const pending = this.pending.get(agent.session.id)
      if (pending !== undefined) {
        if (!pending.continuationQueued) {
          pending.continuationQueued = true
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: 'A new Context Epoch is now active. Continue the task from the Context Governor baseline.' }],
            source: { kind: 'context-governor' },
          }))
        }
        return
      }
    })

    // Correct premature closure inside its owning turn. Throwing at this awaited
    // boundary preserves a durable turn error, which DSH also reports over ACP.
    // Idle notifications must never resurrect a failed model request.
    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      const sessionId = agent.session.id
      if (this.completed.has(sessionId) || this.pending.has(sessionId) || !this.transitionRequired.has(sessionId)) return
      // DSH keeps max-tokens sticky for a turn, so this hook can also run
      // after a later tool call. Only a real natural model stop is a closing
      // claim; truncation recovery and request scheduling belong to DSH.
      const response = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message' && event.data.turn === turn)
      if (response?.type !== 'assistant/message' || response.data.message.content.some(block => block.type === 'tool-call')) return
      const finish = response.data.stream.findLast(record => record.type === 'chunk' && record.chunk.type === 'finish')
      if (finish?.type !== 'chunk' || finish.chunk.type !== 'finish' || finish.chunk.reason.kind !== 'stop') return
      if (this.closingReminderSent.has(sessionId)) {
        throw new Error('Context Governor handoff incomplete: the closing reminder did not lead to switch_context or task completion. State remains active; resolve the handoff before resuming.')
      }
      this.closingReminderSent.add(sessionId)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: CONTEXT_CLOSING_GUIDANCE }],
        source: { kind: 'context-governor' },
      }))
    })

    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const sessionId = agent.session.id
      if (this.completed.has(sessionId)) return next()
      const switchRequest = this.pending.get(sessionId)
      const workspace = this.workspaces.forSession(sessionId)
      await workspace.recover()
      const effectiveSwitch = switchRequest
      const state = await workspace.state.read()
      if (state?.lifecycle.status === 'completed') {
        this.completed.add(sessionId)
        return next()
      }
      // Within an Epoch, inspect the actual outgoing Context rather than
      // rebuilding a future baseline after every durable State mutation.
      if (state !== undefined && this.started.has(sessionId) && effectiveSwitch === undefined) {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        const pressure = ctx.sessionProjections.stateOf(agent.session, 'contextPressure') as { contextWindow?: number } | null
        if (pressure?.contextWindow !== undefined) {
          const meter = ctx.tokenMeter.measure(agent.session)
          const pendingMessageTokens = decision.messages
            .reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
          const assessment = assessPressure({
            contextWindow: pressure.contextWindow,
            currentTokens: meter.totalTokens,
            pendingMessageTokens,
          }, this.switchThresholdRatio)
          if (assessment.shouldRemind && !this.transitionRequired.has(sessionId)) {
            this.transitionRequired.add(sessionId)
            const text = renderSwitchReminder(assessment, pressure.contextWindow)
            console.log(`[context-governor] Context transition required: session=${sessionId} projectedTokens=${String(assessment.projectedTokens)} thresholdTokens=${String(assessment.thresholdTokens)}`)
            return {
              ...decision,
              messages: [this.governorMessage(text, 'context-governor-pressure'), ...decision.messages],
            }
          }
        }
        return decision
      }
      const resident = await buildResidentContext(workspace, sessionId, effectiveSwitch?.reason)
      if (resident === undefined) {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        // The Governor never invents a plan, but its opt-in mode must make the
        // required bootstrap visible before the Agent begins ordinary work.
        return {
          ...decision,
          messages: [
            this.governorMessage(BOOTSTRAP_REQUIRED_MESSAGE, 'context-governor-bootstrap'),
            ...decision.messages,
          ],
        }
      }
      const residentMessage = this.governorMessage(resident.text, 'context-governor')
      const residentTokens = ctx.tokenMeter.estimateMessage(residentMessage)

      if (effectiveSwitch !== undefined) {
        this.pending.delete(sessionId)
        this.transitionRequired.delete(sessionId)
        this.closingReminderSent.delete(sessionId)
        const nodes = agent.session.surface.nodes
        const events = agent.session.snapshotEvents()
        // DSH protects its system-prompt surface node. A Context Epoch resets
        // task History only, so retain every leading system node and replace
        // the model-visible tail after the last one.
        const lastSystemIndex = nodes.reduce((last, seq, index) => (
          events[seq]?.type === 'system/message' ? index : last
        ), -1)
        const replaceableNodes = nodes.slice(lastSystemIndex + 1)
        if (replaceableNodes.length > 0) {
          agent.session.append('user/message', residentMessage, {
            surfaceOp: {
              op: 'replace',
              startSeq: replaceableNodes[0]!,
              endSeq: replaceableNodes[replaceableNodes.length - 1]!,
            },
            sourceEventSeqs: [...replaceableNodes],
          })
        } else {
          agent.session.append('user/message', residentMessage, { surfaceOp: 'append' })
        }
        this.started.add(sessionId)
        this.epochStartRevision.set(sessionId, state!.revision)
        await this.recordAudit('start recovered Context Epoch', () => workspace.audits.startEpoch({
          sessionId,
          baselineEvent: `event-${String(Math.max(-1, ...events.map(event => event.seq)) + 1)}`,
          residentTokens,
        }))
        console.log(`[context-governor] Context Epoch switched: session=${sessionId} reason=${effectiveSwitch.reason} estimatedTokens=${String(residentTokens)}`)
        return next()
      }

      const decision = await next()
      if (decision.kind === 'reject') return decision
      this.started.add(sessionId)
      this.epochStartRevision.set(sessionId, state!.revision)
      const events = agent.session.snapshotEvents()
      await this.recordAudit('start Context Epoch', () => workspace.audits.startEpoch({
        sessionId,
        baselineEvent: `event-${String(Math.max(-1, ...events.map(event => event.seq)) + 1)}`,
        residentTokens,
      }))
      return {
        ...decision,
        messages: [residentMessage, ...decision.messages],
      }
    }, { prepend: true })
  }

  async requestSwitch(
    agent: { session: Session },
    reason: string,
    changes: { stateChanged: boolean; subStepChanges: SubStepAuditChange[] },
  ): Promise<void> {
    const sessionId = agent.session.id
    const state = await this.workspaces.forSession(sessionId).state.read()
    if (this.completed.has(sessionId) || state?.lifecycle.status === 'completed') {
      throw new Error('Context task is already completed. Start a new task or Session instead.')
    }
    if (this.pending.has(sessionId)) throw new Error('A Context Epoch switch is already pending for this Session.')
    this.pending.set(sessionId, { reason, continuationQueued: false })
    const events = agent.session.snapshotEvents()
    const pressure = this.pressure(agent.session)
    await this.recordAudit('close Context Epoch', () => this.workspaces.forSession(sessionId).audits.closeEpoch({
      sessionId,
      reason,
      endEvent: `event-${String(Math.max(-1, ...events.map(event => event.seq)))}`,
      stateChanged: changes.stateChanged || state?.revision !== this.epochStartRevision.get(sessionId),
      subStepChanges: changes.subStepChanges,
      ...(pressure === undefined ? {} : { pressure }),
    }))
  }

  async complete(
    agent: { session: Session },
    reason: string,
    changes: { stateChanged: boolean; subStepChanges: SubStepAuditChange[] },
  ): Promise<void> {
    const sessionId = agent.session.id
    const events = agent.session.snapshotEvents()
    const state = await this.workspaces.forSession(sessionId).state.read()
    const pressure = this.pressure(agent.session)
    await this.recordAudit('complete Context Epoch', () => this.workspaces.forSession(sessionId).audits.completeEpoch({
      sessionId,
      reason,
      endEvent: `event-${String(Math.max(-1, ...events.map(event => event.seq)))}`,
      stateChanged: changes.stateChanged || state?.revision !== this.epochStartRevision.get(sessionId),
      subStepChanges: changes.subStepChanges,
      ...(pressure === undefined ? {} : { pressure }),
    }))
    this.pending.delete(sessionId)
    this.transitionRequired.delete(sessionId)
    this.closingReminderSent.delete(sessionId)
    this.completed.add(sessionId)
  }

  /** True after the overflow safety line until a switch or terminal completion succeeds. */
  requiresTransition(sessionId: string): boolean {
    return this.transitionRequired.has(sessionId)
  }

  private pressure(session: Session): { currentTokens: number; contextWindow: number; thresholdTokens: number } | undefined {
    const context = this.ctx
    if (context === undefined) return undefined
    const projection = context.sessionProjections.stateOf(session, 'contextPressure') as { contextWindow?: number } | null
    if (projection?.contextWindow === undefined) return undefined
    const currentTokens = context.tokenMeter.measure(session).totalTokens
    return {
      currentTokens,
      contextWindow: projection.contextWindow,
      thresholdTokens: Math.floor(projection.contextWindow * this.switchThresholdRatio),
    }
  }

  /** DSH-specific message adaptation and token accounting belong to the controller, not the resident-view builder. */
  private governorMessage(text: string, sectionName: string) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'context-governor', form: 'snapshot', sections: [{ name: sectionName, text }] },
    })
  }

  private async recordAudit(label: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation()
    } catch (error: unknown) {
      console.warn(`[context-governor] audit failed during ${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
