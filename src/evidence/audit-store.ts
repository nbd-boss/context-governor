import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AuditRead, SubStepAuditChange } from './audit-contract.ts'

export interface EpochAuditRecord {
  version: 1
  epoch: number
  session_id: string
  baseline_event: string
  resident_tokens: number
  reads: AuditRead[]
  switch?: {
    reason: string
    end_event: string
    state_changed: boolean
    sub_step_changes: SubStepAuditChange[]
    pressure?: { currentTokens: number; contextWindow: number; thresholdTokens: number }
  }
  completion?: {
    reason: string
    end_event: string
    state_changed: boolean
    sub_step_changes: SubStepAuditChange[]
    pressure?: { currentTokens: number; contextWindow: number; thresholdTokens: number }
  }
}

function sessionDirectory(root: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  return join(root, `session-${digest}`)
}

function epochFile(directory: string, epoch: number): string {
  return join(directory, `epoch-${String(epoch).padStart(4, '0')}.json`)
}

/** JSON-file persistence for audits. It neither reads raw History nor controls Epochs. */
export class AuditStore {
  constructor(private readonly root: string) {}

  async list(sessionId: string): Promise<EpochAuditRecord[]> {
    const directory = sessionDirectory(this.root, sessionId)
    try {
      const names = (await readdir(directory)).filter(name => /^epoch-\d{4}\.json$/.test(name)).sort()
      return await Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as EpochAuditRecord))
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') return []
      throw error
    }
  }

  async start(sessionId: string, baselineEvent: string, residentTokens: number): Promise<void> {
    const records = await this.list(sessionId)
    const last = records.at(-1)
    if (last !== undefined && (last.completion !== undefined || last.switch === undefined)) return
    const record: EpochAuditRecord = {
      version: 1,
      epoch: (last?.epoch ?? 0) + 1,
      session_id: sessionId,
      baseline_event: baselineEvent,
      resident_tokens: residentTokens,
      reads: [],
    }
    await this.write(sessionDirectory(this.root, sessionId), record)
  }

  async appendRead(sessionId: string, read: AuditRead): Promise<void> {
    const record = await this.open(sessionId)
    if (record === undefined) return
    record.reads.push(read)
    await this.write(sessionDirectory(this.root, sessionId), record)
  }

  async close(sessionId: string, reason: string, endEvent: string, stateChanged: boolean, subStepChanges: SubStepAuditChange[], pressure?: { currentTokens: number; contextWindow: number; thresholdTokens: number }): Promise<void> {
    const record = await this.open(sessionId)
    if (record === undefined) return
    record.switch = { reason, end_event: endEvent, state_changed: stateChanged, sub_step_changes: [...subStepChanges], ...(pressure === undefined ? {} : { pressure }) }
    await this.write(sessionDirectory(this.root, sessionId), record)
  }

  async complete(sessionId: string, reason: string, endEvent: string, stateChanged: boolean, subStepChanges: SubStepAuditChange[], pressure?: { currentTokens: number; contextWindow: number; thresholdTokens: number }): Promise<void> {
    const record = await this.open(sessionId)
    if (record === undefined) return
    record.completion = { reason, end_event: endEvent, state_changed: stateChanged, sub_step_changes: [...subStepChanges], ...(pressure === undefined ? {} : { pressure }) }
    await this.write(sessionDirectory(this.root, sessionId), record)
  }

  private async open(sessionId: string): Promise<EpochAuditRecord | undefined> {
    return (await this.list(sessionId)).findLast(record => record.switch === undefined && record.completion === undefined)
  }

  private async write(directory: string, record: EpochAuditRecord): Promise<void> {
    await mkdir(directory, { recursive: true })
    const path = epochFile(directory, record.epoch)
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }
}
