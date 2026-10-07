import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '../../../deepseek-harness/packages/llm/llm/src/index.ts'

import type { SubStepAuditChange } from '../evidence/audit-contract.ts'
import { BOOTSTRAP_REQUIRED_MESSAGE } from './bootstrap-gate.ts'
import type { SessionWorkspaceProvider } from '../workspace/session-workspace.ts'
import { buildResidentContext } from './resident-context.ts'
import { assessPressure, renderSwitchReminder } from './pressure-guard.ts'

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
  private readonly completed = new Set<string>()
  private readonly pending = new Map<string, PendingSwitch>()
  private readonly transitionRequired = new Set<string>()
  private ctx?: Context

  constructor(
    private readonly workspaces: SessionWorkspaceProvider,
    private readonly budget: number,
    private readonly switchThresholdRatio: number,
  ) {}

  install(ctx: Context): void {
    this.ctx = ctx
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      if (this.completed.has(agent.session.id)) return
      const pending = this.pending.get(agent.session.id)
      if (pending !== undefined && !pending.continuationQueued) {
        pending.continuationQueued = true
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'A new Context Epoch is now active. Continue the task from the Context Governor baseline.' }],
          source: { kind: 'plugin', plugin: 'context-governor' },
        }))
        return
      }
      if (!this.transitionRequired.has(agent.session.id)) return
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Context transition is still required. This Epoch remains in strict closing mode: do not start external work or read History, Artifacts, or workspace files. Only write results already visible in this Context, then register an Artifact or record completed progress when applicable. If unfinished work has a real working file, record_epoch_continuation; otherwise keep the current SubStep active. Then call switch_context. If the task is complete, use advance_task_progress with complete_task.' }],
        source: { kind: 'plugin', plugin: 'context-governor' },
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
      const resident = await buildResidentContext(workspace, sessionId)
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
      if (residentTokens > this.budget) {
        throw new Error(`Resident Context requires ${String(residentTokens)} tokens but residentTokenBudget is ${String(this.budget)}. Required State, navigation, current SubState, and rules were not truncated.`)
      }

      if (effectiveSwitch !== undefined) {
        this.pending.delete(sessionId)
        this.transitionRequired.delete(sessionId)
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
      if (this.started.has(sessionId)) {
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
          if (assessment.shouldRemind) {
            this.transitionRequired.add(sessionId)
            const text = renderSwitchReminder(assessment, pressure.contextWindow)
            console.log(`[context-governor] Context transition required: session=${sessionId} projectedTokens=${String(assessment.projectedTokens)} thresholdTokens=${String(assessment.thresholdTokens)}`)
            return {
              ...decision,
              messages: [
                this.governorMessage(text, 'context-governor-pressure'),
                ...decision.messages,
              ],
            }
          }
        }
        return decision
      }
      this.started.add(sessionId)
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
    agent: { session: { id: string; snapshotEvents(): readonly { seq: number }[] }; followup(message: ReturnType<typeof createUserMessage>): void },
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
      stateChanged: changes.stateChanged,
      subStepChanges: changes.subStepChanges,
      pressure,
    }))
  }

  async complete(
    agent: { session: { id: string; snapshotEvents(): readonly { seq: number }[] } },
    reason: string,
    changes: { stateChanged: boolean; subStepChanges: SubStepAuditChange[] },
  ): Promise<void> {
    const sessionId = agent.session.id
    const events = agent.session.snapshotEvents()
    await this.recordAudit('complete Context Epoch', () => this.workspaces.forSession(sessionId).audits.completeEpoch({
      sessionId,
      reason,
      endEvent: `event-${String(Math.max(-1, ...events.map(event => event.seq)))}`,
      stateChanged: changes.stateChanged,
      subStepChanges: changes.subStepChanges,
      pressure: this.pressure(agent.session),
    }))
    this.pending.delete(sessionId)
    this.transitionRequired.delete(sessionId)
    this.completed.add(sessionId)
  }

  /** True after the overflow safety line until a switch or terminal completion succeeds. */
  requiresTransition(sessionId: string): boolean {
    return this.transitionRequired.has(sessionId)
  }

  private pressure(session: { id: string }): { currentTokens: number; contextWindow: number; thresholdTokens: number } | undefined {
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
      source: { kind: 'plugin', plugin: 'context-governor', form: 'snapshot', sections: [{ name: sectionName, text }] },
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
