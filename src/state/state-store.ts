import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { createInitialState, validateContextState, type ContextState, type InitializeStateInput } from './state-contract.ts'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** The file authority for task-level State only. */
export class ContextStateStore {
  private state: ContextState | undefined
  private loaded = false

  constructor(private readonly stateFilePath: string) {}

  async read(): Promise<ContextState | undefined> {
    await this.ensureLoaded()
    return this.state === undefined ? undefined : clone(this.state)
  }

  /** Forget the in-process cache after a transaction installs this file. */
  invalidate(): void {
    this.loaded = false
    this.state = undefined
  }

  async initialize(input: InitializeStateInput): Promise<ContextState> {
    await this.ensureLoaded()
    if (this.state !== undefined) throw new Error('Context State already exists; start a new Session for a new task.')
    const state = createInitialState(input)
    await this.persist(state)
    return clone(state)
  }

  /** Install a validated State prepared by the boundary commit path. */
  async commit(value: ContextState): Promise<ContextState> {
    await this.ensureLoaded()
    const state = validateContextState(value)
    if (this.state !== undefined && state.revision <= this.state.revision) {
      throw new Error(`State revision must advance: current ${String(this.state.revision)}, received ${String(state.revision)}`)
    }
    await this.persist(state)
    return clone(state)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      this.state = validateContextState(JSON.parse(await readFile(this.stateFilePath, 'utf8')))
    } catch (error: unknown) {
      if (isMissingFile(error)) return
      throw error
    }
  }

  private async persist(state: ContextState): Promise<void> {
    await mkdir(dirname(this.stateFilePath), { recursive: true })
    const temporary = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, this.stateFilePath)
    this.state = clone(state)
  }
}

export { validateContextState } from './state-contract.ts'
export type { ContextState, InitializeStateInput } from './state-contract.ts'
