import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { parseStepId } from '../ids.ts'
import { validateSubState, type SubState } from './sub-state-contract.ts'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fileName(subState: Pick<SubState, 'sub_state_id'>): string {
  return `${subState.sub_state_id}.json`
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * File authority for one SubState per started Step. It neither reads State nor
 * renders Context, so relationship validation stays at the Workspace layer.
 */
export class SubStateStore {
  constructor(private readonly directory: string) {}

  async read(stepId: string): Promise<SubState | undefined> {
    const id = parseStepId(stepId)
    return (await this.readAll()).find(subState => subState.step_id === id)
  }

  async readAll(): Promise<SubState[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error: unknown) {
      if (isMissingFile(error)) return []
      throw error
    }
    return Promise.all(names
      .filter(name => /^sub-state-\d+\.json$/.test(name))
      .sort()
      .map(async name => validateSubState(JSON.parse(await readFile(join(this.directory, name), 'utf8')))))
  }

  /** Replace one existing SubState atomically after its caller validates the Workspace. */
  async commit(value: SubState): Promise<SubState> {
    const subState = validateSubState(value)
    const existing = await this.readAll()
    const prior = existing.find(item => item.sub_state_id === subState.sub_state_id)
    if (prior === undefined) throw new Error(`SubState does not exist: ${subState.sub_state_id}`)
    if (prior.step_id !== subState.step_id) throw new Error('SubState step_id is immutable')
    await this.persist(join(this.directory, fileName(subState)), subState)
    return clone(subState)
  }

  /** Install one validated SubState, creating it only for a new Step owner. */
  async save(value: SubState): Promise<SubState> {
    const subState = validateSubState(value)
    const existing = await this.readAll()
    const prior = existing.find(item => item.sub_state_id === subState.sub_state_id)
    if (prior !== undefined) return this.commit(subState)
    if (existing.some(item => item.step_id === subState.step_id)) {
      throw new Error(`SubState already exists for step_id: ${subState.step_id}`)
    }
    await this.writeNew(subState)
    return clone(subState)
  }

  private async writeNew(subState: SubState): Promise<void> {
    await this.persist(join(this.directory, fileName(subState)), subState)
  }

  private async persist(path: string, value: SubState): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }
}
